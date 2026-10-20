import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { generate } from "../src/generate/generate.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { memoryLedger } from "../src/run-job/budget.ts";
import {
  LbxLauncher,
  StubLauncher,
  type LaunchRequest,
  type LaunchResult,
  type Launcher,
} from "../src/run-job/launcher.ts";
import {
  REPAIR_TIMEOUT_SECONDS,
  repairSeconds,
  sizeNotes,
} from "../src/run-job/repair.ts";
import { runJob, type RunOptions } from "../src/run-job/run.ts";
import { TEST_ISSUER_KEY, testGateway } from "./fake-gateway.ts";
import { writeFakeLbx } from "./fake-lbx.ts";
import { BOX, FIXTURE_WORKSPACE, jobFiles, makeRepo, type RepoSpec } from "./helpers.ts";

// Built at runtime so no key-shaped literal sits in the source.
const SECRET = ["gateway", "issuer", "key", "9f8e7d6c5b4a"].join("-");
const WHO = { uid: process.getuid!(), home: "/nonexistent-home" };

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-run-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function repo(
  spec: RepoSpec = { jobs: { demo: jobFiles("demo") } },
): Promise<string> {
  const root = makeRepo(spec);
  await generate(loadRepo(root));
  return root;
}

function options(root: string, extra: Partial<RunOptions> = {}): RunOptions {
  const dir = scratch();
  return {
    root,
    name: "demo",
    scratch: dir,
    out: join(dir, "report"),
    env: { LLM_GATEWAY_ISSUER_KEY: SECRET },
    identity: WHO,
    socketBases: [scratch()],
    log: () => {},
    // Keeps the stand-in lbx's output out of the test log.
    ...(extra.stub
      ? {}
      : { launcher: new LbxLauncher(new PassThrough(), new PassThrough()) }),
    ...extra,
  };
}

/** A real run's options: a fake gateway to issue its key, and the issuer key in the environment. */
async function realOptions(
  root: string,
  extra: Partial<RunOptions> = {},
): Promise<RunOptions> {
  const gw = await testGateway();
  return options(root, {
    gateway: gw.gateway,
    ...extra,
    env: { PATH: process.env.PATH ?? "", ...gw.env, ...extra.env },
  });
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

describe("flax agents run-job --stub", () => {
  it("runs a job end to end offline and writes the report", async () => {
    const opts = options(await repo(), { stub: true });
    const result = await runJob(opts);
    expect(result.ok).toBe(true);
    const files = reportFiles(opts.out!);
    expect([...files.keys()].sort()).toEqual([
      "answer.json",
      "answer.txt",
      "argv.json",
      "input.json",
      "maintainer-notes.json",
      "status.json",
      "summary.md",
      "timings.json",
    ]);
    expect(JSON.parse(files.get("answer.json")!)).toEqual({ summary: "hi" });
    expect(JSON.parse(files.get("maintainer-notes.json")!)).toEqual({
      job: "demo",
      runName: expect.stringMatching(/^job-demo-/),
      model: "acme/test-model",
      notes: [],
    });
    expect(JSON.parse(files.get("input.json")!)).toEqual({ text: "hello" });
    const status = JSON.parse(files.get("status.json")!);
    expect(status).toMatchObject({
      job: "demo",
      mode: "shadow",
      launcher: "stub",
      ok: true,
      inputSource: "fixture",
      answerProblems: [],
      launch: { status: { status: "exited", code: 0 } },
      budget: { ledger: "none", spentUsd: 0 },
    });
    const argv: string[] = JSON.parse(files.get("argv.json")!);
    expect(argv.slice(0, 2)).toEqual(["lbx", "--run"]);
    expect(argv[argv.indexOf("--timeout") + 1]).toBe("600");
    expect(
      JSON.parse(files.get("timings.json")!).map(
        (t: { step: string }) => t.step,
      ),
    ).toEqual(["load", "budget", "input", "run", "validate"]);
  });

  it("never puts a secret value in argv or any report file", async () => {
    const opts = options(await repo(), { stub: true });
    await runJob(opts);
    for (const [file, text] of reportFiles(opts.out!)) {
      expect(text.includes(SECRET), file).toBe(false);
    }
  });

  it("works from the command line, without docker or network", () => {
    const dir = scratch();
    const cli = spawnSync(
      process.execPath,
      [
        join(KIT_ROOT, "bin", "flax-agents.mjs"),
        "run-job",
        "hello",
        "--workspace",
        FIXTURE_WORKSPACE,
        "--stub",
        "--scratch",
        dir,
        "--out",
        join(dir, "out"),
      ],
      { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } },
    );
    expect(cli.stderr).toBe("");
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain("hello: answer accepted.");
    expect(readdirSync(join(dir, "out"))).toContain("answer.json");
  });

  it("exits 2 with usage on bad arguments", () => {
    const cli = spawnSync(
      process.execPath,
      [join(KIT_ROOT, "bin", "flax-agents.mjs"), "run-job", "hello", "extra", "--workspace", FIXTURE_WORKSPACE],
      { cwd: scratch(), encoding: "utf8" },
    );
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain("usage: flax agents run-job <name>");
  });
});

