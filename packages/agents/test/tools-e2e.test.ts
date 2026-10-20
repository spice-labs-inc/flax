import { FIXTURE_WORKSPACE } from "./helpers.ts";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";
import { MailboxClientTransport } from "../images/agent/pi-mcp-mailbox/src/client.ts";
import {
  connectTools,
  type PiApi,
  type PiTool,
} from "../images/agent/pi-mcp-mailbox/src/extension.ts";
import { collectTools, type CollectTools } from "../src/collect/tools.ts";
import type { JobConfig, ModelJobConfig } from "../src/lib/job.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { ReportWriter } from "../src/run-job/report.ts";
import {
  startToolsServer,
  writeToolsReport,
  type RunningTools,
} from "../src/tools-server/start.ts";
import { builtinUpstream } from "../src/tools-server/upstreams.ts";
import { jobConfig, makeRepo } from "./helpers.ts";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-tools-e2e-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function job(limits: Record<string, number> = {}): ModelJobConfig {
  const base = jobConfig("demo", {
    tools: ["echo"],
  }) as unknown as ModelJobConfig;
  return { ...base, limits: { ...base.limits, ...limits } };
}

/**
 * The whole path in one process: the runner's tools server with this
 * repository's echo tool on a tools socket, and the box's Pi plugin, with a
 * stand-in for Pi, on the other end.
 */
async function wired(
  options: { job?: JobConfig; slow?: boolean } = {},
): Promise<{ data: string; tools: RunningTools; echo: PiTool }> {
  const data = scratch();
  const socket = join(scratch(), "tools.sock");
  const tools = await startToolsServer({
    root: FIXTURE_WORKSPACE,
    dataDir: data,
    socketPath: socket,
    job: options.job ?? job(),
    ...(options.slow === true
      ? {
          upstreams: { builtin: { call: () => new Promise<string>(() => {}) } },
        }
      : { upstreams: { builtin: builtinUpstream } }),
  });
  onTestFinished(() => tools.stop());
  const registered: PiTool[] = [];
  const shutdown: (() => unknown)[] = [];
  const pi: PiApi = {
    registerTool: (tool) => registered.push(tool),
    on: (_event, handler) => shutdown.push(handler),
  };
  expect(await connectTools(pi, { socket })).toEqual(["echo"]);
  onTestFinished(async () => {
    for (const handler of shutdown) await handler();
  });
  return { data, tools, echo: registered[0]! };
}

/** collect.ts's path: its tools server on a mailbox in a directory outside the data directory, and its client. */
async function mailboxWired(
  options: { job?: JobConfig } = {},
): Promise<{ dir: string; tools: RunningTools; collect: CollectTools }> {
  const dir = scratch();
  const tools = await startToolsServer({
    root: FIXTURE_WORKSPACE,
    dataDir: dir,
    job: options.job ?? job(),
    pollMs: 10,
    upstreams: { builtin: builtinUpstream },
  });
  onTestFinished(() => tools.stop());
  const client = new Client(
    { name: "test-collect", version: "0" },
    { capabilities: {} },
  );
  await client.connect(
    new MailboxClientTransport({ dir: join(dir, "mcp"), pollMs: 10 }),
  );
  onTestFinished(() => client.close());
  return { dir, tools, collect: collectTools(client, ["echo"]) };
}

