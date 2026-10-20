import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { generate } from "../src/generate/generate.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { LbxLauncher, type Launcher } from "../src/run-job/launcher.ts";
import { runJob, type RunOptions } from "../src/run-job/run.ts";
import { SOCKET_DIR_PREFIX } from "../src/run-job/socket-dir.ts";
import { TEST_ISSUER_KEY, testGateway } from "./fake-gateway.ts";
import { writeFakeLbx } from "./fake-lbx.ts";
import { jobFiles, makeRepo, TOOL } from "./helpers.ts";

// Built at runtime so no key-shaped literal sits in the source.
const BOT_TOKEN = ["slack", "bot", "value", "9a8b7c6d5e4f"].join("-");
const WHO = { uid: process.getuid!(), home: "/nonexistent-home" };
const UID = process.getuid!();

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-sock-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "source"],
  properties: {
    summary: { type: "string" },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["tool", "quote"],
      properties: { tool: { type: "string" }, quote: { type: "string" } },
    },
  },
};
const answer = (quote: string) =>
  JSON.stringify({ summary: "seven pods", source: { tool: TOOL, quote } });

function toolJob(
  overrides: Record<string, unknown> = {},
): Record<string, string> {
  return {
    ...jobFiles("demo", { tools: [TOOL], ...overrides }),
    "output.json": JSON.stringify(SCHEMA),
    "fixtures/output.json": answer("pods: 7 running"),
  };
}

async function repo(tools = true, overrides: Record<string, unknown> = {}) {
  const root = makeRepo({
    jobs: { demo: tools ? toolJob(overrides) : jobFiles("demo", overrides) },
  });
  await generate(loadRepo(root));
  return root;
}

function reportFiles(dir: string, rel = ""): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(join(dir, rel))) return files;
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory())
      for (const [k, v] of reportFiles(dir, path)) files.set(k, v);
    else files.set(path, readFileSync(join(dir, path), "utf8"));
  }
  return files;
}

function after(argv: string[], flag: string): string[] {
  return argv.flatMap((a, i) => (a === flag ? [argv[i + 1]!] : []));
}

interface Run {
  tools?: boolean;
  env?: Record<string, string>;
  extra?: Partial<RunOptions>;
  job?: Record<string, unknown>;
}

async function run(setup: Run = {}) {
  const root = await repo(setup.tools ?? true, setup.job);
  const gw = await testGateway({
    catalog: {
      "test-model": { display_name: "Test" },
      "other-model": { display_name: "Other" },
    },
  });
  const bin = scratch();
  const dir = scratch();
  const bases = scratch();
  const opts: RunOptions = {
    root,
    name: "demo",
    scratch: dir,
    out: join(dir, "report"),
    identity: WHO,
    log: () => {},
    lbx: writeFakeLbx(bin),
    launcher: new LbxLauncher(new PassThrough(), new PassThrough()),
    socketBases: [bases],
    gateway: gw.gateway,
    tools: { pollMs: 10 },
    env: {
      PATH: process.env.PATH ?? "",
      ...gw.env,
      SLACK_AGENTS_BOT_TOKEN: BOT_TOKEN,
      GITHUB_RUN_ID: "88",
      GITHUB_RUN_ATTEMPT: "1",
      FAKE_LBX_ANSWER: answer("pods:   7 running"),
      ...setup.env,
    },
    ...setup.extra,
  };
  const result = await runJob(opts);
  const read = (name: string) =>
    existsSync(join(bin, name))
      ? JSON.parse(readFileSync(join(bin, name), "utf8"))
      : undefined;
  return {
    result,
    seen: read("seen.json"),
    seenRepair: read("seen-repair.json"),
    probes: read("probes.json") as string[][] | undefined,
    files: reportFiles(opts.out!),
    gateway: gw.fake,
    bases,
    scratch: dir,
  };
}

const TOOL_CALL = JSON.stringify({
  name: TOOL,
  arguments: { text: "pods: 7 running" },
});
const MODEL_CALL = JSON.stringify({
  model: "some-other-model",
  max_tokens: 99999,
  messages: [{ role: "user", content: "hi" }],
});

