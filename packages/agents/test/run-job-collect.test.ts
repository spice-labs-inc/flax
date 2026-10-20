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
import { runChecks } from "../src/check/index.ts";
import { generate } from "../src/generate/generate.ts";
import { KIT_ACTION_STEP } from "../src/generate/render.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { LbxLauncher } from "../src/run-job/launcher.ts";
import { runJob, type RunOptions } from "../src/run-job/run.ts";
import type {
  RunningUpstreams,
  StartUpstreamsOptions,
} from "../src/tools-server/start-upstreams.ts";
import { TEST_ISSUER_KEY, testGateway } from "./fake-gateway.ts";
import { writeFakeLbx } from "./fake-lbx.ts";
import {
  formatted,
  jobFiles,
  makeRepo,
  toolSpec,
  type RepoSpec,
} from "./helpers.ts";

const ISSUER_ENV = { LLM_GATEWAY_ISSUER_KEY: TEST_ISSUER_KEY };
// Built at runtime so no key-shaped literal sits in the source.
const BOT_TOKEN = ["slack", "bot", "value", "1a2b3c4d5e6f"].join("-");
const KUBECONFIG = ["a", "kubeconfig", "for", "the", "tests"].join("-");
const WHO = { uid: process.getuid!(), home: "/nonexistent-home" };

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-run-collect-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
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
  // collect.ts runs under tsx; ESM lets it use top-level await as a job's collect.ts does.
  "package.json": JSON.stringify({ type: "module" }),
};

const COLLECT = `import { connectCollectTools } from ${JSON.stringify(join(KIT_ROOT, "src/collect/tools.ts"))};
const tools = await connectCollectTools();
const ok = await tools.call("slacky", { text: "hello" });
let refused = "";
try {
  await tools.call("podsy", { text: "not mine" });
} catch (err) {
  refused = err.message;
}
await tools.close();
console.log(JSON.stringify({
  names: tools.names,
  ok,
  refused,
  mailbox: process.env.FLAX_AGENTS_COLLECT_MAILBOX,
  settings: process.env.FLAX_AGENTS_JOB_SETTINGS,
  secrets: ["SLACK_AGENTS_BOT_TOKEN", "KUBECONFIG_PROD", "LLM_GATEWAY_ISSUER_KEY"].filter((n) => process.env[n] !== undefined),
}));
`;

