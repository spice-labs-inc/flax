import { chmodSync, existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { firstLine } from "../lib/problem.ts";
import type { ModelUpstream } from "./model-api.ts";

/** The largest request body the forwarder takes, the same as the gateway's own limit. */
export const MAX_FORWARD_BYTES = 32 * 1024 * 1024;
/** How much of each request and reply the report keeps. */
export const RECORD_TEXT_BYTES = 64 * 1024;
export const MAX_RECORDS = 2000;
/** A model call may stream for minutes; the gateway itself gives up after ten. */
export const FORWARD_TIMEOUT_MS = 11 * 60 * 1000;
/** Connections the forwarder takes at once; Pi uses one or two. */
export const MAX_FORWARD_CONNECTIONS = 8;

/** The only paths the box may ask for: the messages API (the Anthropic SDK adds ?beta=true for beta calls) and the model catalog. */
const MESSAGES = /^\/v1\/messages(\?beta=true)?$/;
const CATALOG = "/v1/models/info";
/** The box's client polls usage every few seconds; it gets the same 404 but is counted apart, so real refusals stand out. */
const USAGE = /^\/v1\/usage(\?.*)?$/;
/** Request headers passed on; every other header the box sends, its own credentials included, is dropped. */
const PASSED_HEADERS = ["anthropic-version", "anthropic-beta", "accept"];

export interface ForwardRecord {
  at: string;
  method: string;
  path: string;
  outcome: "forwarded" | "refused" | "failed";
  reason?: string;
  requestBytes: number;
  /** The body as sent to the gateway, cut to RECORD_TEXT_BYTES. */
  request?: string;
  model?: { asked: unknown; sent: string };
  maxTokens?: { asked: unknown; sent: number };
  status?: number;
  replyBytes?: number;
  /** The reply as the box got it, cut to RECORD_TEXT_BYTES. */
  reply?: string;
  ms?: number;
}

export interface ForwarderOptions {
  /** Where to listen: a Unix socket in a directory outside the data directory. */
  socketPath: string;
  /** Where the calls go: the model gateway. */
  client: ModelUpstream;
  /** The key added to every model call: the run's own gateway key, which the box never holds. */
  key: string;
  /** The upstream's name for the run's model, forced into every call that names none of alsoModels. */
  model: string;
  /** Other models a call may name, by models.yml id or the upstream's name, each with the upstream's name; its key must allow them. */
  alsoModels?: readonly { id: string; name: string }[];
  /** The largest max_tokens a call may ask for. */
  maxTokens: number;
  now?: () => Date;
  timeoutMs?: number;
}

export interface ModelForwarder {
  readonly socketPath: string;
  readonly records: ForwardRecord[];
  /** How every call ended, those past MAX_RECORDS included. */
  readonly counts: {
    forwarded: number;
    refused: number;
    failed: number;
    /** GET /v1/usage polls, declined and not recorded. */
    polls: number;
  };
  stop(): Promise<void>;
}

function cut(text: string): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= RECORD_TEXT_BYTES) return text;
  return `${buffer.subarray(0, RECORD_TEXT_BYTES).toString("utf8")}\n[cut at ${RECORD_TEXT_BYTES} bytes of ${buffer.length}]`;
}

