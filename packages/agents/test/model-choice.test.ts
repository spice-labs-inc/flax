import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { parse } from "yaml";
import { THINKING_LEVELS, type ThinkingLevel } from "../src/lib/job.ts";
import { generate } from "../src/generate/generate.ts";
import { KIT_ACTION_STEP, renderWorkflow } from "../src/generate/render.ts";
import type { Box } from "../src/lib/box.ts";
import type { JobConfig } from "../src/lib/job.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { runJob } from "../src/run-job/run.ts";
import { BOX, jobConfig, jobFiles, makeRepo, MODEL } from "./helpers.ts";

const OTHER = "acme/other-model";
const parseWith11 = (text: string) => parse(text, { version: "1.1" });
const MODELS = [
  {
    id: MODEL,
    provider: "acme",
    usd_per_million_input: 1,
    usd_per_million_output: 2,
  },
  {
    id: OTHER,
    provider: "acme",
    usd_per_million_input: 3,
    usd_per_million_output: 4,
  },
];
const LOW_ONLY = "acme/low-only";

async function stubRun(
  model: string | undefined,
  jobOverrides = {},
  thinking?: string,
) {
  const root = makeRepo({
    jobs: { demo: jobFiles("demo", jobOverrides) },
    models: [
      ...MODELS,
      {
        id: LOW_ONLY,
        provider: "acme",
        usd_per_million_input: 1,
        usd_per_million_output: 1,
        thinking: ["off", "low"],
      },
    ],
  });
  await generate(loadRepo(root));
  const dir = mkdtempSync(join(tmpdir(), "agents-model-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return runJob({
    root,
    name: "demo",
    stub: true,
    scratch: dir,
    out: join(dir, "report"),
    env: {},
    log: () => {},
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
  });
}

describe("choosing the model for a run", () => {
  it("runs with the job's model by default", async () => {
    const result = await stubRun(undefined);
    expect(result.ok).toBe(true);
    expect(result.report!.model).toBe(MODEL);
  });

  it("runs with another model from models.yml, in Pi's command line and the report", async () => {
    const result = await stubRun(OTHER);
    expect(result.ok).toBe(true);
    expect(result.report!.model).toBe(OTHER);
    const argv = result.report!.argv;
    expect(argv[argv.indexOf("--model") + 1]).toBe(OTHER);
    expect(
      JSON.parse(readFileSync(join(result.outDir!, "status.json"), "utf8"))
        .model,
    ).toBe(OTHER);
  });

  it("refuses a model that is not in models.yml", async () => {
    const result = await stubRun("acme/not-listed");
    expect(result).toEqual({
      ok: false,
      messages: ['--model: "acme/not-listed" is not listed in models.yml'],
    });
  });

  it("checks the budget at the chosen model's price", async () => {
    // 1,000,000 tokens at $4 per million is $4, over the $3 limit; at $2 it fits.
    const limits = { turns: 10, tokens_per_run: 1000000, usd_per_month: 3 };
    expect((await stubRun(undefined, { limits })).ok).toBe(true);
    const result = await stubRun(OTHER, { limits });
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toMatch(/a run can cost up to \$4\.00/);
  });
});

describe("choosing the thinking level for a run", () => {
  it("runs with the job's level by default, in Pi's command line, status.json and summary.md", async () => {
    const result = await stubRun(undefined);
    expect(result.ok).toBe(true);
    expect(result.report!.thinking).toBe("high");
    const argv = result.report!.argv;
    expect(argv[argv.indexOf("--thinking") + 1]).toBe("high");
    expect(
      JSON.parse(readFileSync(join(result.outDir!, "status.json"), "utf8"))
        .thinking,
    ).toBe("high");
    expect(readFileSync(join(result.outDir!, "summary.md"), "utf8")).toContain(
      "| Thinking | `high` |",
    );
  });

  it("runs with another level Pi takes", async () => {
    const result = await stubRun(undefined, {}, "xhigh");
    expect(result.ok).toBe(true);
    expect(result.report!.thinking).toBe("xhigh");
    const argv = result.report!.argv;
    expect(argv.filter((a) => a === "--thinking")).toHaveLength(1);
    expect(argv[argv.indexOf("--thinking") + 1]).toBe("xhigh");
  });

  it("refuses a level Pi does not take", async () => {
    expect(await stubRun(undefined, {}, "none")).toEqual({
      ok: false,
      messages: [
        '--thinking: "none" is not a level Pi takes (off, minimal, low, medium, high, xhigh, max)',
      ],
    });
  });

  it("holds the level to the chosen model's thinking list", async () => {
    expect(await stubRun(LOW_ONLY, {}, "high")).toEqual({
      ok: false,
      messages: [
        '--thinking: "high" is not a thinking level acme/low-only takes; models.yml lists off, low',
      ],
    });
    expect(await stubRun(LOW_ONLY)).toEqual({
      ok: false,
      messages: [
        `--model: "high" is not a thinking level acme/low-only takes; models.yml lists off, low (the job's own level); pick one it takes with --thinking`,
      ],
    });
    const result = await stubRun(LOW_ONLY, {}, "off");
    expect(result.ok).toBe(true);
    expect(result.report!.thinking).toBe("off");
  });
});

