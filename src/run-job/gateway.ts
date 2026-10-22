import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { request, type RequestOptions } from "node:https";
import type { Model } from "../lib/allowlists.ts";
import { GATEWAY_FILE } from "../lib/paths.ts";
import {
  GATEWAY_ISSUER_KEY_ENV,
  gatewayModelName,
  MODEL_API_KEY_ENV,
  type Gateway,
} from "../lib/gateway.ts";
import type { KeyMode } from "../lib/workspace.ts";
import {
  reviewSeconds,
  type JobConfig,
  type ModelJobConfig,
} from "../lib/job.ts";
import { runTimeoutSeconds } from "./argv.ts";
import type { Ledger, SharedSpend } from "./budget.ts";
import type { ModelUpstream } from "./model-api.ts";

/** How long past the box's own timeout a run key stays valid, for starting and stopping the box. */
export const KEY_MARGIN_MINUTES = 10;
/** Parallel calls and calls per minute one run key may make; Pi makes one call at a time. */
export const KEY_MAX_PARALLEL = 2;
export const KEY_RPM = 60;
/** LiteLLM writes spend to its database in batches every 10 seconds. */
export const SPEND_SETTLE_MS = 12_000;
export const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_TEXT = 300;

/** Minutes a run key lives: the box's timeout, the second check's for a pull request job, plus a margin. */
export function keyMinutes(
  job: Pick<ModelJobConfig, "limits"> & Partial<Pick<JobConfig, "output">>,
): number {
  return (
    Math.ceil((runTimeoutSeconds(job.limits.turns) + reviewSeconds(job)) / 60) +
    KEY_MARGIN_MINUTES
  );
}

/** The alias every run key carries; the ledger sums a job's month by its prefix. */
export function keyAliasPrefix(team: string, job: string, month: string) {
  return `${team}/${job}/${month}/`;
}

