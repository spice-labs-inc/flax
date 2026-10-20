import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { parse, stringify } from "yaml";
import { generate } from "../src/generate/generate.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { PI_MAILBOX_EXTENSION } from "../src/run-job/argv.ts";
import { LbxLauncher } from "../src/run-job/launcher.ts";
import { runJob, type RunOptions } from "../src/run-job/run.ts";
import type { RunToolsHooks } from "../src/run-job/tools.ts";
import type {
  RunningUpstreams,
  StartUpstreamsOptions,
} from "../src/tools-server/start-upstreams.ts";
import { TEST_ISSUER_KEY, testGateway } from "./fake-gateway.ts";
import { writeFakeLbx } from "./fake-lbx.ts";
import {
  jobFiles,
  makeRepo,
  TOOL,
  toolSpec,
  type RepoSpec,
} from "./helpers.ts";

const ISSUER_ENV = { LLM_GATEWAY_ISSUER_KEY: TEST_ISSUER_KEY };
// Built at runtime so no key-shaped literal sits in the source.
const BOT_TOKEN = ["slack", "bot", "value", "1a2b3c4d5e6f"].join("-");
const RUN_TOKEN = ["installation", "token", "for", "the", "run"].join("-");
const WHO = { uid: process.getuid!(), home: "/nonexistent-home" };

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-run-tools-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An answer schema with one quote of a tool result, as tools-proof has four. */
const CITED_SCHEMA = {
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

function citedAnswer(tool: string, quote: string): string {
  return JSON.stringify({ summary: "seven pods", source: { tool, quote } });
}

function citedJob(tools: string[]): Record<string, string> {
  return {
    ...jobFiles("demo", { tools }),
    "output.json": JSON.stringify(CITED_SCHEMA),
    "fixtures/output.json": citedAnswer(tools[0] ?? TOOL, "pods: 7 running"),
  };
}

/** A tool on a real upstream, served in these tests by a stand-in upstream. */
function upstreamTool(name: string, server: string, operation: string) {
  return {
    [`tools/${name}/tool.yml`]: stringify(
      toolSpec(name, { upstream: { server, operations: [operation] } }),
    ),
    [`tools/${name}/map.ts`]: `export default {
  map: (args) => ({ operation: ${JSON.stringify(operation)}, arguments: { text: args.text } }),
};
`,
  };
}

const TOOLS = {
  ...upstreamTool("slacky", "slack", "conversations.history"),
  ...upstreamTool("podsy", "kubernetes", "pods_list"),
};

async function repo(spec: RepoSpec): Promise<string> {
  const root = makeRepo({ files: TOOLS, ...spec });
  await generate(loadRepo(root));
  return root;
}

/** A run's options, with a fake gateway to issue a real run's key. */
async function options(
  root: string,
  extra: Partial<RunOptions> = {},
): Promise<RunOptions> {
  const dir = scratch();
  const gw = await testGateway();
  return {
    root,
    name: "demo",
    scratch: dir,
    out: join(dir, "report"),
    env: { ...ISSUER_ENV, PATH: process.env.PATH ?? "" },
    identity: WHO,
    log: () => {},
    launcher: new LbxLauncher(new PassThrough(), new PassThrough()),
    gateway: gw.gateway,
    socketBases: [scratch()],
    ...extra,
  };
}

function reportFiles(dir: string, rel = ""): Map<string, string> {
  const files = new Map<string, string>();
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

/** Records how the runner starts upstreams and stands in for them. */
function fakeUpstreams(reply: (args: Record<string, unknown>) => string) {
  const seen: {
    options?: StartUpstreamsOptions;
    closed: boolean;
    calls: unknown[];
  } = {
    closed: false,
    calls: [],
  };
  const start = (o: StartUpstreamsOptions): Promise<RunningUpstreams> => {
    seen.options = o;
    const upstream = {
      call: (operation: string, args: Record<string, unknown>) => {
        seen.calls.push({ operation, args });
        return Promise.resolve(reply(args));
      },
    };
    return Promise.resolve({
      upstreams: Object.fromEntries(o.servers.map((s) => [s, upstream])),
      secrets: [RUN_TOKEN],
      scrub: (text) => text,
      close: () => {
        seen.closed = true;
        return Promise.resolve();
      },
    });
  };
  return { seen, start };
}

describe("a stub run of a job with tools", () => {
  it("starts the tools server on the tools socket with no upstreams, loads the plugin and keeps the record", async () => {
    const root = await repo({ jobs: { demo: citedJob([TOOL]) } });
    const opts = await options(root, { stub: true });
    delete opts.launcher;
    const result = await runJob({ ...opts, env: { PATH: "/nonexistent" } });
    expect(result.messages[0]).toBe("demo: answer accepted.");
    const files = reportFiles(opts.out!);
    const argv: string[] = JSON.parse(files.get("argv.json")!);
    expect(after(argv, "--extension")).toContain(PI_MAILBOX_EXTENSION);
    expect(after(argv, "--tools")).toEqual([`read,grep,find,ls,${TOOL}`]);
    expect(after(argv, "--socket-dir")).toHaveLength(1);
    const data = after(argv, "--data")[0]!;
    expect(existsSync(join(data, "mcp"))).toBe(false);
    const status = JSON.parse(files.get("status.json")!);
    expect(status.tools).toEqual({
      names: [TOOL],
      upstreams: [],
      calls: 0,
      ok: 0,
    });
    expect(status.citations).toEqual({
      status: "skipped",
      reason: "a stub run calls no tools",
    });
    expect(
      JSON.parse(files.get("timings.json")!).map(
        (t: { step: string }) => t.step,
      ),
    ).toEqual([
      "load",
      "budget",
      "input",
      "upstreams",
      "tools",
      "run",
      "validate",
    ]);
    expect(JSON.parse(files.get("tools.json")!)).toMatchObject({
      tools: [TOOL],
      calls: [],
      socket: [],
    });
    expect(files.get("summary.md")).toContain(
      "| Quotes of tool results | not checked: a stub run calls no tools |",
    );
  });

  it("needs no tool credential, even for upstreams that need one", async () => {
    const root = await repo({ jobs: { demo: citedJob(["slacky", "podsy"]) } });
    const opts = await options(root, { stub: true });
    delete opts.launcher;
    const result = await runJob({ ...opts, env: {} });
    expect(result.ok).toBe(true);
    expect(result.report?.tools?.upstreams).toEqual([]);
  });

  it("gives a job without tools no tools server, only the plugin's model shim", async () => {
    const root = await repo({ jobs: { demo: jobFiles("demo") } });
    const opts = await options(root, { stub: true });
    delete opts.launcher;
    const result = await runJob(opts);
    expect(result.ok).toBe(true);
    const files = reportFiles(opts.out!);
    expect(files.has("tools.json")).toBe(false);
    const argv: string[] = JSON.parse(files.get("argv.json")!);
    expect(after(argv, "--extension")).toContain(PI_MAILBOX_EXTENSION);
    expect(after(argv, "--tools")).toEqual(["read,grep,find,ls"]);
    expect(existsSync(join(after(argv, "--data")[0]!, "mcp"))).toBe(false);
    const status = JSON.parse(files.get("status.json")!);
    expect(status.tools).toBeUndefined();
    expect(status.citations).toBeUndefined();
  });
});

describe("a real run of a job with tools", () => {
  it("refuses to start without the credentials its tools need, naming them", async () => {
    const root = await repo({ jobs: { demo: citedJob(["slacky"]) } });
    expect((await runJob(await options(root))).messages).toEqual([
      "SLACK_AGENTS_BOT_TOKEN is not set; the job's tools need it",
    ]);
    const k8s = await repo({ jobs: { demo: citedJob(["podsy"]) } });
    expect((await runJob(await options(k8s))).messages).toEqual([
      "KUBECONFIG_DEV, KUBECONFIG_STAGING, KUBECONFIG_PROD, KUBECONFIG_SHARED_SERVICES are not set; the job's tools need them",
    ]);
  });

  async function throughTheSocket(answer: string, text = "pods: 7 running") {
    const root = await repo({ jobs: { demo: citedJob([TOOL]) } });
    const bin = scratch();
    const opts = await options(root, {
      lbx: writeFakeLbx(bin),
      tools: { pollMs: 10 },
      env: {
        ...ISSUER_ENV,
        PATH: process.env.PATH ?? "",
        FAKE_LBX_TOOL_CALL: JSON.stringify({
          name: TOOL,
          arguments: { text },
        }),
        FAKE_LBX_ANSWER: answer,
      },
    });
    const result = await runJob(opts);
    const seen = JSON.parse(readFileSync(join(bin, "seen.json"), "utf8"));
    return {
      result,
      seen,
      files: reportFiles(opts.out!),
      scratch: opts.scratch!,
    };
  }

  it("serves the box's calls over the tools socket while lbx runs, and checks the answer's quotes", async () => {
    const {
      result,
      seen,
      files,
      scratch: dir,
    } = await throughTheSocket(citedAnswer(TOOL, "pods:   7 running"));
    expect(result.messages[0]).toBe("demo: answer accepted.");
    expect(seen.socketEntries.map((e: { name: string }) => e.name)).toEqual([
      "model.sock",
      "tools.sock",
    ]);
    expect(seen.initialize.result.capabilities).toEqual({ tools: {} });
    const replyText = seen.reply.result.content[0].text as string;
    expect(replyText).toMatch(/is data returned by the tool web-fetch\./);
    expect(replyText).toContain("\npods: 7 running\n");
    expect(after(seen.argv, "--extension")).toContain(PI_MAILBOX_EXTENSION);
    expect(seen.argv).not.toContain("--env");

    const record = JSON.parse(files.get("tools.json")!);
    expect(record.calls).toMatchObject([
      {
        n: 1,
        tool: TOOL,
        outcome: "ok",
        operation: "echo",
        result: "pods: 7 running",
      },
    ]);
    expect(files.get("socket/in/000003.json")).toContain('"tools/call"');
    expect(files.get("socket/out/000002.json")).toContain("pods: 7 running");
    const status = JSON.parse(files.get("status.json")!);
    expect(status.tools).toEqual({
      names: [TOOL],
      upstreams: ["builtin"],
      calls: 1,
      ok: 1,
    });
    expect(status.citations).toEqual({
      status: "checked",
      citations: [
        {
          path: "source",
          tool: TOOL,
          quote: "pods:   7 running",
          found: true,
        },
      ],
    });
    expect(files.get("summary.md")).toContain(
      "| Tools | 1 call, 1 answered (web-fetch) |",
    );
    expect(files.get("summary.md")).toContain(
      "| Quotes of tool results | 1 of 1 found in what the tools returned |",
    );
    // The upstreams' work directory is gone with the run.
    const run = readdirSync(dir).find((d) => d.startsWith("job-demo-"))!;
    expect(readdirSync(join(dir, run)).sort()).toEqual([
      "data",
      "lbx",
      "state",
    ]);
  });

  it("fails a run whose answer quotes text no tool returned, keeping the answer", async () => {
    const { result, files } = await throughTheSocket(
      citedAnswer(TOOL, "pods: 9 running"),
    );
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toBe(
      "demo: the answer quotes text no tool returned (1 of 1: source)",
    );
    expect(files.has("answer.json")).toBe(true);
    expect(JSON.parse(files.get("status.json")!).citations.citations).toEqual([
      {
        path: "source",
        tool: TOOL,
        quote: "pods: 9 running",
        found: false,
        reason: "the quote is not in any result web-fetch returned",
      },
    ]);
  });

  it("gives tool credentials to the upstreams only: not lbx, the box or collect.ts, and scrubs them from the report", async () => {
    const root = await repo({
      jobs: {
        demo: {
          ...citedJob(["slacky"]),
          "collect.ts":
            "console.log(JSON.stringify({ token: process.env.SLACK_AGENTS_BOT_TOKEN ?? null }));\n",
        },
      },
    });
    const bin = scratch();
    const fake = fakeUpstreams((args) => `slack says ${String(args.text)}`);
    const opts = await options(root, {
      lbx: writeFakeLbx(bin),
      tools: { pollMs: 10, startUpstreams: fake.start },
      env: {
        ...ISSUER_ENV,
        SLACK_AGENTS_BOT_TOKEN: BOT_TOKEN,
        KUBECONFIG_PROD: "a kubeconfig this job does not use",
        PATH: process.env.PATH ?? "",
        FAKE_LBX_TOOL_CALL: JSON.stringify({
          name: "slacky",
          arguments: { text: "hello" },
        }),
        FAKE_LBX_ANSWER: citedAnswer("slacky", "slack says hello"),
      },
    });
    const result = await runJob(opts);
    expect(result.messages[0]).toBe("demo: answer accepted.");
    const seen = JSON.parse(readFileSync(join(bin, "seen.json"), "utf8"));
    expect(seen.toolSecrets).toEqual([]);
    expect(seen.hasIssuerKey).toBe(false);
    expect(JSON.stringify(seen.argv).includes(BOT_TOKEN)).toBe(false);

    const started = fake.seen.options!;
    expect(started.servers).toEqual(["slack"]);
    expect(started.githubOperations).toEqual([]);
    expect(started.env.SLACK_AGENTS_BOT_TOKEN).toBe(BOT_TOKEN);
    const data = after(seen.argv, "--data")[0]!;
    const workFromData = relative(data, started.workDir);
    expect(workFromData.startsWith("..")).toBe(true);
    expect(relative(join(data, ".."), started.workDir)).toBe("tools");
    expect(fake.seen.calls).toEqual([
      { operation: "conversations.history", args: { text: "hello" } },
    ]);
    expect(fake.seen.closed).toBe(true);

    expect(JSON.parse(readFileSync(join(data, "input.json"), "utf8"))).toEqual({
      token: null,
    });
    for (const [file, text] of reportFiles(opts.out!)) {
      expect(text.includes(BOT_TOKEN), file).toBe(false);
      expect(text.includes(TEST_ISSUER_KEY), file).toBe(false);
    }
  });

  it("gives the model's tools the commits the input pins repositories to when the job sets pin_files, and none otherwise", async () => {
    const pinny = {
      "tools/pinny/tool.yml": stringify(
        toolSpec("pinny", {
          upstream: { server: "slack", operations: ["conversations.history"] },
        }),
      ),
      "tools/pinny/map.ts": `export default {
  map: (args, context) => ({ operation: "conversations.history", arguments: { text: context.commits.get(args.text) ?? "main" } }),
};
`,
    };
    const collect = `console.log(JSON.stringify({ repos: { "notes-co/widget": "cccccccccccccccccccccccccccccccccccccccc", "other-org/x": "dddddddddddddddddddddddddddddddddddddddd", "notes-co/short": "abc1234" } }));\n`;
    const pinned = async (pin: boolean, repoName: string) => {
      const root = await repo({
        files: { ...TOOLS, ...pinny },
        jobs: {
          demo: {
            ...citedJob(["pinny"]),
            "job.yml": stringify({
              ...parse(citedJob(["pinny"])["job.yml"]!),
              ...(pin ? { pin_files: true } : {}),
            }),
            "collect.ts": collect,
          },
        },
      });
      const fake = fakeUpstreams((args) => `read at ${String(args.text)}`);
      const result = await runJob(
        await options(root, {
          lbx: writeFakeLbx(scratch()),
          tools: { pollMs: 10, startUpstreams: fake.start },
          env: {
            ...ISSUER_ENV,
            SLACK_AGENTS_BOT_TOKEN: BOT_TOKEN,
            PATH: process.env.PATH ?? "",
            FAKE_LBX_TOOL_CALL: JSON.stringify({
              name: "pinny",
              arguments: { text: repoName },
            }),
            FAKE_LBX_ANSWER: citedAnswer("pinny", "read at"),
          },
        }),
      );
      expect(result.messages[0]).toBe("demo: answer accepted.");
      return fake.seen.calls;
    };
    expect(await pinned(true, "widget")).toEqual([
      {
        operation: "conversations.history",
        args: { text: "cccccccccccccccccccccccccccccccccccccccc" },
      },
    ]);
    // Only full shas of the organization's repositories pin anything.
    expect(await pinned(true, "short")).toEqual([
      { operation: "conversations.history", args: { text: "main" } },
    ]);
    expect(await pinned(false, "widget")).toEqual([
      { operation: "conversations.history", args: { text: "main" } },
    ]);
  });

  it("scrubs a credential made during the run from the report and fails the run", async () => {
    const root = await repo({ jobs: { demo: citedJob(["slacky"]) } });
    const fake = fakeUpstreams(() => `the token is ${RUN_TOKEN}`);
    const bin = scratch();
    const opts = await options(root, {
      lbx: writeFakeLbx(bin),
      tools: { pollMs: 10, startUpstreams: fake.start },
      env: {
        ...ISSUER_ENV,
        SLACK_AGENTS_BOT_TOKEN: BOT_TOKEN,
        PATH: process.env.PATH ?? "",
        FAKE_LBX_TOOL_CALL: JSON.stringify({
          name: "slacky",
          arguments: { text: "x" },
        }),
        FAKE_LBX_ANSWER: `{"summary":"{{reply}}","source":{"tool":"slacky","quote":"the token is"}}`,
      },
    });
    const result = await runJob(opts);
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toContain(
      "a secret value appeared in the run's output",
    );
    const files = reportFiles(opts.out!);
    for (const [file, text] of files)
      expect(text.includes(RUN_TOKEN), file).toBe(false);
    expect(files.get("answer.json")).toContain("[redacted]");
  });

  it("fetches the pinned binaries into the run directory for upstreams that need them", async () => {
    const root = await repo({ jobs: { demo: citedJob(["podsy"]) } });
    const fetched: [string, string][] = [];
    const fake = fakeUpstreams(() => "pods: 7 running");
    const hooks: RunToolsHooks = {
      pollMs: 10,
      startUpstreams: fake.start,
      fetchServers: (r, dir) => {
        fetched.push([r, dir]);
        return Promise.resolve();
      },
    };
    const kubeconfigs = Object.fromEntries(
      ["DEV", "STAGING", "PROD", "SHARED_SERVICES"].map((c) => [
        `KUBECONFIG_${c}`,
        `kubeconfig for ${c}`,
      ]),
    );
    const opts = await options(root, {
      lbx: writeFakeLbx(scratch()),
      tools: hooks,
      env: {
        ...ISSUER_ENV,
        PATH: process.env.PATH ?? "",
        ...kubeconfigs,
        FAKE_LBX_ANSWER: citedAnswer("podsy", "pods: 7 running"),
        FAKE_LBX_TOOL_CALL: JSON.stringify({
          name: "podsy",
          arguments: { text: "x" },
        }),
      },
    });
    const result = await runJob(opts);
    expect(result.messages[0]).toBe("demo: answer accepted.");
    expect(fetched).toHaveLength(1);
    expect(fetched[0]![0]).toBe(root);
    expect(fetched[0]![1]).toBe(fake.seen.options!.binDir);
    expect(
      relative(join(fake.seen.options!.workDir, ".."), fetched[0]![1]),
    ).toBe("mcp-servers");
  });

  it("fails before the box starts when the upstreams cannot start", async () => {
    const root = await repo({ jobs: { demo: citedJob(["slacky"]) } });
    const bin = scratch();
    const opts = await options(root, {
      lbx: writeFakeLbx(bin),
      tools: {
        startUpstreams: () => Promise.reject(new Error("Slack said no")),
      },
      env: {
        ...ISSUER_ENV,
        SLACK_AGENTS_BOT_TOKEN: BOT_TOKEN,
        PATH: process.env.PATH ?? "",
      },
    });
    const result = await runJob(opts);
    expect(result.messages[0]).toBe("demo: Slack said no");
    expect(existsSync(join(bin, "seen.json"))).toBe(false);
  });
});