describe("flax agents run-job refusals", () => {
  it("refuses an unknown job and a tree flax agents check rejects", async () => {
    const root = await repo();
    expect((await runJob(options(root, { name: "nope" }))).messages).toEqual([
      'no job named "nope" under jobs/',
    ]);
    writeFileSync(join(root, "JOBS.md"), "edited\n");
    expect((await runJob(options(root, { stub: true }))).messages).toEqual([
      "JOBS.md: is out of date or was edited by hand; run flax agents generate",
    ]);
  });

  it("refuses live mode for a job that neither opens pull requests nor posts to Slack", async () => {
    const links = Array.from(
      { length: 10 },
      (_, i) =>
        `- https://github.com/notes-co/agents/actions/runs/${i + 1}`,
    ).join("\n");
    const root = await repo({
      jobs: {
        demo: {
          ...jobFiles("demo", { mode: "live" }),
          "SHADOW_RUNS.md": links,
        },
      },
    });
    const result = await runJob(options(root, { stub: true }));
    expect(result.ok).toBe(false);
    expect(result.messages).toEqual([
      "jobs/demo/job.yml: mode: live runs deliver pull requests (output kind pr), Slack messages (output kind slack) or private YouTube uploads (output kind youtube); a file job has nothing to deliver and stays in shadow",
    ]);
  });

  it("refuses a real run while the box is not pinned, but a stub run goes ahead", async () => {
    const root = await repo({
      jobs: { demo: jobFiles("demo") },
      box: { ...BOX, pinned: false },
    });
    const real = await runJob(options(root));
    expect(real.ok).toBe(false);
    expect(real.messages[0]).toMatch(
      /^box\.yml: pinned: is false, so job runs are refused/,
    );
    expect((await runJob(options(root, { stub: true }))).ok).toBe(true);
  });

  it("refuses a real run without the issuer key or a place for the run directory", async () => {
    const root = await repo();
    expect((await runJob(options(root, { env: {} }))).messages).toEqual([
      "LLM_GATEWAY_ISSUER_KEY is not set; the model gateway needs it to issue the run's key",
    ]);
    const { scratch: _unused, ...noScratch } = await realOptions(root, {
      lbx: writeFakeLbx(scratch()),
    });
    expect((await runJob(noScratch)).messages).toEqual([
      "set RUNNER_TEMP or pass --scratch <dir> for the run directory",
    ]);
  });

  it("refuses when the month's spend plus the worst case of one run passes the limit", async () => {
    const root = await repo();
    const now = () => new Date("2026-09-25T12:00:00Z");
    const ledger = memoryLedger([
      { job: "demo", month: "2026-09", runName: "x", usd: 5 },
    ]);
    const result = await runJob(options(root, { stub: true, ledger, now }));
    expect(result.messages).toEqual([
      "demo has spent $5.00 of its $5 in 2026-09; a run can cost up to $0.00",
    ]);
    const fresh = memoryLedger([
      { job: "demo", month: "2026-08", runName: "x", usd: 5 },
    ]);
    expect(
      (await runJob(options(root, { stub: true, ledger: fresh, now }))).ok,
    ).toBe(true);
    // A stub run calls no model, so it spends nothing.
    expect(fresh.entries).toHaveLength(1);
  });

  it("--preflight checks everything and starts nothing", async () => {
    const opts = options(await repo(), { preflight: true });
    const result = await runJob(opts);
    expect(result).toEqual({
      ok: true,
      messages: [`demo: ready to run (mode shadow, box ${BOX.box_commit}).`],
    });
    expect(readdirSync(opts.scratch!)).toEqual([]);
  });
});

