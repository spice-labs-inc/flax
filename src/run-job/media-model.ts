import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "../lib/allowlists.ts";
import { gatewayModelName } from "../lib/gateway.ts";
import type { MediaModel, MediaStage } from "../lib/job.ts";
import {
  MEDIA_MODEL_ENV,
  MEDIA_MODEL_FALLBACK_ENV,
  MEDIA_MODEL_SOCKET_ENV,
} from "../lib/media.ts";
import { firstLine } from "../lib/problem.ts";
import {
  blockRunKey,
  KEY_MARGIN_MINUTES,
  keySpendUsd,
  issueRunKey,
  SPEND_SETTLE_MS,
  type GatewayClient,
} from "./gateway.ts";
import {
  startModelForwarder,
  type ForwardRecord,
  type ModelForwarder,
} from "./forwarder.ts";
import type { GatewayRecord } from "./report.ts";
import { MAX_SOCKET_PATH_BYTES } from "./socket-dir.ts";

export const MEDIA_MODEL_SOCKET = "model.sock";
/** The socket directory's name is this plus six random characters. */
export const MEDIA_SOCKET_DIR_PREFIX = "agents-media-";
/** The largest max_tokens one media model call may ask for. */
export const MEDIA_MODEL_MAX_TOKENS = 32_768;
/** The report file that keeps each media model call. */
export const MEDIA_FORWARDER_FILE = "media-forwarder.json";

/** Minutes a media key lives: the media stage's own limit plus the run key's margin. */
export function mediaKeyMinutes(stage: Pick<MediaStage, "timeout_minutes">) {
  return stage.timeout_minutes + KEY_MARGIN_MINUTES;
}

/** The media key's run name: the run's own, so the key's alias counts toward the job's month. */
export function mediaKeyRunName(runName: string): string {
  return `${runName}-media`;
}

/** What the report says about the media stage's key: never the key, only its id. */
export interface MediaModelRecord extends GatewayRecord {
  model: string;
  /** media.model.fallback, which the same key allows. */
  fallback?: string;
}

/** A private directory for the media socket, in the first base whose socket path fits Linux's limit. */
export function createMediaSocketDir(bases: readonly string[]): string {
  const tried: string[] = [];
  for (const base of bases) {
    // mkdtemp adds six characters; the socket name and a slash follow.
    const longest = join(
      base,
      `${MEDIA_SOCKET_DIR_PREFIX}XXXXXX`,
      MEDIA_MODEL_SOCKET,
    );
    if (Buffer.byteLength(longest) > MAX_SOCKET_PATH_BYTES) {
      tried.push(`${base} (path too long)`);
      continue;
    }
    try {
      const dir = mkdtempSync(join(base, MEDIA_SOCKET_DIR_PREFIX));
      chmodSync(dir, 0o700);
      return dir;
    } catch (err) {
      tried.push(`${base} (${firstLine(err)})`);
    }
  }
  throw new Error(
    `no directory for the media model socket: ${tried.join(", ")}`,
  );
}

export interface OpenedMediaModel {
  /** What media.ts gets on top of its own environment: the socket and the models' ids, never the key. */
  env: Record<string, string>;
  /** The key, for the report's scrubber only. */
  key: string;
  record: MediaModelRecord;
  /** Stops the socket, blocks the key, reads its spend and removes the socket directory; returns each call for the report. */
  close(): Promise<ForwardRecord[]>;
}

/**
 * Issues one gateway key for the media stage, limited to its model and its
 * fallback model, if any, capped at usd_per_run for both together (the
 * gateway prices each call at the model that answered it) and expiring with
 * the stage, under the run's alias with
 * -media added so it counts toward the job's month, and serves the model on
 * a Unix socket through the same forwarder the box uses: it passes on only
 * the messages API, forces the model, caps max_tokens and adds the key, so
 * media.ts never holds a key. A call that names the fallback model, by its
 * models.yml id, goes to that model; every other call to the stage's model.
 */
export async function openMediaModel(options: {
  client: GatewayClient;
  model: Model;
  /** media.model.fallback's models.yml entry; none when not set or the same as model. */
  fallback?: Model;
  config: Pick<MediaModel, "usd_per_run">;
  stage: Pick<MediaStage, "timeout_minutes">;
  job: string;
  month: string;
  runName: string;
  socketBases: readonly string[];
  metadata?: Record<string, string>;
  settleMs?: number;
}): Promise<OpenedMediaModel> {
  const { client, model } = options;
  const fallback =
    options.fallback?.id === model.id ? undefined : options.fallback;
  const minutes = mediaKeyMinutes(options.stage);
  const record: MediaModelRecord = {
    url: client.url,
    model: model.id,
    ...(fallback === undefined ? {} : { fallback: fallback.id }),
    maxBudgetUsd: options.config.usd_per_run,
    minutes,
    blocked: false,
    problems: [],
  };
  const key = await issueRunKey(client, {
    job: options.job,
    model,
    ...(fallback === undefined ? {} : { alsoModels: [fallback] }),
    month: options.month,
    runName: mediaKeyRunName(options.runName),
    maxBudgetUsd: options.config.usd_per_run,
    minutes,
    metadata: { stage: "media", ...options.metadata },
  });
  record.keyAlias = key.alias;
  record.keyId = key.id;
  if (key.expires !== undefined) record.expires = key.expires;

  let dir: string | undefined;
  let forwarder: ModelForwarder | undefined;
  const block = async () => {
    try {
      await blockRunKey(client, key.key);
      record.blocked = true;
    } catch (err) {
      record.problems.push(`blocking the key failed: ${firstLine(err)}`);
    }
  };
  try {
    dir = createMediaSocketDir(options.socketBases);
    forwarder = await startModelForwarder({
      socketPath: join(dir, MEDIA_MODEL_SOCKET),
      client,
      key: key.key,
      model: gatewayModelName(model),
      ...(fallback === undefined
        ? {}
        : {
            alsoModels: [{ id: fallback.id, name: gatewayModelName(fallback) }],
          }),
      maxTokens: MEDIA_MODEL_MAX_TOKENS,
    });
  } catch (err) {
    await block();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const opened = forwarder;
  const socketDir = dir;
  let closed: Promise<ForwardRecord[]> | undefined;
  return {
    env: {
      [MEDIA_MODEL_SOCKET_ENV]: opened.socketPath,
      [MEDIA_MODEL_ENV]: model.id,
      ...(fallback === undefined
        ? {}
        : { [MEDIA_MODEL_FALLBACK_ENV]: fallback.id }),
    },
    key: key.key,
    record,
    close: () =>
      (closed ??= (async () => {
        await opened.stop().catch((err: unknown) => {
          record.problems.push(
            `stopping the media model socket failed: ${firstLine(err)}`,
          );
        });
        record.forwarder = { ...opened.counts };
        rmSync(socketDir, { recursive: true, force: true });
        await block();
        await new Promise((r) =>
          setTimeout(r, options.settleMs ?? SPEND_SETTLE_MS),
        );
        try {
          const spent = await keySpendUsd(client, key.id);
          if (spent !== undefined) record.spendUsd = spent;
        } catch (err) {
          record.problems.push(
            `reading the key's spend failed: ${firstLine(err)}`,
          );
        }
        return opened.records;
      })()),
  };
}
