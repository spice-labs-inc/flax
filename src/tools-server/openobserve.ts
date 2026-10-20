import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { UPSTREAM_OPERATIONS } from "../lib/tools.ts";
import { errorChain } from "./errors.ts";
import type { Upstream } from "./upstreams.ts";
import { workspace } from "../lib/workspace.ts";

export const OPENOBSERVE_OPERATIONS = UPSTREAM_OPERATIONS.openobserve!;

/** OpenObserve's organization; every call is forced to it. */
export function openobserveOrg(): string {
  return workspace().openobserve?.org ?? "default";
}

/** Where OpenObserve runs, in the shared-services cluster. */
export function openobservePod(): { cluster: string; namespace: string; labelSelector: string; port: number } {
  const o = workspace().openobserve;
  if (o === undefined) throw new Error("flax.yml agents.openobserve is not set, so no logs, metrics or traces tool can run");
  return { cluster: o.cluster, namespace: o.namespace, labelSelector: o.labelSelector, port: o.port };
}

/** Limits the upstream enforces whatever a tool asks for. */
export const OPENOBSERVE_LIMITS = {
  rangeHours: 24,
  searchRows: 100,
  traces: 50,
  stepSeconds: 60,
} as const;

/** The largest answer read from OpenObserve; the tool's own cap is far smaller. */
export const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

const HOUR_US = 3600 * 1_000_000;
const HOUR_MS = 3600 * 1000;

/** Why sql is not one SELECT statement, or undefined when it is. */
export function selectProblem(sql: string): string | undefined {
  if (sql.includes(";")) return "sql must be one statement, with no semicolon";
  if (!/^select\s/i.test(sql.trim())) return "sql must be a SELECT statement";
  return undefined;
}

interface RestCall {
  method: "GET" | "POST";
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(
  args: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(args))
    if (!required.includes(key) && !optional.includes(key))
      throw new Error(
        `"${key}" is not an argument OpenObserve calls take here`,
      );
  for (const key of required)
    if (args[key] === undefined) throw new Error(`"${key}" is required`);
}

function text(value: unknown, name: string, max = 16384): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error(`${name} must be a string of 1 to ${max} characters`);
  return value;
}

function int(value: unknown, name: string, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

/** The most field names a stream list may ask each stream about. */
export const MAX_ASKED_FIELDS = 10;

/** Field names to look for in each stream's schema: 1 to MAX_ASKED_FIELDS plain names. */
function askedFields(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ASKED_FIELDS ||
    !value.every(
      (f) => typeof f === "string" && /^[A-Za-z0-9_]{1,100}$/.test(f),
    )
  )
    throw new Error(
      `fields must be 1 to ${MAX_ASKED_FIELDS} field names of letters, digits and underscores`,
    );
  return value as string[];
}

/** A start and end in microseconds, at most rangeHours apart. */
function microRange(args: Record<string, unknown>): [number, number] {
  const start = int(args.start_time, "start_time", 0, Number.MAX_SAFE_INTEGER);
  const end = int(args.end_time, "end_time", 0, Number.MAX_SAFE_INTEGER);
  if (end <= start || end - start > OPENOBSERVE_LIMITS.rangeHours * HOUR_US)
    throw new Error(
      `the time range must be positive and at most ${OPENOBSERVE_LIMITS.rangeHours} hours`,
    );
  return [start, end];
}

function streamPath(name: unknown): string {
  const stream = text(name, "stream_name", 256);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_:.-]*$/.test(stream))
    throw new Error("stream_name has characters a stream name cannot have");
  return encodeURIComponent(stream);
}

/**
 * The one REST request for each operation. Only these six read requests
 * exist: the organization is always default, log operations always ask for
 * logs and the trace search for traces, search starts at row 0 with at most searchRows rows and no query
 * function, and every argument outside an operation's list is refused.
 */
