import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  connectTools,
  type PiTool,
} from "../images/agent/pi-mcp-mailbox/src/extension.ts";
import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
} from "../images/agent/pi-mcp-mailbox/src/protocol.ts";
import { SocketClientTransport } from "../images/agent/pi-mcp-mailbox/src/socket-client.ts";
import { LineReader } from "../images/agent/pi-mcp-mailbox/src/sockets.ts";
import type { JobConfig } from "../src/lib/job.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { startToolsServer } from "../src/tools-server/start.ts";
import { builtinUpstream } from "../src/tools-server/upstreams.ts";
import { jobConfig } from "./helpers.ts";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-ts-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function serve(calls = 200) {
  const dir = scratch();
  const socketPath = join(dir, "tools.sock");
  const tools = await startToolsServer({
    root: FIXTURE_WORKSPACE,
    dataDir: dir,
    socketPath,
    job: jobConfig("demo", {
      tools: ["echo"],
      limits: {
        turns: 10,
        tokens_per_run: 1000,
        usd_per_month: 5,
        tool_calls: calls,
      },
    }) as unknown as JobConfig,
    upstreams: { builtin: builtinUpstream },
  });
  onTestFinished(() => tools.stop());
  return { dir, socketPath, tools };
}

/** A raw client that speaks lines to the tools socket and collects what comes back. */
function raw(socketPath: string) {
  const socket = connect(socketPath);
  const lines: unknown[] = [];
  let buffer = "";
  let closed = false;
  socket.on("data", (c: Buffer) => {
    buffer += c.toString("utf8");
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
    }
  });
  socket.on("error", () => undefined);
  socket.on("close", () => (closed = true));
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(cond()).toBe(true);
  };
  return {
    socket,
    lines,
    isClosed: () => closed,
    until,
    send: (m: unknown) => socket.write(`${JSON.stringify(m)}\n`),
    connected: () =>
      new Promise<void>((resolve) => socket.once("connect", () => resolve())),
  };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "0" },
  },
};

describe("line framing", () => {
  it("splits messages across chunks and refuses one over the limit before buffering it whole", () => {
    const reader = new LineReader(10);
    expect(reader.push(Buffer.from('{"a":1}\n{"b"'))).toEqual({
      lines: ['{"a":1}'],
    });
    expect(reader.push(Buffer.from(":2}\n"))).toEqual({ lines: ['{"b":2}'] });
    expect(reader.push(Buffer.from("0123456789\n"))).toEqual({
      lines: ["0123456789"],
    });
    expect(reader.push(Buffer.from("012345"))).toEqual({ lines: [] });
    expect(reader.push(Buffer.from("67890"))).toEqual({
      error: "a message of more than 10 bytes (11 so far) is over the limit",
    });
  });
});

