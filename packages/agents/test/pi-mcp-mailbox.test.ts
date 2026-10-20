import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/server";
import { describe, expect, it, onTestFinished } from "vitest";
import piMcpMailbox, {
  CALL_TIMEOUT_MS,
  connectTools,
  type PiApi,
  type PiTool,
} from "../images/agent/pi-mcp-mailbox/src/extension.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { SocketServerTransport } from "../src/tools-server/socket.ts";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-pi-plugin-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Stands in for Pi: keeps what the extension registers. */
function fakePi() {
  const tools: PiTool[] = [];
  const shutdown: (() => unknown)[] = [];
  const pi: PiApi = {
    registerTool: (tool) => tools.push(tool),
    on: (_event, handler) => shutdown.push(handler),
  };
  return { pi, tools, shutdown };
}

const schema = {
  type: "object" as const,
  additionalProperties: false,
  properties: { q: { type: "string", maxLength: 5 } },
};

/** A stand-in tools server on the tools socket, with tools of every shape. */
async function fakeServer() {
  const socket = join(scratch(), "tools.sock");
  const server = new Server(
    { name: "fake", version: "0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", () => ({
    tools: [
      { name: "lookup", description: "Looks a thing up.", inputSchema: schema },
      { name: "broken", description: "Always fails.", inputSchema: schema },
      { name: "Bad Name", description: "x", inputSchema: schema },
      {
        name: "lookup",
        description: "A second tool with a taken name.",
        inputSchema: schema,
      },
    ],
  }));
  server.setRequestHandler("tools/call", (request) =>
    request.params.name === "broken"
      ? { content: [{ type: "text", text: "upstream down" }], isError: true }
      : {
          content: [
            {
              type: "text",
              text: `found ${JSON.stringify(request.params.arguments)}`,
            },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
        },
  );
  await server.connect(
    new SocketServerTransport({ socketPath: socket, maxMessages: 100 }),
  );
  onTestFinished(() => server.close());
  return { socket };
}

describe("the Pi plugin", () => {
  it("registers each usable tool the server lists, once, with the server's name, description and schema", async () => {
    const { socket } = await fakeServer();
    const { pi, tools, shutdown } = fakePi();
    const names = await connectTools(pi, { socket });
    onTestFinished(async () => {
      for (const handler of shutdown) await handler();
    });
    expect(names).toEqual(["lookup", "broken"]);
    expect(
      tools.map(({ name, label, description, parameters }) => ({
        name,
        label,
        description,
        parameters,
      })),
    ).toEqual([
      {
        name: "lookup",
        label: "lookup",
        description: "Looks a thing up.",
        parameters: schema,
      },
      {
        name: "broken",
        label: "broken",
        description: "Always fails.",
        parameters: schema,
      },
    ]);
    expect(shutdown).toHaveLength(1);
  });

  it("returns a tool's text to Pi, and throws a tool error so Pi marks the call failed", async () => {
    const { socket } = await fakeServer();
    const { pi, tools, shutdown } = fakePi();
    await connectTools(pi, { socket });
    onTestFinished(async () => {
      for (const handler of shutdown) await handler();
    });
    const [lookup, broken] = tools;
    expect(await lookup!.execute("call-1", { q: "x" }, undefined)).toEqual({
      content: [{ type: "text", text: 'found {"q":"x"}' }],
      details: undefined,
    });
    await expect(broken!.execute("call-2", {}, undefined)).rejects.toThrow(
      "upstream down",
    );
  });

  it("fails start-up when no server answers", async () => {
    const socket = join(scratch(), "tools.sock");
    const { pi, tools } = fakePi();
    await expect(
      connectTools(pi, { socket, connectTimeoutMs: 200 }),
    ).rejects.toThrow();
    expect(tools).toEqual([]);
  });

  it.skipIf(existsSync("/run/agent"))(
    "does nothing where there are no sockets",
    async () => {
      const { pi, tools, shutdown } = fakePi();
      await piMcpMailbox(pi);
      expect(tools).toEqual([]);
      expect(shutdown).toEqual([]);
    },
  );

  it("waits longer for a call than any job lets a tool take", () => {
    const jobSchema = JSON.parse(
      readFileSync(join(KIT_ROOT, "schema/job.schema.json"), "utf8"),
    );
    const maxSeconds: number =
      jobSchema.properties.limits.properties.tool_seconds.maximum;
    expect(CALL_TIMEOUT_MS).toBeGreaterThan(maxSeconds * 1000);
  });

  it("is declared as a Pi package whose extension is this file", () => {
    const pkg = JSON.parse(
      readFileSync(
        join(KIT_ROOT, "images/agent/pi-mcp-mailbox/package.json"),
        "utf8",
      ),
    );
    expect(pkg.pi).toEqual({ extensions: ["./src/extension.ts"] });
    expect(pkg.dependencies["@modelcontextprotocol/client"]).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });
});
