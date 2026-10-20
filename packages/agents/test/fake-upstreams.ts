import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { onTestFinished } from "vitest";
import type { PodForwarder } from "../src/tools-server/openobserve.ts";

export interface FakeReply {
  text: string;
  isError?: boolean;
  /** Sends the text this many times over, for a reply of a given size. */
  repeat?: number;
  /** Instead of answering, writes stderr and exits with this code, as a crashing server would. */
  exit?: { code: number; stderr?: string };
}

export interface FakeMcpConfig {
  /** The tool names the fake lists. */
  tools: readonly string[];
  /** Replies by tool name; any other call answers with its own name and arguments as JSON. */
  replies?: Record<string, FakeReply>;
}

/** One JSON-RPC exchange, the same for the stdio and HTTP fakes. */
function answer(
  message: { id?: unknown; method?: string; params?: Record<string, unknown> },
  config: FakeMcpConfig,
): unknown {
  if (message.id === undefined) return undefined;
  const reply = (result: unknown) => ({
    jsonrpc: "2.0",
    id: message.id,
    result,
  });
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "0.0.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: config.tools.map((name) => ({
          name,
          description: `Upstream text for ${name}; never shown to the model.`,
          inputSchema: { type: "object" },
        })),
      });
    case "tools/call": {
      const name = String(message.params?.name);
      const canned = config.replies?.[name];
      return reply({
        content: [
          {
            type: "text",
            text:
              canned?.text.repeat(canned.repeat ?? 1) ??
              JSON.stringify({
                tool: name,
                arguments: message.params?.arguments,
              }),
          },
        ],
        ...(canned?.isError ? { isError: true } : {}),
      });
    }
    default:
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "method not found" },
      };
  }
}

export interface StdioRecord {
  type: "start" | "call";
  pid: number;
  argv?: string[];
  env?: Record<string, string>;
  /** The file named by --config, as the child read it. */
  config?: string;
  /** The file named by --kubeconfig, as the child read it. */
  kubeconfig?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

/**
 * Writes a stand-in MCP server that speaks newline-delimited JSON-RPC on
 * stdio, as kubernetes-mcp-server and github-mcp-server do. It records its
 * command line, environment and the config and kubeconfig files it was
 * pointed at, then every tools/call, one JSON line each.
 */
export function writeFakeMcpServer(
  dir: string,
  config: FakeMcpConfig,
): { command: string; args: string[]; records(): StdioRecord[] } {
  const configPath = join(dir, "fake-mcp.json");
  const recordPath = join(dir, "fake-mcp.jsonl");
  const script = join(dir, "fake-mcp.cjs");
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(
    script,
    `const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const argv = process.argv.slice(3);
const record = (r) => fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ pid: process.pid, ...r }) + "\\n");
const read = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : fs.readFileSync(argv[i + 1], "utf8"); };
record({ type: "start", argv, env: process.env, config: read("--config"), kubeconfig: read("--kubeconfig") });
const answer = ${answer.toString()};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "tools/call") record({ type: "call", name: message.params.name, arguments: message.params.arguments });
    const exit = message.method === "tools/call" ? config.replies?.[message.params.name]?.exit : undefined;
    if (exit) { process.stderr.write(exit.stderr ?? ""); process.exit(exit.code); }
    const out = answer(message, config);
    if (out !== undefined) process.stdout.write(JSON.stringify(out) + "\\n");
  }
});
`,
  );
  chmodSync(script, 0o755);
  return {
    command: process.execPath,
    args: [script, configPath],
    records: () =>
      existsSync(recordPath)
        ? readFileSync(recordPath, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as StdioRecord)
        : [],
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  server.on("connection", (s) => onTestFinished(() => void s.destroy()));
  return (server.address() as AddressInfo).port;
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (c: Buffer) => (text += c.toString()));
    req.on("end", () => resolve(text));
  });
}

export interface OpenObserveRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
  authorization: string;
}

export interface FakeOpenObserve {
  port: number;
  requests: OpenObserveRequest[];
}

/** Answers like OpenObserve v0.91.3's read endpoints, with scan statistics and settings to be dropped. */
export function openobserveAnswer(req: OpenObserveRequest): unknown {
  if (req.path === "/healthz") return { status: "ok" };
  if (req.path === "/api/default/streams")
    return {
      list: [
        {
          name: "prod:apps:backend",
          storage_type: "s3",
          stream_type: "logs",
          stats: { doc_num: 12, storage_size: 3.5, file_num: 1 },
          schema: [],
          settings: { partition_keys: {} },
          total_fields: 9,
        },
      ],
      total: 1,
    };
  if (/^\/api\/default\/streams\/[^/]+\/schema$/.test(req.path))
    return {
      name: decodeURIComponent(req.path.split("/")[4]!),
      storage_type: "s3",
      stream_type: "logs",
      stats: { doc_num: 12 },
      schema: [
        { name: "_timestamp", type: "Int64" },
        { name: "message", type: "Utf8" },
      ],
      settings: { data_retention: 30 },
      total_fields: 2,
    };
  if (req.path === "/api/default/_search")
    return {
      took: 12,
      took_detail: { total: 12 },
      hits: [
        { level: "error", message: "boom" },
        { level: "error", message: "bang" },
      ],
      total: 2,
      from: 0,
      size: 100,
      cached_ratio: 0,
      scan_size: 99,
      idx_scan_size: 0,
      scan_records: 1000,
    };
  if (req.path === "/api/default/prometheus/api/v1/query_range")
    return { status: "success", data: { resultType: "matrix", result: [] } };
  if (/^\/api\/default\/[^/]+\/traces\/latest$/.test(req.path))
    return {
      took: 3,
      total: 1,
      from: 0,
      size: 20,
      hits: [
        {
          trace_id: "abc",
          spans: [3, 0],
          service_name: [{ service_name: "backend" }],
        },
      ],
    };
  return undefined;
}