export function restCall(
  operation: string,
  args: Record<string, unknown>,
): RestCall {
  const org = `/api/${openobserveOrg()}`;
  switch (operation) {
    case "StreamList":
      onlyKeys(args, [], ["keyword", "fields"]);
      if (args.fields !== undefined) askedFields(args.fields);
      return {
        method: "GET",
        path: `${org}/streams`,
        query: {
          type: "logs",
          ...(args.keyword === undefined
            ? {}
            : { keyword: text(args.keyword, "keyword", 100) }),
          ...(args.fields === undefined ? {} : { fetchSchema: "true" }),
        },
      };
    case "StreamSchema":
      onlyKeys(args, ["stream_name"]);
      return {
        method: "GET",
        path: `${org}/streams/${streamPath(args.stream_name)}/schema`,
        query: { type: "logs" },
      };
    case "SearchSQL":
    case "SearchTracesSQL": {
      onlyKeys(args, ["sql", "start_time", "end_time", "size"]);
      const sql = text(args.sql, "sql", 4000).trim();
      const problem = selectProblem(sql);
      if (problem !== undefined) throw new Error(problem);
      const [start_time, end_time] = microRange(args);
      return {
        method: "POST",
        path: `${org}/_search`,
        query: { type: operation === "SearchSQL" ? "logs" : "traces" },
        body: {
          query: {
            sql,
            start_time,
            end_time,
            from: 0,
            size: int(args.size, "size", 1, OPENOBSERVE_LIMITS.searchRows),
          },
        },
      };
    }
    case "PrometheusRangeQuery": {
      onlyKeys(args, ["query", "start", "end", "step"]);
      const start = Date.parse(text(args.start, "start", 40));
      const end = Date.parse(text(args.end, "end", 40));
      if (
        !(end > start) ||
        end - start > OPENOBSERVE_LIMITS.rangeHours * HOUR_MS
      )
        throw new Error(
          `the time range must be positive and at most ${OPENOBSERVE_LIMITS.rangeHours} hours`,
        );
      const step = int(
        Number(args.step),
        "step",
        OPENOBSERVE_LIMITS.stepSeconds,
        86400,
      );
      return {
        method: "GET",
        path: `${org}/prometheus/api/v1/query_range`,
        query: {
          query: text(args.query, "query", 2000),
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          step: String(step),
        },
      };
    }
    case "GetLatestTraces": {
      onlyKeys(
        args,
        ["stream_name", "start_time", "end_time", "size"],
        ["filter"],
      );
      const [start_time, end_time] = microRange(args);
      const filter =
        args.filter === undefined
          ? undefined
          : text(args.filter, "filter", 1000);
      if (filter?.includes(";"))
        throw new Error("filter may not contain a semicolon");
      return {
        method: "GET",
        path: `${org}/${streamPath(args.stream_name)}/traces/latest`,
        query: {
          start_time: String(start_time),
          end_time: String(end_time),
          from: "0",
          size: String(int(args.size, "size", 1, OPENOBSERVE_LIMITS.traces)),
          ...(filter === undefined ? {} : { filter }),
        },
      };
    }
    default:
      throw new Error(`"${operation}" is not an allowed operation`);
  }
}

function shapeError(operation: string): Error {
  return new Error(`OpenObserve answered ${operation} in an unknown shape`);
}

/**
 * What the model gets from each answer: the fields worth reading, not
 * OpenObserve's scan statistics and settings, and never more rows than
 * were asked for.
 */
export function summarize(
  operation: string,
  answer: unknown,
  args: Record<string, unknown>,
): unknown {
  if (!isObject(answer)) throw shapeError(operation);
  switch (operation) {
    case "StreamList": {
      if (!Array.isArray(answer.list)) throw shapeError(operation);
      const asked =
        args.fields === undefined ? undefined : askedFields(args.fields);
      return {
        total:
          typeof answer.total === "number" ? answer.total : answer.list.length,
        streams: answer.list.filter(isObject).map((s) => ({
          name: s.name,
          stream_type: s.stream_type,
          ...(isObject(s.stats)
            ? {
                doc_num: s.stats.doc_num,
                storage_size: s.stats.storage_size,
                ...(typeof s.stats.doc_time_max === "number"
                  ? { doc_time_max: s.stats.doc_time_max }
                  : {}),
              }
            : {}),
          // Only which of the asked fields the stream has, never its whole schema.
          ...(asked === undefined
            ? {}
            : {
                has_fields: Array.isArray(s.schema)
                  ? asked.filter((f) =>
                      (s.schema as unknown[]).some(
                        (field) => isObject(field) && field.name === f,
                      ),
                    )
                  : [],
              }),
        })),
      };
    }
    case "StreamSchema": {
      if (!Array.isArray(answer.schema)) throw shapeError(operation);
      return {
        name: answer.name,
        stream_type: answer.stream_type,
        fields: answer.schema
          .filter(isObject)
          .map((f) => ({ name: f.name, type: f.type })),
      };
    }
    case "SearchSQL":
    case "SearchTracesSQL":
    case "GetLatestTraces": {
      if (!Array.isArray(answer.hits)) throw shapeError(operation);
      return {
        total: answer.total,
        took_ms: answer.took,
        hits: answer.hits.slice(0, Number(args.size)),
      };
    }
    case "PrometheusRangeQuery": {
      if (typeof answer.status !== "string") throw shapeError(operation);
      return answer;
    }
    default:
      throw new Error(`"${operation}" is not an allowed operation`);
  }
}