describe("the model choice in generated workflows", () => {
  async function workflow(
    overrides: Record<string, unknown>,
    models: string[],
    thinkingLevels?: ThinkingLevel[],
  ): Promise<Record<string, any>> {
    return parse(
      await renderWorkflow(
        jobConfig("demo", overrides) as unknown as JobConfig,
        BOX as Box,
        [],
        models,
        thinkingLevels,
      ),
    );
  }

  it("offers models.yml and the thinking levels as choices, defaulting to the job's, and passes them to both run-job steps", async () => {
    const wf = await workflow({}, [MODEL, OTHER]);
    expect(wf.on.workflow_dispatch).toEqual({
      inputs: {
        model: {
          description: "Model for this run (models.yml)",
          type: "choice",
          options: [MODEL, OTHER],
          default: MODEL,
        },
        thinking: {
          description: "Thinking level for this run (Pi --thinking)",
          type: "choice",
          options: [...THINKING_LEVELS],
          default: "high",
        },
      },
    });
    const steps: Record<string, any>[] = wf.jobs.run.steps;
    const byName = (name: string) => steps.find((s) => s.name === name)!;
    expect(byName("Check the job and the pinned box")).toEqual({
      name: "Check the job and the pinned box",
      env: {
        RUN_MODEL: "${{ inputs.model }}",
        RUN_THINKING: "${{ inputs.thinking }}",
      },
      run: 'node dist/run-job.mjs demo --preflight --model "$RUN_MODEL" --thinking "$RUN_THINKING"',
    });
    const runStep = byName(KIT_ACTION_STEP);
    expect(runStep.env.RUN_MODEL).toBe("${{ inputs.model }}");
    expect(runStep.env.RUN_THINKING).toBe("${{ inputs.thinking }}");
    expect(runStep.with.args).toBe(
      '--model "$RUN_MODEL" --thinking "$RUN_THINKING" --out "$RUNNER_TEMP/job-output"',
    );
    // The inputs go through the environment, never into the command text.
    const runs = JSON.stringify(steps.map((s) => s.run ?? s.with?.args ?? ""));
    expect(runs).not.toContain("inputs.model");
    expect(runs).not.toContain("inputs.thinking");
  });

  it("keeps the choice on scheduled and chained jobs, which run with the job's model", async () => {
    for (const trigger of [
      { schedule: "5 4 * * *" },
      { after: "nightly" },
    ] as const) {
      const wf = await workflow({ trigger }, [MODEL, OTHER]);
      expect(wf.on.workflow_dispatch.inputs.model.default).toBe(MODEL);
    }
  });

  it("offers only the levels the models take, always with the job's own, and quotes each for YAML 1.1 readers", async () => {
    const levels: ThinkingLevel[] = ["off", "low", "xhigh"];
    const wf = await workflow({ thinking: "high" }, [MODEL], levels);
    expect(wf.on.workflow_dispatch.inputs.thinking.options).toEqual([
      "off",
      "low",
      "high",
      "xhigh",
    ]);
    const text = await renderWorkflow(
      jobConfig("demo", { thinking: "off" }) as unknown as JobConfig,
      BOX as Box,
      [],
      [MODEL],
      levels,
    );
    expect(text).toContain('          - "off"\n');
    expect(text).toContain('        default: "off"\n');
    // YAML 1.1 reads the on key itself as true.
    expect(parseWith11(text)["true"].workflow_dispatch.inputs.thinking).toEqual(
      {
        description: "Thinking level for this run (Pi --thinking)",
        type: "choice",
        options: levels,
        default: "off",
      },
    );
  });

  it("offers the levels of the usable models in generated workflows", async () => {
    const root = makeRepo({
      jobs: { demo: jobFiles("demo") },
      models: [
        { ...MODELS[0], thinking: ["low", "high"] },
        { ...MODELS[1], thinking: ["off", "high"] },
      ],
    });
    await generate(loadRepo(root));
    const wf = parse(
      readFileSync(join(root, ".github/workflows/job-demo.yml"), "utf8"),
    );
    expect(wf.on.workflow_dispatch.inputs.thinking.options).toEqual([
      "off",
      "low",
      "high",
    ]);
  });

  it("offers no choice when no models are given", async () => {
    const wf = await workflow({}, []);
    expect(wf.on.workflow_dispatch).toEqual({});
    expect(
      wf.jobs.run.steps.find((s: any) => s.name === KIT_ACTION_STEP).env,
    ).toEqual({
      LLM_GATEWAY_ISSUER_KEY: "${{ secrets.LLM_GATEWAY_ISSUER_KEY }}",
    });
  });
});