/** The id LiteLLM keeps a key under: the sha256 of the key, never the key itself. */
export function keyId(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

const TLS_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export interface GatewayClientOptions {
  gateway: Gateway;
  /** The pinned CA root: the only certificate authority trusted for the gateway; none trusts the system roots. */
  ca?: string;
  /** litellm: the team's issuer key. static: the provider key itself. */
  issuerKey: string;
  /** Tests point this at a fake gateway; its certificate must still be issued for server_name. */
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * The runner's side of the model gateway, over HTTPS pinned to the
 * gateway's own CA (or the system roots for a static provider) and checked
 * against its server name. Only the runner process talks to it. Every error
 * names the gateway and the cause, never a key. In static mode the client
 * issues no keys: the one key it holds is the run's key, blocking it does
 * nothing, and nothing reports spend.
 */
export class GatewayClient implements ModelUpstream {
  readonly label: string;
  readonly url: string;
  readonly gateway: Gateway;
  readonly mode: KeyMode;
  private readonly ca: string | undefined;
  private readonly issuerKey: string;
  private readonly timeoutMs: number;

  constructor(options: GatewayClientOptions) {
    this.gateway = options.gateway;
    this.mode = options.gateway.mode ?? "litellm";
    this.label = this.mode === "static" ? "the model provider" : "the model gateway";
    this.url = options.baseUrl ?? options.gateway.url;
    this.ca = options.ca;
    this.issuerKey = options.issuerKey;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private describe(): string {
    return `${this.label} at ${this.url}`;
  }

  /** The static provider's key as the run's key, with an alias like an issued one has. */
  staticRunKey(alias: string): RunKey {
    return { key: this.issuerKey, id: keyId(this.issuerKey), alias };
  }

  private scrub(text: string): string {
    return this.issuerKey.length >= 4
      ? text.split(this.issuerKey).join("[redacted]")
      : text;
  }

  private tls(): Pick<RequestOptions, "ca" | "servername"> {
    return {
      ...(this.ca === undefined ? {} : { ca: this.ca }),
      servername: this.gateway.server_name,
    };
  }

  /**
   * A request with exactly the headers given (no issuer key), answered as a
   * stream: what the forwarder sends on the box's behalf with the run's key.
   */
  open(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    timeoutMs: number,
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = request(
        new URL(path, this.url),
        {
          method,
          ...this.tls(),
          timeout: timeoutMs,
          headers: {
            ...headers,
            ...(body === undefined ? {} : { "content-length": body.length }),
          },
        },
        resolve,
      );
      req.on("timeout", () =>
        req.destroy(
          new GatewayError(
            `${this.describe()} did not answer ${path} within ${Math.round(timeoutMs / 1000)} s`,
          ),
        ),
      );
      req.on("error", (err) => reject(this.failure(err, path)));
      req.end(body);
    });
  }

  /** One JSON request; resolves with the parsed answer of a 2xx, rejects with a GatewayError otherwise. */
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, this.url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method,
          ...this.tls(),
          timeout: this.timeoutMs,
          headers: {
            authorization: `Bearer ${this.issuerKey}`,
            accept: "application/json",
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy(
                new GatewayError(
                  `${this.describe()} sent more than ${MAX_RESPONSE_BYTES} bytes for ${path}`,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", (err) => reject(this.failure(err, path)));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(this.httpFailure(status, path, text));
              return;
            }
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(
                new GatewayError(
                  `${this.describe()} answered ${path} with something other than JSON`,
                ),
              );
            }
          });
        },
      );
      req.on("timeout", () =>
        req.destroy(
          new GatewayError(
            `${this.describe()} is unreachable (no answer to ${path} within ${Math.round(this.timeoutMs / 1000)} s)`,
          ),
        ),
      );
      req.on("error", (err) => reject(this.failure(err, path)));
      req.end(payload);
    });
  }

  failure(err: Error, path: string): GatewayError {
    if (err instanceof GatewayError) return err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && TLS_CODES.has(code))
      return new GatewayError(
        `${this.describe()} presented a certificate the pinned CA root does not vouch for as ${this.gateway.server_name} (${code}); check ${GATEWAY_FILE} and ${this.gateway.ca}`,
      );
    return new GatewayError(
      `${this.describe()} is unreachable (${code ?? this.scrub(err.message)}) calling ${path}`,
    );
  }

  private httpFailure(status: number, path: string, text: string) {
    if (status === 401 || status === 403)
      return new GatewayError(
        `${this.describe()} refused ${this.mode === "static" ? MODEL_API_KEY_ENV : GATEWAY_ISSUER_KEY_ENV} for ${path} (HTTP ${status}); check the secret`,
      );
    let detail = "";
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: unknown } | string;
        detail?: unknown;
      };
      const message =
        typeof parsed.error === "object"
          ? parsed.error.message
          : (parsed.error ?? parsed.detail);
      detail =
        typeof message === "string" ? message : JSON.stringify(message ?? "");
    } catch {
      detail = text;
    }
    detail = this.scrub(detail.split("\n")[0] ?? "").slice(0, MAX_ERROR_TEXT);
    return new GatewayError(
      `${this.describe()} answered HTTP ${status} to ${path}${detail === "" ? "" : `: ${detail}`}`,
    );
  }
}

export interface IssueRequest {
  job: string;
  model: Model;
  /** Other models the key may call, such as the second check's review_model. */
  alsoModels?: Model[];
  month: string;
  runName: string;
  maxBudgetUsd: number;
  minutes: number;
  /** Extra facts for the key's metadata, such as the Actions run id. */
  metadata?: Record<string, string>;
}

export interface RunKey {
  /** The key itself: handed to the box by name, never written anywhere. */
  key: string;
  /** LiteLLM's id for it (the key's sha256), safe for reports. */
  id: string;
  alias: string;
  expires?: string;
}

/** The exact body of the key request: one model, the run's worst case, expiring with the run. */
export function issueBody(team: string, req: IssueRequest): object {
  return {
    team_id: team,
    key_alias: `${keyAliasPrefix(team, req.job, req.month)}${req.runName}`,
    models: [req.model, ...(req.alsoModels ?? [])].map(gatewayModelName),
    max_budget: req.maxBudgetUsd,
    duration: `${req.minutes}m`,
    max_parallel_requests: KEY_MAX_PARALLEL,
    rpm_limit: KEY_RPM,
    key_type: "llm_api",
    metadata: {
      job: req.job,
      run: req.runName,
      month: req.month,
      model: req.model.id,
      ...req.metadata,
    },
  };
}

