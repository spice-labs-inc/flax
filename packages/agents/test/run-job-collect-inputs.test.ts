import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { parse } from "yaml";
import { runChecks } from "../src/check/index.ts";
import { jobOptionsCheck } from "../src/check/job-options.ts";
import {
  collectInputs,
  COLLECT_INPUTS_ENV,
  nothingToDo,
} from "../src/collect/env.ts";
import { generate } from "../src/generate/generate.ts";
import { KIT_ACTION_STEP, workflowPath } from "../src/generate/render.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { PATCH_SET_SCHEMA } from "../src/lib/schemas.ts";
import { loadRepo } from "../src/lib/repo.ts";
import {
  checkCollectInputs,
  collectInputFlags,
} from "../src/run-job/collect-inputs.ts";
import { nothingToDoReason } from "../src/run-job/input.ts";
import type { Launcher } from "../src/run-job/launcher.ts";
import { runJob, type RunOptions } from "../src/run-job/run.ts";
import { testGateway } from "./fake-gateway.ts";
import { formatted, jobFiles, makeRepo, run } from "./helpers.ts";

const WHO = { uid: process.getuid!(), home: "/nonexistent-home" };
const ATLAS = "notes-co/atlas";
const NOTHING = "no crash in the last 2 hours";
const CRASH = {
  name: "crash",
  description: "The crash to replay: service, time, optional pod",
  pattern: "^[a-z][a-z0-9-]{1,40}, [0-9T:.Z-]{10,30}(, [a-z0-9.-]{1,80})?$",
};

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "flax-agents-options-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A launcher that fails the test if the run ever starts a box. */
function noBox(): Launcher & { launched: number } {
  const l = {
    kind: "stub" as const,
    launched: 0,
    launch() {
      l.launched += 1;
      return Promise.reject(new Error("the run started a box"));
    },
  };
  return l;
}

const PR_OUTPUT = {
  kind: "pr",
  repos: [ATLAS],
  paths: ["repos/*.md"],
  max_changed_lines: 40,
  untrusted_input: "report_only",
};

function prJob(
  overrides: Record<string, unknown> = {},
  input: unknown = { pages: [] },
): Record<string, string> {
  return {
    ...jobFiles("demo", { output: PR_OUTPUT, ...overrides }),
    "output.json": JSON.stringify(PATCH_SET_SCHEMA),
    "fixtures/input.json": JSON.stringify(input),
    "fixtures/output.json": JSON.stringify({ pages: [] }),
  };
}

/** collect.ts that says it has nothing to do, naming the inputs it was given. */
const COLLECT_NOTHING = `import { collectInputs, nothingToDo } from ${JSON.stringify(join(KIT_ROOT, "src/collect/env.ts"))};
console.log(JSON.stringify({ ...nothingToDo("given " + JSON.stringify(collectInputs())), raw: process.env.${COLLECT_INPUTS_ENV} ?? null }));
`;

async function repo(jobs: Record<string, Record<string, string>>) {
  const root = makeRepo({
    jobs,
    repos: [ATLAS],
    files: { "package.json": JSON.stringify({ type: "module" }) },
  });
  await generate(loadRepo(root));
  return root;
}

async function realOptions(
  root: string,
  extra: Partial<RunOptions> = {},
): Promise<RunOptions & { gw: Awaited<ReturnType<typeof testGateway>> }> {
  const dir = scratch();
  const gw = await testGateway();
  return {
    root,
    name: "demo",
    scratch: dir,
    out: join(dir, "report"),
    env: { ...gw.env, PATH: process.env.PATH ?? "" },
    identity: WHO,
    log: () => {},
    gateway: gw.gateway,
    socketBases: [scratch()],
    gw,
    ...extra,
  };
}