async function readCapped(res: Response): Promise<string> {
  if (res.body === null) return "";
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    if (bytes > MAX_ANSWER_BYTES) {
      await res.body.cancel().catch(() => undefined);
      throw new Error(
        `OpenObserve's answer is larger than ${MAX_ANSWER_BYTES} bytes`,
      );
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface OpenObserveOptions {
  /** Where OpenObserve answers, such as the forwarded port on 127.0.0.1. */
  baseUrl: string;
  /** The HTTP Basic credential, base64 of email:password. */
  basicAuth: string;
  fetch?: typeof fetch;
  close?: () => Promise<void>;
  /** What went wrong last in the port-forward, to add to a request that failed. */
  diagnose?: () => string | undefined;
}

/**
 * OpenObserve, read through its REST API (the same endpoints its CLI and
 * UI use), with the service account's HTTP Basic login. It sends only the
 * requests restCall builds for the six read operations; no other path,
 * method or argument can be reached. A request that fails before an answer
 * (a forward that dropped under a kept-alive connection) is tried once
 * more; all six requests are reads.
 */
export class OpenObserveUpstream implements Upstream {
  private readonly options: OpenObserveOptions;

  constructor(options: OpenObserveOptions) {
    this.options = options;
  }

  async call(
    operation: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    if (!OPENOBSERVE_OPERATIONS.includes(operation))
      throw new Error(`"${operation}" is not an allowed operation`);
    const request = restCall(operation, args);
    const url = new URL(request.path, this.options.baseUrl);
    for (const [k, v] of Object.entries(request.query))
      url.searchParams.set(k, v);
    const init: RequestInit = {
      method: request.method,
      headers: {
        accept: "application/json",
        authorization: `Basic ${this.options.basicAuth}`,
        ...(request.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
      signal,
    };
    const res = await this.send(url, init, signal);
    const body = await readCapped(res);
    if (!res.ok)
      throw new Error(
        `OpenObserve answered ${res.status}: ${body.slice(0, 500).replace(/\s+/g, " ")}`,
      );
    let answer: unknown;
    try {
      answer = JSON.parse(body);
    } catch {
      throw new Error(
        `OpenObserve answered ${operation} with something that is not JSON`,
      );
    }
    return JSON.stringify(summarize(operation, answer, args));
  }

  /**
   * Checks that OpenObserve answers through the forward, with GET /healthz:
   * no credentials, no data. The run checks it at start, so a forward that
   * cannot open fails there, saying why.
   */
  async ready(
    signal: AbortSignal = AbortSignal.timeout(30_000),
  ): Promise<void> {
    const res = await this.send(
      new URL("/healthz", this.options.baseUrl),
      { method: "GET", signal },
      signal,
    );
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) throw new Error(`HTTP: /healthz answered ${res.status}`);
  }

  private async send(
    url: URL,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    const fetchFn = this.options.fetch ?? fetch;
    try {
      return await fetchFn(url, init);
    } catch (err) {
      if (signal.aborted) throw err;
    }
    try {
      return await fetchFn(url, init);
    } catch (err) {
      const forward = this.options.diagnose?.();
      throw new Error(
        `HTTP: ${errorChain(err)}${forward === undefined ? "" : `; port-forward: ${forward}`}`,
      );
    }
  }

  close(): Promise<void> {
    return this.options.close?.() ?? Promise.resolve();
  }
}

/** Reaches the OpenObserve pod through the Kubernetes API. */
export interface PodForwarder {
  /** The name of a running, ready OpenObserve pod. */
  findPod(): Promise<string>;
  /**
   * Joins a local socket to the pod's port. Resolves once the forward is
   * open, with a function that closes it; the forward closes the socket
   * when it drops, and reports why through report.
   */
  connect(
    pod: string,
    socket: Socket,
    report: (stage: ForwardStage, message: string) => void,
  ): Promise<() => void>;
}

/** Where a port-forward can fail, in the order a request meets them. */
export type ForwardStage =
  "pod lookup" | "forward open" | "forward ready" | "forward dropped";

/**
 * A port on 127.0.0.1 that forwards each connection to the OpenObserve pod,
 * in-process, without a kubectl child. Each connection opens its own
 * forward, so a forward that drops takes only its connection with it; when
 * a forward cannot be opened, the pod is looked up again (it may have been
 * replaced) and the forward tried once more.
 */
export class PortForward {
  private readonly forwarder: PodForwarder;
  private server: Server | undefined;
  private pod: string | undefined;
  private readonly open = new Set<{ socket: Socket; close?: () => void }>();
  private closed = false;
  /** Forwards opened over the run, including ones opened again after a drop. */
  forwards = 0;
  /** The latest problems, newest last, each naming its stage. */
  readonly problems: string[] = [];

  constructor(forwarder: PodForwarder) {
    this.forwarder = forwarder;
  }

  /** Starts listening and returns the local port. */
  async start(): Promise<number> {
    try {
      this.pod = await this.forwarder.findPod();
    } catch (err) {
      throw new Error(`pod lookup: ${errorChain(err)}`);
    }
    const server = createServer((socket) => void this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return (server.address() as AddressInfo).port;
  }

  private async accept(socket: Socket): Promise<void> {
    const entry: { socket: Socket; close?: () => void } = { socket };
    this.open.add(entry);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      entry.close?.();
      this.open.delete(entry);
    });
    socket.pause();
    try {
      entry.close = await this.forward(socket);
      if (this.closed || socket.destroyed) entry.close();
      else socket.resume();
    } catch {
      socket.destroy();
    }
  }

  /** The latest problem, such as "forward open: Unexpected server response: 403 (pod openobserve-1)". */
  lastProblem(): string | undefined {
    return this.problems.at(-1);
  }

  private note(stage: ForwardStage, message: string): void {
    this.problems.push(`${stage}: ${message}`);
    if (this.problems.length > 10) this.problems.shift();
  }

  private async openForward(pod: string, socket: Socket): Promise<() => void> {
    const report = (stage: ForwardStage, message: string) =>
      this.note(stage, `${message} (pod ${pod})`);
    try {
      const close = await this.forwarder.connect(pod, socket, report);
      this.forwards += 1;
      return close;
    } catch (err) {
      report("forward open", errorChain(err));
      throw err;
    }
  }

  private async lookup(): Promise<string> {
    try {
      return await this.forwarder.findPod();
    } catch (err) {
      this.note("pod lookup", errorChain(err));
      throw err;
    }
  }

  private async forward(socket: Socket): Promise<() => void> {
    if (this.closed) throw new Error("the port-forward is closed");
    try {
      this.pod ??= await this.lookup();
      return await this.openForward(this.pod, socket);
    } catch {
      this.pod = await this.lookup();
      return this.openForward(this.pod, socket);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const { socket, close } of this.open) {
      close?.();
      socket.destroy();
    }
    this.open.clear();
    const server = this.server;
    if (server !== undefined)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A PodForwarder that uses @kubernetes/client-node with the given kubeconfig text. */
export async function kubePodForwarder(
  kubeconfig: string,
): Promise<PodForwarder> {
  const k8s = await import("./kube-client.ts");
  const kc = new k8s.KubeConfig();
  kc.loadFromString(kubeconfig);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const forward = new k8s.PortForward(kc);
  const { namespace, labelSelector, port } = openobservePod();
  return {
    async findPod() {
      const pods = await core.listNamespacedPod({ namespace, labelSelector });
      const ready = pods.items.find(
        (p) =>
          p.status?.phase === "Running" &&
          p.metadata?.deletionTimestamp === undefined &&
          (p.status.conditions ?? []).some(
            (c) => c.type === "Ready" && c.status === "True",
          ),
      );
      const name = ready?.metadata?.name;
      if (name === undefined)
        throw new Error(
          `no ready pod matches ${labelSelector} in ${namespace}`,
        );
      return name;
    },
    async connect(pod, socket, report) {
      const ws = await forward.portForward(
        namespace,
        pod,
        [port],
        socket,
        null,
        socket,
      );
      const socketOf = typeof ws === "function" ? ws() : ws;
      let answered = false;
      let closing = false;
      socketOf?.on("message", () => (answered = true));
      socketOf?.on("close", (code: number, reason: Buffer) => {
        if (!closing && !answered)
          report(
            "forward ready",
            `the forward closed before the pod answered (code ${code}${reason.length > 0 ? ` ${reason.toString()}` : ""})`,
          );
        socket.destroy();
      });
      socketOf?.on("error", (err: unknown) => {
        report(answered ? "forward dropped" : "forward ready", errorChain(err));
        socket.destroy();
      });
      return () => {
        closing = true;
        socketOf?.close();
      };
    },
  };
}