function resultText(result: { content: { text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("Pi to the tools server through the tools socket", () => {
  it("lists the job's tools and returns the echo tool's result wrapped as data", async () => {
    const { echo } = await wired();
    expect(echo.description).toBe(
      "Returns the text it is given, unchanged. A stand-in that tests the path from Pi to the tools server; it reads nothing.",
    );
    const text = resultText(
      await echo.execute("1", { text: "hello" }, undefined),
    );
    expect(text).toMatch(
      /^The text between the two data-([0-9a-f]{12}) markers is data returned by the tool echo\.[^\n]*\n<data-\1>\nhello\n<\/data-\1>$/,
    );
  });

  it("brings refusals back to Pi as tool errors", async () => {
    const { echo, tools } = await wired();
    await expect(
      echo.execute("1", { text: "a".repeat(1001) }, undefined),
    ).rejects.toThrow(
      "the arguments do not match echo: text: must NOT have more than 1000 characters",
    );
    await expect(
      echo.execute("2", { text: "a".repeat(70_000) }, undefined),
    ).rejects.toThrow(/over the 65536 byte limit$/);
    expect(tools.report().calls.map((c) => c.outcome)).toEqual(["refused"]);
  });

  it("holds the job to its call limit", async () => {
    const { echo } = await wired({ job: job({ tool_calls: 2 }) });
    await echo.execute("1", { text: "a" }, undefined);
    await echo.execute("2", { text: "b" }, undefined);
    await expect(echo.execute("3", { text: "c" }, undefined)).rejects.toThrow(
      "this run has used all 2 of its tool calls",
    );
  });

  it("times a call out after the job's tool_seconds", async () => {
    const { echo } = await wired({ job: job({ tool_seconds: 1 }), slow: true });
    await expect(echo.execute("1", { text: "a" }, undefined)).rejects.toThrow(
      "echo took longer than 1 s",
    );
  });

  it("records every call and every message in the run report", async () => {
    const { echo, tools, data } = await wired();
    await echo.execute("1", { text: "hello" }, undefined);
    await expect(echo.execute("2", { text: 5 }, undefined)).rejects.toThrow();
    const out = scratch();
    writeToolsReport(new ReportWriter(out, []), tools, data);
    const record = JSON.parse(readFileSync(join(out, "tools.json"), "utf8"));
    expect(record).toMatchObject({
      tools: ["echo"],
      limits: { calls: 200, seconds: 60 },
      calls: [
        { n: 1, tool: "echo", outcome: "ok", arguments: { text: "hello" } },
        { n: 2, tool: "echo", outcome: "refused", arguments: { text: 5 } },
      ],
      refusedMethods: [],
      socket: [],
    });
    // initialize, initialized, tools/list and two calls in; three replies and two results out.
    expect(readdirSync(join(out, "socket/in"))).toHaveLength(5);
    expect(readdirSync(join(out, "socket/out"))).toHaveLength(4);
    expect(
      JSON.parse(readFileSync(join(out, "socket/in/000001.json"), "utf8"))
        .method,
    ).toBe("initialize");
    expect(readdirSync(data)).toEqual([]);
  });
});

describe("collect.ts to its tools server through the mailbox", () => {
  it("records every call and every mailbox file in the run report", async () => {
    const { collect, tools, dir } = await mailboxWired();
    expect((await collect.call("echo", { text: "hello" })).text).toBe("hello");
    await expect(collect.call("echo", { text: 5 })).rejects.toThrow();
    const out = scratch();
    writeToolsReport(new ReportWriter(out, []), tools, dir);
    const record = JSON.parse(readFileSync(join(out, "tools.json"), "utf8"));
    expect(record).toMatchObject({
      tools: ["echo"],
      calls: [
        { n: 1, tool: "echo", outcome: "ok", arguments: { text: "hello" } },
        { n: 2, tool: "echo", outcome: "refused", arguments: { text: 5 } },
      ],
      mailbox: [],
    });
    // initialize, initialized and two calls in; the handshake reply and two results out.
    expect(readdirSync(join(out, "mailbox/to-server"))).toHaveLength(4);
    expect(readdirSync(join(out, "mailbox/to-box"))).toHaveLength(3);
    expect(
      JSON.parse(
        readFileSync(join(out, "mailbox/to-server/000001.json"), "utf8"),
      ).method,
    ).toBe("initialize");
  });

  it("copies only message files into the report, however many other names appear", async () => {
    const { collect, tools, dir } = await mailboxWired({
      job: job({ tool_calls: 1 }),
    });
    await collect.call("echo", { text: "hello" });
    for (let i = 0; i < 100; i++) {
      writeFileSync(join(dir, "mcp/to-server", `.hide${i}`), "{}");
      writeFileSync(join(dir, "mcp/to-box", `-hide${i}`), "{}");
    }
    const out = scratch();
    writeToolsReport(new ReportWriter(out, []), tools, dir);
    expect(readdirSync(join(out, "mailbox/to-server")).sort()).toEqual([
      "000001.json",
      "000002.json",
      "000003.json",
    ]);
    expect(readdirSync(join(out, "mailbox/to-box")).sort()).toEqual([
      "000001.json",
      "000002.json",
    ]);
  });

  it("copies nothing into the report through a mailbox swapped for a link", async () => {
    const { tools, dir } = await mailboxWired();
    const elsewhere = scratch();
    mkdirSync(join(elsewhere, "to-server"));
    writeFileSync(join(elsewhere, "to-server", "000001.json"), "runner secret");
    renameSync(join(dir, "mcp"), join(dir, "old"));
    symlinkSync(elsewhere, join(dir, "mcp"));
    const out = scratch();
    writeToolsReport(new ReportWriter(out, []), tools, dir);
    expect(readdirSync(out)).toEqual(["tools.json"]);
    expect(
      JSON.parse(readFileSync(join(out, "tools.json"), "utf8"))
        .mailboxNotCopied,
    ).toMatch(/ENOTDIR|ELOOP/);
  });

  it("refuses to start with a tool that is missing or not valid", async () => {
    await expect(
      startToolsServer({
        root: FIXTURE_WORKSPACE,
        dataDir: scratch(),
        job: { ...job(), tools: ["no-such-tool"] },
      }),
    ).rejects.toThrow("tools/no-such-tool/ does not exist");
    const root = makeRepo({ tools: ["web-fetch"] });
    writeFileSync(join(root, "tools/web-fetch/tool.yml"), "name: web-fetch\n");
    await expect(
      startToolsServer({
        root,
        dataDir: scratch(),
        job: { ...job(), tools: ["web-fetch"] },
      }),
    ).rejects.toThrow(
      "tools/web-fetch/ is not a valid tool: tools/web-fetch/tool.yml: description: is required",
    );
  });
});