function status(out: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(out, "status.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("a run whose collect.ts has nothing to do", () => {
  it("calls no model, issues no key, records the reason and passes", async () => {
    const root = await repo({
      demo: { ...prJob(), "collect.ts": COLLECT_NOTHING },
    });
    const launcher = noBox();
    const opts = await realOptions(root, { launcher });
    const result = await runJob(opts);
    expect(result.ok).toBe(true);
    expect(result.messages[0]).toBe("demo: nothing to do: given {}");
    expect(launcher.launched).toBe(0);
    expect(opts.gw.fake.issued).toEqual([]);
    const s = status(opts.out!);
    expect(s.nothingToDo).toEqual({ reason: "given {}" });
    expect(s.inputSource).toBe("collect");
    expect(s.delivery).toBeUndefined();
    expect(existsSync(join(opts.out!, "answer.json"))).toBe(false);
    expect(readFileSync(join(opts.out!, "summary.md"), "utf8")).toContain(
      "| Nothing to do | given \\{\\}; no model ran |",
    );
  });

  it("works the same from a stub run's fixture, for a slack job too", async () => {
    const root = await repo({
      demo: {
        ...jobFiles("demo", {
          output: { kind: "slack", channel: "agents-shadow" },
        }),
        "fixtures/input.json": JSON.stringify(nothingToDo(NOTHING)),
      },
    });
    const dir = scratch();
    const result = await runJob({
      root,
      name: "demo",
      stub: true,
      scratch: dir,
      out: join(dir, "report"),
      identity: WHO,
      log: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.messages[0]).toBe(`demo: nothing to do: ${NOTHING}`);
    expect(result.report?.slack).toBeUndefined();
    expect(existsSync(join(dir, "report", "slack.json"))).toBe(false);
  });

  it("fails on a reason that is not one short line", async () => {
    const root = await repo({
      demo: prJob({}, { nothing_to_do: "two\nlines" }),
    });
    const dir = scratch();
    const result = await runJob({
      root,
      name: "demo",
      stub: true,
      scratch: dir,
      identity: WHO,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toBe(
      "demo: the input's nothing_to_do must be one line of at most 500 characters",
    );
  });

  it("is read only from a top-level nothing_to_do", () => {
    expect(nothingToDoReason({ pages: [] })).toBeUndefined();
    expect(nothingToDoReason([NOTHING])).toBeUndefined();
    expect(nothingToDoReason({ data: { nothing_to_do: NOTHING } })).toBe(
      undefined,
    );
    expect(nothingToDoReason({ nothing_to_do: ` ${NOTHING} ` })).toEqual({
      reason: NOTHING,
    });
    expect(nothingToDoReason({ nothing_to_do: 3 })).toHaveProperty("error");
    expect(
      nothingToDoReason({ nothing_to_do: "x".repeat(501) }),
    ).toHaveProperty("error");
  });

  it("is never in the input of a job shipped today, which therefore runs as before", () => {
    for (const job of loadRepo(FIXTURE_WORKSPACE).jobs) {
      const fixture = join(
        FIXTURE_WORKSPACE,
        "jobs",
        job.name,
        "fixtures/input.json",
      );
      if (!existsSync(fixture)) continue;
      expect(
        nothingToDoReason(JSON.parse(readFileSync(fixture, "utf8"))),
        job.name,
      ).toBeUndefined();
    }
  });
});

describe("collect inputs", () => {
  it("reach collect.ts as JSON when filled in, and are left out when empty", async () => {
    const root = await repo({
      demo: {
        ...prJob({ collect_inputs: [CRASH] }),
        "collect.ts": COLLECT_NOTHING,
      },
    });
    const opts = await realOptions(root, {
      launcher: noBox(),
      collectInputs: { crash: "engine, 2026-10-07T09:02:00Z, engine-7d9f" },
    });
    const result = await runJob(opts);
    expect(result.ok).toBe(true);
    const input = JSON.parse(
      readFileSync(join(opts.out!, "input.json"), "utf8"),
    ) as { raw: string };
    expect(JSON.parse(input.raw)).toEqual({
      crash: "engine, 2026-10-07T09:02:00Z, engine-7d9f",
    });
    expect(status(opts.out!).collectInputs).toEqual({
      crash: "engine, 2026-10-07T09:02:00Z, engine-7d9f",
    });

    const empty = await realOptions(root, {
      launcher: noBox(),
      collectInputs: { crash: "" },
    });
    expect((await runJob(empty)).ok).toBe(true);
    const raw = JSON.parse(
      readFileSync(join(empty.out!, "input.json"), "utf8"),
    ) as { raw: unknown };
    expect(raw.raw).toBeNull();
    expect(status(empty.out!).collectInputs).toBeUndefined();
  });

  it("refuse a value off the pattern, a name job.yml does not declare, and a replay", async () => {
    const root = await repo({
      demo: {
        ...prJob({ collect_inputs: [CRASH] }),
        "collect.ts": COLLECT_NOTHING,
      },
    });
    const bad = await runJob(
      await realOptions(root, { collectInputs: { crash: "engine; rm -rf /" } }),
    );
    expect(bad.messages[0]).toBe(
      `the collect input crash does not match its pattern ${CRASH.pattern}`,
    );
    const unknown = await runJob(
      await realOptions(root, { collectInputs: { pod: "x" } }),
    );
    expect(unknown.messages[0]).toBe(
      "pod is not a collect input of demo (collect_inputs in its job.yml)",
    );
    const replay = await runJob(
      await realOptions(root, {
        replay: 12,
        collectInputs: { crash: "engine, 2026-10-07T09:02:00Z" },
      }),
    );
    expect(replay.messages[0]).toBe(
      "--collect-input is for a run that collects: a revision or a replay reads an earlier run's input",
    );
  });

  it("parse from the command line and from collect.ts's environment", () => {
    expect(collectInputFlags(["crash=a=b", "pod="])).toEqual({
      crash: "a=b",
      pod: "",
    });
    expect(() => collectInputFlags(["crash"])).toThrow(
      '--collect-input takes <name>=<value>, not "crash"',
    );
    expect(() => collectInputFlags(["a=1", "a=2"])).toThrow(
      "--collect-input a is given more than once",
    );
    expect(collectInputs({})).toEqual({});
    expect(collectInputs({ [COLLECT_INPUTS_ENV]: '{"crash":"x"}' })).toEqual({
      crash: "x",
    });
    expect(() =>
      collectInputs({ [COLLECT_INPUTS_ENV]: '{"crash":1}' }),
    ).toThrow();
    expect(
      checkCollectInputs(
        { name: "demo", collect_inputs: [CRASH] },
        { crash: "engine, 2026-10-07T09:02:00Z\u0007" },
      ),
    ).toEqual({
      error:
        "the collect input crash must be at most 200 printable ASCII characters",
    });
  });

  it("become string inputs of the workflow, passed to the run step through the environment", async () => {
    const root = await repo({
      demo: {
        ...prJob({ collect_inputs: [CRASH] }),
        "collect.ts": COLLECT_NOTHING,
      },
    });
    const wf = parse(
      readFileSync(join(root, workflowPath("demo")), "utf8"),
    ) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
      jobs: Record<
        string,
        {
          steps: {
            name?: string;
            env?: Record<string, string>;
            run?: string;
            with?: Record<string, string>;
          }[];
        }
      >;
    };
    expect(wf.on.workflow_dispatch.inputs.crash).toEqual({
      description: CRASH.description,
      type: "string",
      required: false,
      default: "",
    });
    const step = Object.values(wf.jobs)
      .flatMap((j) => j.steps)
      .find((s) => s.name === KIT_ACTION_STEP)!;
    expect(step.env!.RUN_COLLECT_INPUT_CRASH).toBe("${{ inputs.crash }}");
    expect(step.with!.args).toContain(
      ' --collect-input "crash=$RUN_COLLECT_INPUT_CRASH"',
    );
    expect(await runChecks(loadRepo(root))).toEqual([]);
  });

  it("are refused by flax agents check without collect.ts, for a job with model none, and under a kit input's name", async () => {
    const root = makeRepo({
      jobs: {
        nocollect: jobFiles("nocollect", { collect_inputs: [CRASH] }),
        clash: {
          ...jobFiles("clash", {
            collect_inputs: [{ ...CRASH, name: "revise" }, CRASH, CRASH],
          }),
          "collect.ts": "console.log('{}');\n",
        },
        badre: {
          ...jobFiles("badre", {
            collect_inputs: [{ ...CRASH, pattern: "^(unclosed$" }],
          }),
          "collect.ts": "console.log('{}');\n",
        },
        many: {
          ...jobFiles("many", {
            output: PR_OUTPUT,
            media: {
              network: "public",
              secrets: [],
              timeout_minutes: 5,
              model: { model: "acme/test-model", usd_per_run: 1 },
            },
            collect_inputs: ["a", "b", "c", "d"].map((n) => ({
              ...CRASH,
              name: n,
            })),
          }),
          "collect.ts": "console.log('{}');\n",
        },
      },
    });
    expect(await run(jobOptionsCheck, root)).toEqual([
      "jobs/badre/job.yml: collect_inputs[0].pattern: is not a regular expression JavaScript takes",
      "jobs/clash/job.yml: collect_inputs[0].name: revise is a workflow input the job already has; name it otherwise",
      "jobs/clash/job.yml: collect_inputs[2].name: crash is listed twice",
      "jobs/many/job.yml: collect_inputs: the workflow would have 11 inputs with the kit's own 7; GitHub takes at most 10",
      "jobs/nocollect/job.yml: collect_inputs: has collect inputs, but the job has no collect.ts to read them",
    ]);
  });

  it("are in no job shipped today but the crash investigator's replay input, and every shipped job passes the check", async () => {
    const repo = loadRepo(FIXTURE_WORKSPACE);
    for (const job of repo.jobs)
      if (job.name === "crash-investigator")
        expect(job.config?.collect_inputs?.map((i) => i.name)).toEqual([
          "crash",
        ]);
      else expect(job.config?.collect_inputs, job.name).toBeUndefined();
    expect(formatted(await jobOptionsCheck.run(repo))).toEqual([]);
  });
});