describe("the tools server over a socket", () => {
  it("serves Pi's plugin the job's tools, creating no mailbox, and records every message", async () => {
    const { dir, socketPath, tools } = await serve();
    expect(readdirSync(dir)).toEqual(["tools.sock"]);
    const registered: PiTool[] = [];
    const shutdown: (() => unknown)[] = [];
    const names = await connectTools(
      {
        registerTool: (tool) => registered.push(tool),
        on: (_event, handler) => shutdown.push(handler),
      },
      { socket: socketPath },
    );
    expect(names).toEqual(["echo"]);
    const result = await registered[0]!.execute(
      "1",
      { text: "over the socket" },
      undefined,
    );
    expect(result.content[0]!.text).toContain("\nover the socket\n");
    for (const handler of shutdown) await handler();
    expect(tools.server.calls).toMatchObject([{ tool: "echo", outcome: "ok" }]);
    expect(tools.socket!.in.map((l) => JSON.parse(l).method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(tools.socket!.out).toHaveLength(3);
    expect(tools.report().socket).toEqual([]);
    expect(existsSync(join(dir, "mcp"))).toBe(false);
  });

  it("refuses what the mailbox refuses: not JSON, a repeated id, a response, a method it does not offer", async () => {
    const { socketPath, tools } = await serve();
    const c = raw(socketPath);
    await c.connected();
    c.send(INIT);
    await c.until(() => c.lines.length === 1);
    c.socket.write("not json\n");
    c.send({ ...INIT, id: 1 });
    c.send({ jsonrpc: "2.0", id: 9, result: {} });
    c.send({ jsonrpc: "2.0", id: 2, method: "resources/list" });
    await c.until(() => c.lines.length === 2);
    expect(c.lines[1]).toMatchObject({
      id: 2,
      error: { code: -32601 },
    });
    expect(tools.report().socket!.map((e) => [e.message, e.reason])).toEqual([
      [2, expect.stringMatching(/^is not JSON: /)],
      [3, "repeats request id 1"],
      [
        4,
        "is not a JSON-RPC request or notification; the server sends no requests, so it takes no responses",
      ],
    ]);
    expect(tools.server.refusedMethods.map((r) => r.method)).toEqual([
      "resources/list",
    ]);
    expect(c.isClosed()).toBe(false);
  });

  it("closes the session on a message over 64 KB and refuses a second connection", async () => {
    const { socketPath, tools } = await serve();
    const first = raw(socketPath);
    await first.connected();
    const second = raw(socketPath);
    await second.until(second.isClosed);
    first.socket.write("x".repeat(MAX_REQUEST_BYTES + 1));
    await first.until(first.isClosed);
    const reasons = tools.report().socket!.map((e) => e.reason);
    expect(reasons).toEqual([
      "a second connection was refused; the tools socket serves one session per box",
      expect.stringMatching(
        /^the box sent a message of more than 65536 bytes .*; the session is closed$/,
      ),
    ]);
    const third = raw(socketPath);
    third.socket.on("error", () => undefined);
    await third.until(third.isClosed);
  });

  it("opens a session for the next box on the same socket, even before the first has noticed its box is gone, with the same calls, limits and record", async () => {
    const { dir, socketPath, tools } = await serve(1);
    const call = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "echo", arguments: { text: `call ${id}` } },
    });
    // A socket no box has used is left alone.
    await tools.nextSession();
    const first = raw(socketPath);
    await first.connected();
    first.send(INIT);
    first.send(call(2));
    await first.until(() => first.lines.length === 2);

    await tools.nextSession();
    await first.until(first.isClosed);
    expect(readdirSync(dir)).toEqual(["tools.sock"]);
    const second = raw(socketPath);
    await second.connected();
    second.send(INIT);
    second.send(call(2));
    await second.until(() => second.lines.length === 2);
    expect(second.isClosed()).toBe(false);
    expect(JSON.stringify(second.lines[1])).toContain(
      "this run has used all 1 of its tool calls",
    );
    expect(tools.server.calls).toMatchObject([
      { n: 1, outcome: "ok" },
      { n: 2, outcome: "refused" },
    ]);
    expect(tools.socket!.in.map((l) => JSON.parse(l).method)).toEqual([
      "initialize",
      "tools/call",
      "initialize",
      "tools/call",
    ]);
    expect(tools.socket!.out).toHaveLength(4);
    expect(tools.report().socket).toEqual([]);
  });

  it("closes the session past 3 x tool_calls + 50 messages", async () => {
    const { socketPath, tools } = await serve(1);
    const c = raw(socketPath);
    await c.connected();
    for (let i = 0; i < 54; i++)
      c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await c.until(c.isClosed);
    expect(tools.report().socket!.at(-1)).toMatchObject({
      message: 54,
      reason:
        "the box sent more than 53 messages this run; the session is closed",
    });
    expect(tools.socket!.in).toHaveLength(53);
  });
});

describe("the plugin's tools socket client", () => {
  it("closes on a reply over 256 KB and hands on only answers to its own requests", async () => {
    const dir = scratch();
    const path = join(dir, "s.sock");
    let peer: Socket | undefined;
    const server = createServer((s) => (peer = s));
    await new Promise<void>((r) => server.listen(path, () => r()));
    onTestFinished(
      () =>
        new Promise<void>((r) => {
          peer?.destroy();
          server.close(() => r());
        }),
    );
    const client = new SocketClientTransport(path);
    const got: unknown[] = [];
    const errors: string[] = [];
    let closed = false;
    client.onmessage = (m) => got.push(m);
    client.onerror = (e) => errors.push(e.message);
    client.onclose = () => (closed = true);
    await client.start();
    await client.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    for (let i = 0; i < 100 && peer === undefined; i++)
      await new Promise((r) => setTimeout(r, 10));
    peer!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} })}\n`);
    peer!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
    for (let i = 0; i < 100 && got.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    peer!.write("y".repeat(MAX_RESPONSE_BYTES + 1));
    for (let i = 0; i < 100 && !closed; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(true);
    expect(errors[0]).toMatch(
      /^the tools server sent a message of more than 262144 bytes/,
    );
    await expect(
      client.send({ jsonrpc: "2.0", id: 2, method: "ping" }),
    ).rejects.toThrow("the tools socket is closed");
  });

  it("refuses to send a request over 64 KB and names a socket it cannot reach", async () => {
    const { socketPath } = await serve();
    const client = new SocketClientTransport(socketPath);
    await client.start();
    onTestFinished(() => client.close());
    await expect(
      client.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { text: "z".repeat(MAX_REQUEST_BYTES) },
        },
      }),
    ).rejects.toThrow(/over the 65536 byte limit$/);
    await expect(
      new SocketClientTransport(join(scratch(), "missing.sock")).start(),
    ).rejects.toThrow(/^no tools socket: .*missing\.sock: /);
  });
});