/**
 * A stand-in for OpenObserve's REST API. It records every request; respond
 * can override an answer with a status and a raw body.
 */
export async function fakeOpenObserve(
  respond?: (
    req: OpenObserveRequest,
  ) => { status: number; body: string } | undefined,
): Promise<FakeOpenObserve> {
  const fake: FakeOpenObserve = { port: 0, requests: [] };
  const server = createHttpServer((req, res) => {
    void body(req).then((text) => {
      const url = new URL(String(req.url), "http://localhost");
      const request: OpenObserveRequest = {
        method: String(req.method),
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        ...(text === "" ? {} : { body: JSON.parse(text) as unknown }),
        authorization: String(req.headers.authorization),
      };
      fake.requests.push(request);
      const custom = respond?.(request);
      if (custom !== undefined)
        return void res
          .writeHead(custom.status, { "content-type": "application/json" })
          .end(custom.body);
      const answer = openobserveAnswer(request);
      if (answer === undefined)
        return void res.writeHead(404).end('{"code":404}');
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(answer));
    });
  });
  fake.port = await listen(server);
  return fake;
}

/**
 * A PodForwarder that "forwards" to a local port, standing in for the
 * Kubernetes API's port-forward. connect() fails for pods in stale, and
 * the returned object counts lookups and forwards.
 */
export function localForwarder(
  port: number,
  pods: string[] = ["openobserve-1"],
): PodForwarder & {
  lookups: number;
  forwards: string[];
  sockets: Socket[];
  stale: Set<string>;
  /** When set, every connect() rejects with it, as the Kubernetes API refusing the forward would. */
  refusal: unknown;
} {
  const state = {
    lookups: 0,
    forwards: [] as string[],
    sockets: [] as Socket[],
    stale: new Set<string>(),
    refusal: undefined as unknown,
    findPod() {
      const pod = pods[Math.min(state.lookups, pods.length - 1)]!;
      state.lookups += 1;
      return Promise.resolve(pod);
    },
    connect(pod: string, socket: Socket) {
      if (state.refusal !== undefined)
        return Promise.reject(state.refusal as Error);
      if (state.stale.has(pod))
        return Promise.reject(new Error(`pod ${pod} is gone`));
      return new Promise<() => void>((resolve, reject) => {
        const upstream = connect(port, "127.0.0.1");
        upstream.once("error", reject);
        upstream.once("connect", () => {
          state.forwards.push(pod);
          state.sockets.push(upstream);
          socket.pipe(upstream);
          upstream.pipe(socket);
          upstream.on("close", () => socket.destroy());
          resolve(() => upstream.destroy());
        });
      });
    },
  };
  return state;
}

export interface FakeGitHub {
  url: string;
  requests: {
    method: string;
    path: string;
    authorization: string;
    body: string;
  }[];
}

/** Workflow artifacts the fake GitHub API lists, and each one's zip by id. */
export interface FakeArtifacts {
  list: Record<string, unknown>[];
  zips: Record<number, Buffer>;
}

/**
 * A stand-in for the GitHub API's installation-token endpoints and, given
 * artifacts, its artifact list and downloads: a zip download answers with a
 * redirect to /blob/<id> on the same server, with a signature in the query.
 */