function readBody(req: IncomingMessage): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FORWARD_BYTES) {
        resolve("too-large");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendError(
  res: ServerResponse,
  status: number,
  type: string,
  message: string,
): string {
  const body = JSON.stringify({ type: "error", error: { type, message } });
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
  return body;
}

/**
 * The box's only way to the model: an HTTP server on a Unix socket in the
 * socket directory, run by the runner outside the box, which reaches it
 * through the model shim of the Pi plugin. It passes on only the messages
 * API for the run's model and the catalog entry of that model, forces the
 * model (unless the call names one of alsoModels) and caps max_tokens, adds the key (the box holds none), drops every
 * other header, takes at most MAX_FORWARD_CONNECTIONS connections at once,
 * and records each request and reply for the report.
 */
export async function startModelForwarder(
  options: ForwarderOptions,
): Promise<ModelForwarder> {
  if (existsSync(options.socketPath))
    throw new Error(`${options.socketPath} already exists`);
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? FORWARD_TIMEOUT_MS;
  const records: ForwardRecord[] = [];
  const counts = { forwarded: 0, refused: 0, failed: 0, polls: 0 };
  const also = options.alsoModels ?? [];
  const served = (asked: unknown): string =>
    also.find((m) => asked === m.id || asked === m.name)?.name ?? options.model;
  const keep = (record: ForwardRecord) => {
    counts[record.outcome] += 1;
    if (records.length < MAX_RECORDS) records.push(record);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    const record: ForwardRecord = {
      at: now().toISOString(),
      method: req.method ?? "",
      path: req.url ?? "",
      outcome: "refused",
      requestBytes: 0,
    };
    let poll = false;
    const refuse = (status: number, type: string, reason: string) => {
      record.reason = reason;
      record.status = status;
      record.reply = sendError(res, status, type, reason);
    };
    try {
      const body = await readBody(req);
      if (body === "too-large") {
        record.requestBytes = MAX_FORWARD_BYTES;
        return refuse(
          413,
          "request_too_large",
          `the request is over ${MAX_FORWARD_BYTES} bytes`,
        );
      }
      record.requestBytes = body.length;
      if (req.method === "GET" && USAGE.test(req.url ?? "")) {
        poll = true;
        counts.polls += 1;
        sendError(
          res,
          404,
          "not_found_error",
          `only POST /v1/messages and GET ${CATALOG} are served here`,
        );
        return;
      }
      if (req.method === "GET" && req.url === CATALOG)
        return await catalog(res, record);
      if (req.method !== "POST" || !MESSAGES.test(req.url ?? ""))
        return refuse(
          404,
          "not_found_error",
          `only POST /v1/messages and GET ${CATALOG} are served here`,
        );
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(body.toString("utf8"));
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        )
          throw new Error("not an object");
        message = parsed as Record<string, unknown>;
      } catch {
        return refuse(
          400,
          "invalid_request_error",
          "the request body is not a JSON object",
        );
      }
      const askedTokens = message.max_tokens;
      const sentTokens =
        typeof askedTokens === "number" &&
        Number.isInteger(askedTokens) &&
        askedTokens >= 1
          ? Math.min(askedTokens, options.maxTokens)
          : options.maxTokens;
      const sentModel = served(message.model);
      record.model = { asked: message.model, sent: sentModel };
      record.maxTokens = { asked: askedTokens, sent: sentTokens };
      const outgoing = Buffer.from(
        JSON.stringify({
          ...message,
          model: sentModel,
          max_tokens: sentTokens,
        }),
      );
      record.request = cut(outgoing.toString("utf8"));
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${options.key}`,
        "x-api-key": options.key,
      };
      for (const name of PASSED_HEADERS) {
        const value = req.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      await relay(res, record, "POST", req.url!, headers, outgoing);
    } catch (err) {
      record.outcome = "failed";
      record.reason = firstLine(err);
      if (!res.headersSent)
        record.reply = sendError(
          res,
          502,
          "api_error",
          `${options.client.label} could not be reached`,
        );
      else res.destroy();
    } finally {
      record.ms = Math.round(performance.now() - started);
      if (!poll) keep(record);
    }
  };

  // Streams the gateway's answer back as it comes, keeping the start of it for the report.
  const relay = async (
    res: ServerResponse,
    record: ForwardRecord,
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
  ) => {
    const upstream = await options.client.open(
      method,
      path,
      headers,
      body,
      timeoutMs,
    );
    record.outcome = "forwarded";
    record.status = upstream.statusCode ?? 0;
    const type = upstream.headers["content-type"];
    res.writeHead(record.status, {
      "content-type": typeof type === "string" ? type : "application/json",
    });
    const kept: Buffer[] = [];
    let keptBytes = 0;
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      upstream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (keptBytes < RECORD_TEXT_BYTES) {
          kept.push(chunk);
          keptBytes += chunk.length;
        }
        res.write(chunk);
      });
      upstream.on("end", () => resolve());
      upstream.on("error", reject);
    });
    res.end();
    record.replyBytes = total;
    const start = Buffer.concat(kept).subarray(0, RECORD_TEXT_BYTES);
    record.reply =
      total > RECORD_TEXT_BYTES
        ? `${start.toString("utf8")}\n[cut at ${RECORD_TEXT_BYTES} bytes of ${total}]`
        : start.toString("utf8");
  };

  // The catalog, without any key, narrowed to the models served here.
  const catalog = async (res: ServerResponse, record: ForwardRecord) => {
    const upstream = await options.client.open(
      "GET",
      CATALOG,
      { accept: "application/json" },
      undefined,
      timeoutMs,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of upstream) chunks.push(chunk as Buffer);
    record.outcome = "forwarded";
    record.status = upstream.statusCode ?? 0;
    let entries: Record<string, unknown> = {};
    try {
      const all = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      for (const name of [options.model, ...also.map((m) => m.name)])
        if (name in all) entries[name] = all[name];
    } catch {
      entries = {};
    }
    const body = JSON.stringify(entries);
    res.writeHead(record.status === 200 ? 200 : 502, {
      "content-type": "application/json",
    });
    res.end(body);
    record.replyBytes = body.length;
    record.reply = cut(body);
  };

  const server = createServer((req, res) => void handle(req, res));
  server.maxConnections = MAX_FORWARD_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => resolve());
  });
  chmodSync(options.socketPath, 0o600);
  return {
    socketPath: options.socketPath,
    records,
    counts,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