describe("answers", () => {
  it("fails a run whose answer does not match output.json, keeping the raw answer", async () => {
    const opts = options(await repo(), {
      stub: true,
      launcher: new StubLauncher('{"summary": 3}'),
    });
    const result = await runJob(opts);
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toBe(
      "demo: the answer does not match jobs/demo/output.json (1 problem); no repair turn: the run left no Pi session to continue",
    );
    const files = reportFiles(opts.out!);
    expect(files.get("answer.txt")).toBe('{"summary": 3}');
    expect(files.has("answer.json")).toBe(false);
    expect(JSON.parse(files.get("status.json")!).answerProblems).toEqual([
      "summary: must be string",
    ]);
    expect(files.get("summary.md")).toContain("- summary: must be string");
  });

  it("fails a run whose answer is not JSON", async () => {
    const result = await runJob(
      options(await repo(), {
        stub: true,
        launcher: new StubLauncher("I could not do it."),
      }),
    );
    expect(result.messages[0]).toMatch(/^demo: the answer is not JSON: /);
  });

  it("delivers a complete answer followed by a broken fragment, recording what was ignored", async () => {
    const lines: string[] = [];
    const opts = options(await repo(), {
      stub: true,
      launcher: new StubLauncher('{"summary": "hi"}\n  },\n  {"left": "over"'),
      log: (line) => lines.push(line),
    });
    const result = await runJob(opts);
    expect(result.ok).toBe(true);
    const warning =
      'text after the answer was ignored: 20 characters, starting "},\\n  {\\"left\\": \\"over\\""';
    expect(lines).toContain(`warning: ${warning}`);
    const files = reportFiles(opts.out!);
    expect(JSON.parse(files.get("answer.json")!)).toEqual({ summary: "hi" });
    const status = JSON.parse(files.get("status.json")!);
    expect(status.answerWarning).toBe(warning);
    expect(status.repair).toBeUndefined();
    expect(files.get("summary.md")).toContain(
      "| Answer | text after the answer was ignored\\: 20 characters, starting",
    );
  });

  it("fails a run whose answer is two JSON values", async () => {
    const result = await runJob(
      options(await repo(), {
        stub: true,
        launcher: new StubLauncher('{"summary": "a"}\n{"summary": "b"}'),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toMatch(
      /^demo: the answer is two JSON values, one after the other/,
    );
  });

  it("redacts a leaked key and fails the run", async () => {
    const opts = options(await repo(), {
      stub: true,
      launcher: new StubLauncher(
        JSON.stringify({ summary: `the key is ${SECRET}` }),
      ),
    });
    const result = await runJob(opts);
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toContain(
      "a secret value appeared in the run's output",
    );
    for (const [file, text] of reportFiles(opts.out!))
      expect(text.includes(SECRET), file).toBe(false);
    expect(reportFiles(opts.out!).get("answer.json")).toContain("[redacted]");
  });

  it("appends a summary to the Actions job page", async () => {
    const dir = scratch();
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    const opts = options(await repo(), {
      stub: true,
      env: {
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_RUN_ID: "77",
        GITHUB_RUN_ATTEMPT: "1",
      },
    });
    await runJob(opts);
    const text = readFileSync(summary, "utf8");
    expect(text).toContain("### demo: answer accepted");
    expect(text).toContain("`job-demo-77-1`");
  });
});

describe("real launcher against a stand-in lbx", () => {
  async function realRun(env: Record<string, string>) {
    const root = await repo();
    const bin = scratch();
    const lbx = writeFakeLbx(bin);
    const ledger = memoryLedger();
    const opts = await realOptions(root, { lbx, ledger, env });
    const result = await runJob(opts);
    const seen = JSON.parse(readFileSync(join(bin, "seen.json"), "utf8"));
    return { result, seen, ledger, files: reportFiles(opts.out!) };
  }

  it("hands lbx the argv and the config, never a key, then validates the answer", async () => {
    const { result, seen, ledger, files } = await realRun({
      FAKE_LBX_ANSWER: '{"summary":"from the box"}',
    });
    expect(result.messages[0]).toBe("demo: answer accepted.");
    expect(seen.hasIssuerKey).toBe(false);
    expect(seen.envNames).not.toContain("ACME_API_KEY");
    for (const [file, text] of files)
      expect(text.includes(TEST_ISSUER_KEY), file).toBe(false);
    expect(seen.config).toBe(`image.docker=${BOX.image}\n`);
    expect(seen.argv).not.toContain("--env");
    expect(seen.argv).toContain("--no-network");
    expect(JSON.parse(files.get("answer.json")!)).toEqual({
      summary: "from the box",
    });
    expect(files.has("deny.log")).toBe(false);
    expect(files.get("transcript/s.jsonl")).toBe('{"type":"session"}\n');
    expect(JSON.parse(files.get("status.json")!).launch.statusSource).toBe(
      "file",
    );
    expect(ledger.entries).toHaveLength(1);
  });

  it("fails on a timeout and still records the spend", async () => {
    const { result, ledger } = await realRun({
      FAKE_LBX_STATUS: "status=timeout code=124",
    });
    expect(result.messages[0]).toBe(
      "demo: lbx reported status=timeout code=124",
    );
    expect(ledger.entries).toHaveLength(1);
  });

  it("fails when Pi exits non-zero", async () => {
    const { result } = await realRun({
      FAKE_LBX_STATUS: "status=exited code=1",
    });
    expect(result.messages[0]).toBe("demo: Pi exited with code 1");
  });

  it("fails when lbx could not remove everything the run created", async () => {
    const { result } = await realRun({
      FAKE_LBX_ANSWER: '{"summary":"ok"}',
      FAKE_LBX_STATUS: "status=exited code=0 cleanup=incomplete",
    });
    expect(result.messages[0]).toBe(
      "demo: lbx could not remove everything this run created; its standard error names the leftovers",
    );
  });
  it("fails when the command wrote no answer", async () => {
    const { result } = await realRun({});
    expect(result.messages[0]).toBe("demo: the answer file does not exist");
  });
});

describe("collect.ts", () => {
  const collect =
    'console.log(JSON.stringify({ text: "collected", key: process.env.LLM_GATEWAY_ISSUER_KEY ?? null }));\n';

  it("gathers the input outside the box in real runs, without the issuer key", async () => {
    const root = await repo({
      jobs: { demo: { ...jobFiles("demo"), "collect.ts": collect } },
    });
    const bin = scratch();
    const opts = await realOptions(root, {
      lbx: writeFakeLbx(bin),
      env: { FAKE_LBX_ANSWER: '{"summary":"x"}' },
    });
    const result = await runJob(opts);
    expect(result.ok).toBe(true);
    expect(result.report?.inputSource).toBe("collect");
    const data = JSON.parse(readFileSync(join(bin, "seen.json"), "utf8")).argv;
    const dataDir = data[data.indexOf("--data") + 1];
    expect(
      JSON.parse(readFileSync(join(dataDir, "input.json"), "utf8")),
    ).toEqual({
      text: "collected",
      key: null,
    });
  });

  it("is skipped in stub runs, which use the fixture", async () => {
    const root = await repo({
      jobs: { demo: { ...jobFiles("demo"), "collect.ts": collect } },
    });
    const result = await runJob(options(root, { stub: true }));
    expect(result.report?.inputSource).toBe("fixture");
  });

  it("fails the run when collect.ts fails or prints something other than JSON", async () => {
    const root = await repo({
      jobs: {
        demo: {
          ...jobFiles("demo"),
          "collect.ts": 'console.log("not json");\n',
        },
      },
    });
    const result = await runJob(
      await realOptions(root, { lbx: writeFakeLbx(scratch()) }),
    );
    expect(result.messages[0]).toMatch(
      /^demo: the output of jobs\/demo\/collect\.ts is not valid JSON: /,
    );
  });
});

/** Plays Pi across the run and its repair turn: each launch writes the next answer and keeps the session file, and records what it was given. */
class SessionLauncher implements Launcher {
  readonly kind = "stub";
  readonly seen: {
    runName: string;
    argv: readonly string[];
    repair?: string;
  }[] = [];

  private readonly answers: string[];

  constructor(...answers: string[]) {
    this.answers = answers;
  }

  launch(request: LaunchRequest): Promise<LaunchResult> {
    const data = dirname(request.answerPath);
    const repair = join(data, "repair.md");
    this.seen.push({
      runName: request.runName,
      argv: request.argv,
      ...(existsSync(repair) ? { repair: readFileSync(repair, "utf8") } : {}),
    });
    mkdirSync(join(data, "session"), { recursive: true });
    appendFileSync(
      join(data, "session", "2026-10-08T12-00-00-000Z_s.jsonl"),
      `{"type":"turn","n":${this.seen.length}}\n`,
    );
    writeFileSync(request.answerPath, this.answers.shift() ?? "");
    return Promise.resolve({
      exitCode: 0,
      status: { status: "exited", code: 0 },
      statusSource: "file",
    });
  }
}

describe("the repair turn", () => {
  it("sends an answer that does not match output.json back to the same Pi session once, with the problems, and goes on with the repaired answer", async () => {
    const launcher = new SessionLauncher(
      '{"summary": 3}',
      '{"summary": "fixed"}',
    );
    const opts = options(await repo(), { stub: true, launcher });
    const result = await runJob(opts);
    expect(result.messages[0]).toBe("demo: answer accepted.");
    expect(launcher.seen.map((s) => s.runName)).toEqual([
      expect.stringMatching(/^job-demo-[^-]+$/),
      expect.stringMatching(/^job-demo-.+-repair$/),
    ]);
    const argv = launcher.seen[1]!.argv;
    const tail = argv.slice(argv.indexOf("--tools") + 2);
    expect(tail).toEqual([
      "--session",
      "/data/session/2026-10-08T12-00-00-000Z_s.jsonl",
      "@/data/repair.md",
    ]);
    expect(argv).not.toContain("@/data/prompt.md");
    expect(launcher.seen[1]!.repair).toContain("- summary: must be string\n");
    const files = reportFiles(opts.out!);
    expect(files.get("answer.txt")).toBe('{"summary": 3}');
    expect(files.get("repair/answer.txt")).toBe('{"summary": "fixed"}');
    expect(files.get("repair/prompt.md")).toBe(launcher.seen[1]!.repair);
    expect(
      files.get("repair/transcript/2026-10-08T12-00-00-000Z_s.jsonl"),
    ).toBe('{"type":"turn","n":1}\n{"type":"turn","n":2}\n');
    expect(JSON.parse(files.get("answer.json")!)).toEqual({ summary: "fixed" });
    const status = JSON.parse(files.get("status.json")!);
    expect(status.answerProblems).toEqual([]);
    expect(status.repair).toEqual({
      problems: ["summary: must be string"],
      outcome: "repaired",
    });
    expect(files.get("summary.md")).toContain(
      "| Repair turn | repaired 1 problem in the first answer; the first answer is answer.txt, the repaired one repair/answer.txt |",
    );
    expect(
      JSON.parse(files.get("timings.json")!).map(
        (t: { step: string }) => t.step,
      ),
    ).toEqual(["load", "budget", "input", "run", "validate", "repair"]);
  });

  it("repairs an answer that is not JSON, and tells the model the size of a value over its limit", async () => {
    const launcher = new SessionLauncher(
      "Here it is: summary is hi",
      '{"summary": "hi"}',
    );
    const result = await runJob(
      options(await repo(), { stub: true, launcher }),
    );
    expect(result.ok).toBe(true);
    expect(launcher.seen[1]!.repair).toContain(
      "It could not be read as one JSON object:\n\n- the answer is not JSON: ",
    );
    expect(
      sizeNotes(
        { summary: "x".repeat(12) },
        {
          type: "object",
          properties: { summary: { type: "string", maxLength: 10 } },
        },
      ),
    ).toEqual(["summary has 12 characters"]);
  });

  it("repairs at most once, and fails the run as before when the repaired answer does not match either", async () => {
    const launcher = new SessionLauncher(
      '{"summary": 3}',
      '{"summary": 4}',
      '{"summary": "never asked for"}',
    );
    const opts = options(await repo(), { stub: true, launcher });
    const result = await runJob(opts);
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toBe(
      "demo: the answer does not match jobs/demo/output.json (1 problem), also after the repair turn",
    );
    expect(launcher.seen).toHaveLength(2);
    const status = JSON.parse(reportFiles(opts.out!).get("status.json")!);
    expect(status.repair).toEqual({
      problems: ["summary: must be string"],
      outcome: "failed",
      problemsAfter: ["summary: must be string"],
    });
  });

  it("does not start when the writer used up the run's time limit", () => {
    expect(repairSeconds(600, 100_000)).toBe(500);
    expect(repairSeconds(6000, 1_362_000)).toBe(REPAIR_TIMEOUT_SECONDS);
    expect(repairSeconds(600, 500_000)).toBe(0);
  });
});