describe("a run with the runner's sockets", () => {
  it("gives the box no network and only the two sockets, serves the tools over one and the model through the other, with no key in the box", async () => {
    const { result, seen, probes, files, gateway, bases } = await run({
      env: { FAKE_LBX_TOOL_CALL: TOOL_CALL, FAKE_LBX_MODEL_CALL: MODEL_CALL },
    });
    expect(result.messages[0]).toBe("demo: answer accepted.");

    // lbx was asked, before the run, whether it has the flags.
    expect(probes).toEqual([["--socket-dir", "/"], ["--no-network"]]);

    // No network, the socket directory, no --env, the placeholder key only.
    const argv: string[] = seen.argv;
    expect(argv).toContain("--no-network");
    expect(argv).not.toContain("--net-policy");
    expect(argv).not.toContain("--env");
    const socketDir = after(argv, "--socket-dir")[0]!;
    expect(socketDir.startsWith(join(bases, SOCKET_DIR_PREFIX))).toBe(true);
    expect(seen.socketDirMode).toBe(0o700);
    expect(seen.socketEntries).toEqual([
      { name: "model.sock", socket: true, uid: UID },
      { name: "tools.sock", socket: true, uid: UID },
    ]);
    const cmd = argv.slice(argv.indexOf("--") + 1);
    expect(cmd.slice(0, 4)).toEqual([
      "env",
      "FLAX_AGENTS_MODEL_BASE_URL=http://127.0.0.1:18080",
      "ACME_BASE_URL=http://127.0.0.1:18080",
      "ACME_API_KEY=held-by-the-runner",
    ]);
    expect(after(cmd, "--extension")).toEqual([
      "/opt/pi-extensions/pi-mcp-mailbox.mjs",
      "/opt/pi-extensions/node_modules/pi-provider-acme",
    ]);

    // No credential reached lbx, so none can reach the box.
    const key = gateway.issued[0]!;
    expect(seen.hasIssuerKey).toBe(false);
    expect(seen.toolSecrets).toEqual([]);
    expect(seen.envNames).not.toContain("ACME_API_KEY");
    expect(argv.some((a: string) => a.includes(key))).toBe(false);

    // The data directory holds no mailbox: the tools came over the socket.
    expect(seen.dataFiles).toEqual([
      "input.json",
      "output.schema.json",
      "prompt.md",
      "session",
    ]);
    expect(seen.initialize.result.capabilities).toEqual({ tools: {} });
    expect(seen.reply.result.content[0].text).toContain("\npods: 7 running\n");

    // The model call reached the gateway with the run's key the runner holds, the model forced and max_tokens capped.
    expect(seen.modelReply.status).toBe(200);
    expect(JSON.parse(seen.modelReply.body).got).toEqual({
      model: "test-model",
      max_tokens: 1000,
      messages: [{ role: "user", content: "hi" }],
    });
    const messages = gateway.requests.filter((r) => r.path === "/v1/messages");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.authorization).toBe(`Bearer ${key}`);

    // The report keeps every message over the tools socket and every forwarded call, never the key.
    const tools = JSON.parse(files.get("tools.json")!);
    expect(tools.socket).toEqual([]);
    expect(tools.mailbox).toBeUndefined();
    expect(tools.calls).toMatchObject([
      { n: 1, tool: TOOL, outcome: "ok", result: "pods: 7 running" },
    ]);
    expect(files.get("socket/in/000003.json")).toContain('"tools/call"');
    expect(files.get("socket/out/000002.json")).toContain("pods: 7 running");
    expect(JSON.parse(files.get("forwarder.json")!)).toMatchObject([
      {
        path: "/v1/messages",
        outcome: "forwarded",
        status: 200,
        model: { asked: "some-other-model", sent: "test-model" },
      },
    ]);
    const status = JSON.parse(files.get("status.json")!);
    expect(status.sockets).toEqual({
      forwarder: { forwarded: 1, refused: 0, failed: 0, polls: 0 },
      problems: [],
    });
    expect(status.citations.status).toBe("checked");
    expect(files.get("summary.md")).toContain(
      "| Network | none, only the runner's sockets; 1 model call forwarded to the model gateway, 0 refused, 0 failed |",
    );
    for (const [file, text] of files) {
      expect(text.includes(key), file).toBe(false);
      expect(text.includes(TEST_ISSUER_KEY), file).toBe(false);
    }

    // The socket directory is gone with the run.
    expect(existsSync(socketDir)).toBe(false);
    expect(readdirSync(bases)).toEqual([]);
  });

  it("gives the repair turn's box the same two sockets, with the tools and the model still served", async () => {
    const { result, seen, seenRepair, files, bases } = await run({
      env: {
        FAKE_LBX_TOOL_CALL: TOOL_CALL,
        FAKE_LBX_MODEL_CALL: MODEL_CALL,
        FAKE_LBX_ANSWER: answer("pods: 7 running").slice(0, -1),
        FAKE_LBX_REPAIR_ANSWER: answer("pods: 7 running"),
      },
    });
    expect(result.messages[0]).toBe("demo: answer accepted.");
    const status = JSON.parse(files.get("status.json")!);
    expect(status.repair).toEqual({
      problems: [expect.stringMatching(/^the answer is not JSON: /)],
      outcome: "repaired",
    });

    const socketDir = after(seen.argv, "--socket-dir")[0]!;
    expect(after(seenRepair.argv, "--socket-dir")).toEqual([socketDir]);
    expect(seenRepair.socketEntries).toEqual(seen.socketEntries);
    expect(seenRepair.socketEntries).toEqual([
      { name: "model.sock", socket: true, uid: UID },
      { name: "tools.sock", socket: true, uid: UID },
    ]);
    expect(seenRepair.toolCallError).toBeNull();
    expect(seenRepair.reply.result.content[0].text).toContain(
      "\npods: 7 running\n",
    );
    expect(seenRepair.modelReply.status).toBe(200);

    // One record across both boxes: the calls, every socket message and every forwarded call.
    const tools = JSON.parse(files.get("tools.json")!);
    expect(tools.socket).toEqual([]);
    expect(tools.calls).toMatchObject([
      { n: 1, tool: TOOL, outcome: "ok" },
      { n: 2, tool: TOOL, outcome: "ok" },
    ]);
    expect(files.get("socket/in/000003.json")).toContain('"tools/call"');
    expect(files.get("socket/in/000004.json")).toContain('"initialize"');
    expect(files.get("socket/in/000006.json")).toContain('"tools/call"');
    expect(status.sockets.forwarder.forwarded).toBe(2);
    expect(status.citations.status).toBe("checked");

    expect(existsSync(socketDir)).toBe(false);
    expect(readdirSync(bases)).toEqual([]);
  });

  it("serves a job without tools only the model socket", async () => {
    const { result, seen, files } = await run({
      tools: false,
      env: { FAKE_LBX_ANSWER: '{"summary":"no tools"}' },
    });
    expect(result.ok).toBe(true);
    expect(seen.socketEntries).toEqual([
      { name: "model.sock", socket: true, uid: UID },
    ]);
    const cmd: string[] = seen.argv.slice(seen.argv.indexOf("--") + 1);
    expect(after(cmd, "--extension")).toEqual([
      "/opt/pi-extensions/pi-mcp-mailbox.mjs",
      "/opt/pi-extensions/node_modules/pi-provider-acme",
    ]);
    expect(after(cmd, "--tools")).toEqual(["read,grep,find,ls"]);
    expect(files.has("tools.json")).toBe(false);
  });

  it("is refused before anything is created while the lbx on PATH lacks the flags", async () => {
    const {
      result,
      seen,
      probes,
      scratch: dir,
      bases,
    } = await run({
      env: { FAKE_LBX_NO_SOCKETS: "1" },
    });
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toMatch(
      /^every run gets no network and the runner's sockets, but .*fake-lbx does not offer --socket-dir; pin a sandbox \(lbx\) release whose lbx has --socket-dir and --no-network$/,
    );
    expect(probes).toEqual([["--socket-dir", "/"]]);
    expect(seen).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
    expect(readdirSync(bases)).toEqual([]);
  });

  it("fails clearly when no place for the socket directory is one lbx accepts", async () => {
    const { result, seen } = await run({
      extra: { socketBases: ["/nonexistent-socket-base"] },
    });
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toBe(
      "demo: no place for the run's socket directory that lbx accepts: /nonexistent-socket-base: ENOENT",
    );
    expect(seen).toBeUndefined();
  });

  it.each<[string, Record<string, string>]>([
    ["Pi exits non-zero", { FAKE_LBX_STATUS: "status=exited code=1" }],
    ["the run times out", { FAKE_LBX_STATUS: "status=timeout code=124" }],
    ["lbx is signalled", { FAKE_LBX_STATUS: "status=signal code=143" }],
    ["the answer does not match", { FAKE_LBX_ANSWER: '{"summary":3}' }],
  ])("removes the socket directory when %s", async (_, env) => {
    const { result, seen, bases } = await run({ env });
    expect(result.ok).toBe(false);
    expect(seen.socketDir).not.toBeNull();
    expect(existsSync(seen.socketDir)).toBe(false);
    expect(readdirSync(bases)).toEqual([]);
  });

  it("removes the socket directory when launching the box throws", async () => {
    const throwing: Launcher = {
      kind: "lbx",
      launch: () => Promise.reject(new Error("docker went away")),
    };
    const { result, bases } = await run({ extra: { launcher: throwing } });
    expect(result.messages[0]).toBe("demo: docker went away");
    expect(readdirSync(bases)).toEqual([]);
  });

  it("removes the socket directory when the tools cannot start", async () => {
    const { result, seen, bases } = await run({
      extra: {
        tools: {
          startUpstreams: () => Promise.reject(new Error("upstream down")),
        },
      },
    });
    expect(result.messages[0]).toBe("demo: upstream down");
    expect(seen).toBeUndefined();
    expect(readdirSync(bases)).toEqual([]);
  });

  it("in a stub run, passes the socket directory with the tools socket only and asks lbx nothing", async () => {
    const root = await repo();
    const dir = scratch();
    const bases = scratch();
    const result = await runJob({
      root,
      name: "demo",
      stub: true,
      scratch: dir,
      out: join(dir, "report"),
      env: {},
      identity: WHO,
      log: () => {},
      socketBases: [bases],
      lbx: "/nonexistent/lbx",
    });
    expect(result.messages[0]).toBe("demo: answer accepted.");
    const argv = result.report!.argv;
    expect(argv).toContain("--no-network");
    expect(after(argv, "--socket-dir")[0]!.startsWith(bases)).toBe(true);
    expect(result.report!.sockets).toEqual({ problems: [] });
    expect(readdirSync(bases)).toEqual([]);
  });
});