async function repo(spec: RepoSpec): Promise<string> {
  const root = makeRepo({
    ...spec,
    files: { ...TOOLS, ...spec.files },
  });
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

function after(argv: string[], flag: string): string[] {
  return argv.flatMap((a, i) => (a === flag ? [argv[i + 1]!] : []));
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

/** Stands in for the upstreams, recording each start and each call. */
function fakeUpstreams() {
  const seen: {
    starts: StartUpstreamsOptions[];
    calls: { operation: string; args: Record<string, unknown> }[];
    closed: number;
  } = { starts: [], calls: [], closed: 0 };
  const start = (o: StartUpstreamsOptions): Promise<RunningUpstreams> => {
    seen.starts.push(o);
    const upstream = {
      call: (operation: string, args: Record<string, unknown>) => {
        seen.calls.push({ operation, args });
        return Promise.resolve(`${operation} says ${String(args.text)}`);
      },
    };
    return Promise.resolve({
      upstreams: Object.fromEntries(o.servers.map((s) => [s, upstream])),
      secrets: [],
      scrub: (text) => text,
      close: () => {
        seen.closed += 1;
        return Promise.resolve();
      },
    });
  };
  return { seen, start };
}

const COLLECTING_JOB = {
  ...jobFiles("demo", {
    tools: ["podsy"],
    collect_tools: ["slacky"],
    settings: { editions_have_customers: false, label: "weekly" },
  }),
  "collect.ts": COLLECT,
};

describe("collect.ts calling tools", () => {
  it("gets its own tools server outside the data directory, with only its tools and no credential", async () => {
    const root = await repo({ jobs: { demo: COLLECTING_JOB } });
    const bin = scratch();
    const fake = fakeUpstreams();
    const opts = await options(root, {
      lbx: writeFakeLbx(bin),
      tools: {
        pollMs: 10,
        fetchServers: () => Promise.resolve(),
        startUpstreams: fake.start,
      },
      env: {
        ...ISSUER_ENV,
        SLACK_AGENTS_BOT_TOKEN: BOT_TOKEN,
        KUBECONFIG_DEV: KUBECONFIG,
        KUBECONFIG_STAGING: KUBECONFIG,
        KUBECONFIG_PROD: KUBECONFIG,
        KUBECONFIG_SHARED_SERVICES: KUBECONFIG,
        PATH: process.env.PATH ?? "",
        FAKE_LBX_ANSWER: JSON.stringify({ summary: "fine" }),
      },
    });
    const result = await runJob(opts);
    expect(result.messages[0]).toBe("demo: answer accepted.");

    // The upstreams start once, for the tools of both, before collect.ts.
    expect(fake.seen.starts.map((s) => s.servers)).toEqual([
      ["kubernetes", "slack"],
    ]);
    expect(fake.seen.closed).toBe(1);
    expect(fake.seen.calls).toEqual([
      { operation: "conversations.history", args: { text: "hello" } },
    ]);

    const files = reportFiles(opts.out!);
    const input = JSON.parse(files.get("input.json")!);
    expect(input.names).toEqual(["slacky"]);
    expect(input.ok).toEqual({
      text: "conversations.history says hello",
      truncated: false,
    });
    expect(input.refused).toBe('podsy: "podsy" is not a tool this job can use');
    expect(input.secrets).toEqual([]);
    // job.yml's settings reach collect.ts as JSON.
    expect(JSON.parse(String(input.settings))).toEqual({
      editions_have_customers: false,
      label: "weekly",
    });

    const seen = JSON.parse(readFileSync(join(bin, "seen.json"), "utf8"));
    const data = after(seen.argv, "--data")[0]!;
    const mailbox = String(input.mailbox);
    expect(relative(data, mailbox).startsWith("..")).toBe(true);
    expect(relative(join(data, ".."), mailbox)).toBe("collect/mcp");
    // The model's tools came over the tools socket, not a mailbox in the data directory.
    expect(existsSync(join(data, "mcp"))).toBe(false);

    const status = JSON.parse(files.get("status.json")!);
    expect(status.inputSource).toBe("collect");
    expect(status.collect).toEqual({ names: ["slacky"], calls: 2, ok: 1 });
    expect(status.tools).toMatchObject({ names: ["podsy"], calls: 0 });
    const record = JSON.parse(files.get("collect/tools.json")!);
    expect(record.tools).toEqual(["slacky"]);
    expect(record.limits).toEqual({ calls: 200, seconds: 60 });
    expect(
      record.calls.map((c: { tool: string; outcome: string }) => [
        c.tool,
        c.outcome,
      ]),
    ).toEqual([
      ["slacky", "ok"],
      ["podsy", "refused"],
    ]);
    expect(
      [...files.keys()].some((f) => f.startsWith("collect/mailbox/to-server/")),
    ).toBe(true);
    expect(files.get("summary.md")).toContain(
      "| Tools of collect.ts | 2 calls, 1 answered (slacky) |",
    );
    for (const [file, text] of files) {
      expect(text.includes(BOT_TOKEN), file).toBe(false);
      expect(text.includes(TEST_ISSUER_KEY), file).toBe(false);
    }
  });

  it("holds collect.ts to collect_tool_calls", async () => {
    const root = await repo({
      jobs: {
        demo: {
          ...jobFiles("demo", {
            collect_tools: ["slacky"],
            limits: {
              turns: 10,
              tokens_per_run: 1000,
              usd_per_month: 5,
              collect_tool_calls: 1,
            },
          }),
          "collect.ts": COLLECT.replace(
            '"podsy", { text: "not mine" }',
            '"slacky", { text: "again" }',
          ),
        },
      },
    });
    const fake = fakeUpstreams();
    const opts = await options(root, {
      lbx: writeFakeLbx(scratch()),
      tools: { pollMs: 10, startUpstreams: fake.start },
      env: {
        ...ISSUER_ENV,
        SLACK_AGENTS_BOT_TOKEN: BOT_TOKEN,
        PATH: process.env.PATH ?? "",
        FAKE_LBX_ANSWER: JSON.stringify({ summary: "fine" }),
      },
    });
    expect((await runJob(opts)).ok).toBe(true);
    const input = JSON.parse(reportFiles(opts.out!).get("input.json")!);
    expect(input.refused).toBe(
      "slacky: this run has used all 1 of its tool calls",
    );
    expect(fake.seen.calls).toHaveLength(1);
  });

  it("starts nothing for collect.ts in a stub run, which takes the fixture", async () => {
    const root = await repo({ jobs: { demo: COLLECTING_JOB } });
    const opts = await options(root, { stub: true });
    delete opts.launcher;
    const result = await runJob({ ...opts, env: { PATH: "/nonexistent" } });
    expect(result.messages[0]).toBe("demo: answer accepted.");
    const files = reportFiles(opts.out!);
    expect(JSON.parse(files.get("status.json")!).inputSource).toBe("fixture");
    expect(files.has("collect/tools.json")).toBe(false);
  });

  it("refuses a real run without the credentials collect.ts's tools need", async () => {
    const root = await repo({ jobs: { demo: COLLECTING_JOB } });
    const result = await runJob(
      await options(root, { env: { ...ISSUER_ENV, PATH: "" } }),
    );
    expect(result.messages[0]).toContain("SLACK_AGENTS_BOT_TOKEN");
  });

  it("checks collect_tools like tools, and needs collect.ts for them", async () => {
    const root = makeRepo({
      files: TOOLS,
      jobs: {
        nocollect: jobFiles("nocollect", { collect_tools: ["slacky"] }),
        unknown: {
          ...jobFiles("unknown", { collect_tools: ["nope"] }),
          "collect.ts": "console.log('{}');\n",
        },
      },
    });
    await generate(loadRepo(root));
    expect(formatted(await runChecks(loadRepo(root)))).toEqual([
      "jobs/nocollect/job.yml: collect_tools: names tools for collect.ts, but the job has no collect.ts",
      'jobs/unknown/job.yml: collect_tools[0]: "nope" has no directory tools/nope/',
    ]);
  });

  it("gives the workflow the secrets of collect.ts's tools too", async () => {
    const root = await repo({ jobs: { demo: COLLECTING_JOB } });
    const wf = parse(
      readFileSync(join(root, ".github/workflows/job-demo.yml"), "utf8"),
    );
    const run = wf.jobs.run.steps.find(
      (s: { name?: string }) => s.name === KIT_ACTION_STEP,
    );
    expect(Object.keys(run.env)).toEqual([
      "LLM_GATEWAY_ISSUER_KEY",
      "KUBECONFIG_DEV",
      "KUBECONFIG_STAGING",
      "KUBECONFIG_PROD",
      "KUBECONFIG_SHARED_SERVICES",
      "SLACK_AGENTS_BOT_TOKEN",
      "RUN_MODEL",
      "RUN_THINKING",
    ]);
  });
});
