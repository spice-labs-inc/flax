import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SdkError,
  SdkErrorCode,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  connectMcp,
  MAX_RESTARTS,
  stderrTail,
  type McpProcess,
} from "../src/tools-server/mcp-upstream.ts";
import { writeFakeMcpServer, type FakeMcpConfig } from "./fake-upstreams.ts";

const signal = () => AbortSignal.timeout(10_000);

function fakeServer(config: FakeMcpConfig, maxBufferSize?: number) {
  const dir = mkdtempSync(join(tmpdir(), "agents-mcp-restart-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const fake = writeFakeMcpServer(dir, config);
  const start = (): McpProcess => {
    const transport = new StdioClientTransport({
      command: fake.command,
      args: fake.args,
      env: {},
      stderr: "pipe",
      ...(maxBufferSize === undefined ? {} : { maxBufferSize }),
    });
    return { transport, stderr: stderrTail(transport.stderr) };
  };
  const starts = () => fake.records().filter((r) => r.type === "start");
  return { fake, start, starts };
}

async function connect(start: () => McpProcess, tools: string[]) {
  const upstream = await connectMcp("fake-mcp-server", start, tools);
  onTestFinished(() => upstream.close());
  return upstream;
}

describe("an MCP upstream whose server stops", () => {
  it("fails the call whose reply was too big to read, naming why, and starts the server again for the next call", async () => {
    const { start, starts } = fakeServer(
      {
        tools: ["big", "small"],
        replies: { big: { text: "y".repeat(1024), repeat: 100 } },
      },
      64 * 1024,
    );
    const upstream = await connect(start, ["big", "small"]);
    await expect(upstream.call("big", {}, signal())).rejects.toThrow(
      /^fake-mcp-server stopped: ReadBuffer exceeded maximum size of 65536 bytes/,
    );
    expect(await upstream.call("small", { n: 1 }, signal())).toBe(
      JSON.stringify({ tool: "small", arguments: { n: 1 } }),
    );
    expect(upstream.restarts).toBe(1);
    expect(starts()).toHaveLength(2);
  });

  it("names the standard error of a server that crashed, and later calls share one restart", async () => {
    const { start, starts } = fakeServer({
      tools: ["crash", "small"],
      replies: {
        crash: {
          text: "",
          exit: {
            code: 2,
            stderr:
              "panic: runtime error: index out of range\ngoroutine 1 [running]\n",
          },
        },
      },
    });
    const upstream = await connect(start, ["crash", "small"]);
    await expect(upstream.call("crash", {}, signal())).rejects.toThrow(
      "fake-mcp-server stopped (stderr: panic: runtime error: index out of range goroutine 1 [running])",
    );
    const answers = await Promise.all(
      [1, 2, 3].map((n) => upstream.call("small", { n }, signal())),
    );
    expect(answers.map((a) => JSON.parse(a).arguments.n)).toEqual([1, 2, 3]);
    expect(upstream.restarts).toBe(1);
    expect(starts()).toHaveLength(2);
  });

  it(`starts a server again at most ${MAX_RESTARTS} times a run`, async () => {
    const { start, starts } = fakeServer({
      tools: ["crash", "small"],
      replies: { crash: { text: "", exit: { code: 1 } } },
    });
    const upstream = await connect(start, ["crash", "small"]);
    for (let i = 0; i <= MAX_RESTARTS; i++)
      await expect(upstream.call("crash", {}, signal())).rejects.toThrow(
        /^fake-mcp-server stopped$/,
      );
    await expect(upstream.call("small", {}, signal())).rejects.toThrow(
      `fake-mcp-server stopped; it was already started again ${MAX_RESTARTS} times, the most one run allows`,
    );
    expect(starts()).toHaveLength(MAX_RESTARTS + 1);
  });

  it("says so when the server cannot be started again", async () => {
    const { start } = fakeServer({
      tools: ["crash", "small"],
      replies: { crash: { text: "", exit: { code: 1 } } },
    });
    let broken = false;
    const upstream = await connect(
      () =>
        broken
          ? {
              transport: new StdioClientTransport({
                command: "/nonexistent/fake-mcp-server",
                env: {},
                stderr: "pipe",
              }),
            }
          : start(),
      ["crash", "small"],
    );
    await expect(upstream.call("crash", {}, signal())).rejects.toThrow();
    broken = true;
    await expect(upstream.call("small", {}, signal())).rejects.toThrow(
      /^fake-mcp-server stopped; starting it again failed: fake-mcp-server: spawn \/nonexistent\/fake-mcp-server ENOENT/,
    );
  });

  it("sends a call that never reached the stopped server to the new one", async () => {
    const transports: ScriptedTransport[] = [];
    const upstream = await connect(() => {
      const transport = new ScriptedTransport();
      transports.push(transport);
      return { transport };
    }, ["small"]);
    transports[0]!.down = true;
    expect(await upstream.call("small", {}, signal())).toBe("answered by 2");
    expect(transports).toHaveLength(2);
  });

  it("stops the server it runs when closed, and refuses calls after", async () => {
    const { start } = fakeServer({ tools: ["small"] });
    const upstream = await connectMcp("fake-mcp-server", start, ["small"]);
    await upstream.close();
    await expect(upstream.call("small", {}, signal())).rejects.toThrow(
      "fake-mcp-server is closed",
    );
  });
});

let scripted = 0;

/**
 * An in-memory MCP server whose send() throws "not connected" once down is
 * set, as the SDK's stdio transport does after it has stopped its child
 * and before the child's exit is seen.
 */
class ScriptedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  down = false;
  private readonly name = ++scripted;

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.down)
      return Promise.reject(
        new SdkError(SdkErrorCode.NotConnected, "Not connected"),
      );
    const m = message as {
      id?: number;
      method?: string;
      params?: { protocolVersion?: string };
    };
    if (m.id === undefined) return Promise.resolve();
    const result =
      m.method === "initialize"
        ? {
            protocolVersion: m.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "scripted", version: "0" },
          }
        : m.method === "tools/list"
          ? { tools: [{ name: "small", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: `answered by ${this.name}` }] };
    queueMicrotask(() =>
      this.onmessage?.({ jsonrpc: "2.0", id: m.id!, result } as JSONRPCMessage),
    );
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }
}