export async function issueRunKey(
  client: GatewayClient,
  req: IssueRequest,
): Promise<RunKey> {
  const body = issueBody(client.gateway.team, req) as { key_alias: string };
  // A static provider issues nothing: the key the runner holds is the run's key.
  if (client.mode === "static") return client.staticRunKey(body.key_alias);
  const answer = (await client.call("POST", "/key/generate", body)) as {
    key?: unknown;
    token?: unknown;
    expires?: unknown;
  };
  if (typeof answer.key !== "string" || answer.key.length < 8)
    throw new GatewayError(
      `the model gateway at ${client.url} issued no key for ${body.key_alias}`,
    );
  return {
    key: answer.key,
    id: typeof answer.token === "string" ? answer.token : keyId(answer.key),
    alias: body.key_alias,
    ...(typeof answer.expires === "string" ? { expires: answer.expires } : {}),
  };
}

/** Blocks a run key; blocking keeps its row and spend, which the ledger reads. */
export async function blockRunKey(
  client: GatewayClient,
  key: string,
): Promise<void> {
  if (client.mode === "static") return;
  await client.call("POST", "/key/update", { key, blocked: true });
}

/** What a key has spent so far, looked up by its id; undefined for a static provider, which reports none. */
export async function keySpendUsd(
  client: GatewayClient,
  id: string,
): Promise<number | undefined> {
  if (client.mode === "static") return undefined;
  const answer = (await client.call(
    "GET",
    `/key/info?key=${encodeURIComponent(id)}`,
  )) as { info?: { spend?: unknown } };
  const spend = answer.info?.spend;
  if (typeof spend !== "number" || !Number.isFinite(spend))
    throw new GatewayError(
      `the model gateway at ${client.url} did not say what key ${id.slice(0, 12)} spent`,
    );
  return spend;
}

interface TeamInfo {
  team_info?: { spend?: unknown; max_budget?: unknown };
  keys?: unknown;
}

/**
 * Month-to-date spend from the gateway itself. The issuer key may not list
 * keys (/key/list), but /team/info returns the team's spend and budget and
 * every key of the team with its alias and spend. A job's month is the sum
 * over keys whose alias starts with <team>/<job>/<YYYY-MM>/; blocked and
 * expired keys keep their spend, so every run of the month counts.
 */
export function gatewayLedger(client: GatewayClient): Ledger {
  // A static provider keeps no ledger the runner can read: every month reads as zero, and only the per-run worst case holds.
  if (client.mode === "static")
    return {
      durable: false,
      spentUsd: () => Promise.resolve(0),
      record: () => Promise.resolve(),
    };
  let cached: Promise<TeamInfo> | undefined;
  const team = client.gateway.team;
  const info = () =>
    (cached ??= client.call(
      "GET",
      `/team/info?team_id=${encodeURIComponent(team)}`,
    ) as Promise<TeamInfo>);
  return {
    durable: true,
    async spentUsd(job, month) {
      const answer = await info();
      if (!Array.isArray(answer.keys))
        throw new GatewayError(
          `the model gateway at ${client.url} did not list team ${team}'s keys, so ${job}'s spend in ${month} is unknown`,
        );
      const prefix = keyAliasPrefix(team, job, month);
      let sum = 0;
      for (const k of answer.keys as {
        key_alias?: unknown;
        spend?: unknown;
      }[]) {
        if (
          typeof k?.key_alias === "string" &&
          k.key_alias.startsWith(prefix) &&
          typeof k.spend === "number" &&
          Number.isFinite(k.spend)
        )
          sum += k.spend;
      }
      return sum;
    },
    async sharedSpend(): Promise<SharedSpend> {
      const answer = await info();
      const spend = answer.team_info?.spend;
      const limit = answer.team_info?.max_budget;
      return {
        who: `all jobs (gateway team ${team})`,
        spentUsd: typeof spend === "number" ? spend : 0,
        ...(typeof limit === "number" ? { limitUsd: limit } : {}),
      };
    },
    // The gateway records spend itself.
    record: () => Promise.resolve(),
  };
}
