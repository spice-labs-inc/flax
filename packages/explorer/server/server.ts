import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Envelope } from "@cucumber/messages";
import { isRecord, type PlannedScenario, type RunResult } from "@flax/contract";
import { bearerMatches } from "./auth.ts";
import { serveStatic } from "./static.ts";
import type { Hub } from "./hub.ts";
import { isScenarioId, runIdEnv } from "./ids.ts";
import type { Log } from "./log.ts";
import {
  InvalidStart,
  parseFinish,
  parseStart,
  type LiveEvent,
  type LiveRun,
  type LiveRuns,
  type RunMeta,
} from "./runs.ts";

export const MAX_BODY = 2 * 1024 * 1024;

export interface Finished {
  run: RunResult;
  planned: PlannedScenario[];
  incomplete: boolean;
}

export interface ServerDeps {
  /** Directories to serve files from when no proxy does: the data directory and, when the page is built, its site directory. */
  static?: { data: string; site?: string | undefined } | undefined;
  /** The runner's bearer token; without one every ingest call is refused. */
  token: string | undefined;
  runs: LiveRuns;
  hub: Hub;
  log: Log;
  /** Writes the finished run into the results and rebuilds the data; the response does not wait for it. */
  onFinish: (run: LiveRun, finished: Finished) => void;
  now?: () => number;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY) {
      reject(new HttpError(413, "the body is over 2 MB"));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "the body is over 2 MB"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "the body is not JSON");
  }
}

function ndjson(body: Buffer): Envelope[] {
  const out: Envelope[] = [];
  for (const line of body.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      throw new HttpError(400, "a line of the body is not JSON");
    }
    if (!isRecord(v))
      throw new HttpError(400, "a line of the body is not an envelope");
    // Cucumber's own messages from the runner; #apply in runs.ts tolerates any that are not.
    out.push(v as Envelope);
  }
  return out;
}

/** The run's start from its id alone, for messages whose start call never arrived. */
function metaFromId(runId: string): RunMeta | undefined {
  const env = runIdEnv(runId);
  const m = /^\w+-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(
    runId,
  );
  if (!env || !m) return undefined;
  return {
    env,
    runId,
    startedAt: `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`,
    workers: 1,
    planned: 0,
  };
}

const send = (res: ServerResponse, status: number, body?: unknown) => {
  if (body === undefined) res.writeHead(status).end();
  else
    res
      .writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      .end(JSON.stringify(body));
};

export function snapshot(
  runs: LiveRuns,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const byEnv = runs.byEnv();
  const scenarios: Record<string, unknown[]> = {};
  for (const list of Object.values(byEnv)) {
    const newest = list[0];
    const run = newest && runs.get(newest.runId);
    if (run) scenarios[run.meta.runId] = [...run.scenarios.values()];
  }
  return { ...extra, runs: byEnv, scenarios };
}

export function explorerServer(
  deps: ServerDeps & { snapshotExtra: () => Record<string, unknown> },
): Server {
  const now = deps.now ?? Date.now;
  const emit = (events: LiveEvent[]) => {
    for (const e of events) deps.hub.send(e.event, e.data);
  };

  async function ingest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const m = /^\/ingest\/runs\/([^/]+)\/(start|messages|finish)$/.exec(
      url.pathname,
    );
    if (!m) throw new HttpError(404, "no such ingest call");
    if (req.method !== "POST") throw new HttpError(405, "POST only");
    if (!deps.token || !bearerMatches(req.headers.authorization, deps.token)) {
      req.resume();
      throw new HttpError(401, "no valid ingest token");
    }
    const runId = decodeURIComponent(m[1]!);
    if (!runIdEnv(runId)) throw new HttpError(400, "not a run id");
    const body = await readBody(req);
    const t = now();

    if (m[2] === "start") {
      const meta = parseStart(runId, json(body));
      const { run, created } = deps.runs.open(meta, t);
      if (!created) {
        run.meta = meta;
        deps.runs.save(run);
      }
      deps.hub.send("run-started", run.summary());
      return send(res, 204);
    }

    if (m[2] === "messages") {
      const first = url.searchParams.get("first") ?? "";
      if (!/^\d{1,9}$/.test(first))
        throw new HttpError(400, "first is not a sequence number");
      const envelopes = ndjson(body);
      const meta = metaFromId(runId);
      if (!meta) throw new HttpError(400, "not a run id");
      const { run, created } = deps.runs.open(meta, t);
      if (created) deps.hub.send("run-started", run.summary());
      emit(run.ingest(Number(first), envelopes, t));
      if (url.searchParams.get("gap") === "1" && !run.gap) {
        run.gap = true;
        deps.runs.save(run);
        deps.hub.send("run-incomplete", {
          env: run.meta.env,
          runId,
          reason: "gap",
        });
      }
      return send(res, 204);
    }

    const finished = parseFinish(runId, json(body));
    const run =
      deps.runs.get(runId) ?? deps.runs.open(metaFromId(runId)!, t).run;
    if (run.state === "finished") return send(res, 204);
    run.state = "finished";
    run.finishedAt = Date.parse(finished.run.finishedAt) || t;
    if (finished.incomplete) run.gap = true;
    deps.runs.save(run);
    deps.hub.send("run-finished", run.summary());
    deps.onFinish(run, finished);
    return send(res, 204);
  }

  function live(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (req.method !== "GET") throw new HttpError(405, "GET only");
    if (url.pathname === "/live/events") return deps.hub.connect(req, res);
    if (url.pathname === "/live/state")
      return send(res, 200, snapshot(deps.runs, deps.snapshotExtra()));
    const m = /^\/live\/runs\/([^/]+)\/scenarios\/(.+)$/.exec(url.pathname);
    if (m) {
      const run = deps.runs.get(decodeURIComponent(m[1]!));
      const id = decodeURIComponent(m[2]!);
      const detail = run && isScenarioId(id) ? run.detail(id) : undefined;
      if (!detail) throw new HttpError(404, "no such live scenario");
      return send(res, 200, detail);
    }
    throw new HttpError(404, "no such live path");
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://explorer");
    const handle = async () => {
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (url.pathname.startsWith("/ingest/")) return ingest(req, res, url);
      if (url.pathname.startsWith("/live/")) return live(req, res, url);
      if (deps.static && serveStatic(deps.static, req, res, url.pathname))
        return;
      throw new HttpError(404, "not found");
    };
    handle().catch((e: unknown) => {
      const status =
        e instanceof HttpError
          ? e.status
          : e instanceof InvalidStart
            ? 400
            : 500;
      const message = e instanceof Error ? e.message : "failed";
      if (status === 500)
        deps.log("error", `${req.method} ${url.pathname}: ${message}`);
      else if (url.pathname.startsWith("/ingest/"))
        deps.log(
          "warn",
          `${req.method} ${url.pathname} refused ${status}: ${message}`,
        );
      if (!res.headersSent) send(res, status, { error: message });
      else res.end();
    });
  });
}