export async function fakeGitHubApi(
  options: {
    permissions?: Record<string, string>;
    token?: string;
    artifacts?: FakeArtifacts;
    /** Commit tarballs by "<repo>/<sha>", served through a redirect to /codeload/ on the same server. */
    tarballs?: Record<string, Buffer>;
    /** GraphQL answers by the field the query reads (history, blame), and recursive trees by "<repo>/<sha>". */
    graphql?: Record<string, unknown>;
    trees?: Record<string, unknown>;
  } = {},
): Promise<FakeGitHub> {
  const fake: FakeGitHub = { url: "", requests: [] };
  const server = createHttpServer((req, res) => {
    void body(req).then((text) => {
      fake.requests.push({
        method: String(req.method),
        path: String(req.url),
        authorization: String(req.headers.authorization),
        body: text,
      });
      const json = (status: number, value?: unknown) =>
        res
          .writeHead(status, { "content-type": "application/json" })
          .end(value === undefined ? undefined : JSON.stringify(value));
      if (
        req.method === "GET" &&
        req.url === "/orgs/notes-co/installation"
      )
        return json(200, { id: 42 });
      if (
        req.method === "POST" &&
        req.url === "/app/installations/42/access_tokens"
      ) {
        const asked = (JSON.parse(text) as { permissions?: unknown })
          .permissions;
        return json(201, {
          token: options.token ?? "ghs_faketoken000000000000000000000000000",
          expires_at: "2026-09-28T13:00:00Z",
          permissions: options.permissions ?? asked,
        });
      }
      if (req.method === "DELETE" && req.url === "/installation/token")
        return json(204);
      const artifacts = options.artifacts;
      const url = new URL(String(req.url), "http://fake");
      if (
        artifacts !== undefined &&
        url.pathname === "/repos/notes-co/agents/actions/artifacts"
      ) {
        const list = artifacts.list.filter(
          (a) => a.name === url.searchParams.get("name"),
        );
        return json(200, { total_count: list.length, artifacts: list });
      }
      const runArtifacts =
        /^\/repos\/notes-co\/agents\/actions\/runs\/(\d+)\/artifacts$/.exec(
          url.pathname,
        );
      if (artifacts !== undefined && runArtifacts !== null) {
        const list = artifacts.list.filter(
          (a) =>
            a.name === url.searchParams.get("name") &&
            (a.workflow_run as { id?: number } | undefined)?.id ===
              Number(runArtifacts[1]),
        );
        return json(200, { total_count: list.length, artifacts: list });
      }
      const zip =
        /^\/repos\/notes-co\/agents\/actions\/artifacts\/(\d+)\/zip$/.exec(
          url.pathname,
        );
      if (artifacts !== undefined && zip !== null)
        return res
          .writeHead(302, {
            location: `${fake.url}/blob/${zip[1]}?sv=2025&sig=fakeSignature123`,
          })
          .end();
      if (req.method === "POST" && url.pathname === "/graphql") {
        const query = String((JSON.parse(text) as { query?: unknown }).query);
        const field = Object.keys(options.graphql ?? {}).find((f) =>
          query.includes(`${f}(`),
        );
        if (field !== undefined)
          return json(200, { data: options.graphql![field] });
      }
      const tree =
        /^\/repos\/notes-co\/([^/]+)\/git\/trees\/([0-9a-f]{40})$/.exec(
          url.pathname,
        );
      const treeBody =
        tree === null ? undefined : options.trees?.[`${tree[1]}/${tree[2]}`];
      if (treeBody !== undefined) return json(200, treeBody);
      const tarball =
        /^\/repos\/notes-co\/([^/]+)\/tarball\/([0-9a-f]{40})$/.exec(
          url.pathname,
        );
      if (
        tarball !== null &&
        options.tarballs?.[`${tarball[1]}/${tarball[2]}`] !== undefined
      )
        return res
          .writeHead(302, {
            location: `${fake.url}/codeload/${tarball[1]}/${tarball[2]}?token=fakeCodeloadToken123`,
          })
          .end();
      const codeload = /^\/codeload\/([^/]+\/[0-9a-f]{40})$/.exec(url.pathname);
      const archive =
        codeload === null ? undefined : options.tarballs?.[codeload[1]!];
      if (archive !== undefined)
        return res
          .writeHead(200, { "content-type": "application/x-gzip" })
          .end(archive);
      const blob = /^\/blob\/(\d+)$/.exec(url.pathname);
      const bytes =
        blob === null ? undefined : artifacts?.zips[Number(blob[1])];
      if (bytes !== undefined)
        return res
          .writeHead(200, { "content-type": "application/zip" })
          .end(bytes);
      return json(404, { message: "Not Found" });
    });
  });
  fake.url = `http://127.0.0.1:${await listen(server)}`;
  return fake;
}

export interface FakeSlack {
  url: string;
  requests: {
    method: string;
    params: Record<string, string>;
    authorization: string;
  }[];
}

/** A stand-in for the Slack Web API; every method answers with the given messages. */
export async function fakeSlackApi(
  messages: Record<string, unknown>[] = [],
): Promise<FakeSlack> {
  const fake: FakeSlack = { url: "", requests: [] };
  const server = createHttpServer((req, res) => {
    void body(req).then((text) => {
      const params = Object.fromEntries(new URLSearchParams(text));
      fake.requests.push({
        method: String(req.url).replace(/^\/api\//, ""),
        params,
        authorization: String(req.headers.authorization),
      });
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, messages, has_more: false }));
    });
  });
  fake.url = `http://127.0.0.1:${await listen(server)}/api/`;
  return fake;
}

/** A zip archive of the given files, stored or deflated, as upload-artifact makes them. */
export function zipFiles(
  files: Record<string, string | Buffer>,
  method: 0 | 8 = 8,
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const packed = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
