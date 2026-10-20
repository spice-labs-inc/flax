import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { generate } from "../src/generate/generate.ts";
import { renderWorkflow } from "../src/generate/render.ts";
import { allowlistsCheck } from "../src/check/allowlists.ts";
import type { Model } from "../src/lib/allowlists.ts";
import type { ModelJobConfig } from "../src/lib/job.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { chooseModel } from "../src/run-job/model-choice.ts";
import { runJob } from "../src/run-job/run.ts";
import {
  BOX,
  jobConfig,
  jobFiles,
  makeRepo,
  run as runCheck,
} from "./helpers.ts";

const SMALL: Model = {
  id: "anthropic/small-model",
  provider: "anthropic",
  usd_per_million_input: 1,
  usd_per_million_output: 5,
  thinking: ["off"],
};
const LARGE: Model = {
  id: "anthropic/large-model",
  provider: "anthropic",
  usd_per_million_input: 2,
  usd_per_million_output: 10,
  thinking: ["low", "high"],
};
const MODELS = [SMALL, LARGE];
const CHOICES = [
  { model: SMALL.id, thinking: "off" },
  { model: LARGE.id, thinking: "high" },
];

function config(extra: Partial<ModelJobConfig> = {}): ModelJobConfig {
  return {
    ...(jobConfig("demo", {
      model: SMALL.id,
      thinking: "off",
      models: CHOICES,
    }) as unknown as ModelJobConfig),
    ...extra,
  };
}

function withoutModels(): ModelJobConfig {
  const { models: _models, ...rest } = config();
  return rest;
}

describe("choosing the run's model", () => {
  it("takes the model collect.ts names from the job's models, with that entry's thinking level and reason", () => {
    const got = chooseModel({
      config: config(),
      current: SMALL,
      models: MODELS,
      input: { model: LARGE.id, model_reason: "one large change" },
      overridden: false,
    });
    expect(got).toEqual({
      ok: true,
      chosen: {
        model: LARGE,
        thinking: "high",
        changed: true,
        reason: "one large change",
      },
    });
  });

  it("keeps the job's model when the input names none, the job lists no models, or the run picked one by hand", () => {
    for (const [cfg, input, overridden] of [
      [config(), { text: "hello" }, false],
      [withoutModels(), { model: LARGE.id }, false],
      [config(), { model: LARGE.id }, true],
    ] as const) {
      const got = chooseModel({
        config: cfg,
        current: SMALL,
        models: MODELS,
        input,
        overridden,
      });
      expect(got).toEqual({
        ok: true,
        chosen: { model: SMALL, thinking: "off", changed: false },
      });
    }
  });

  it("refuses a model the job does not list", () => {
    const got = chooseModel({
      config: config(),
      current: SMALL,
      models: MODELS,
      input: { model: "anthropic/claude-opus-5-5" },
      overridden: false,
    });
    expect(got).toEqual({
      ok: false,
      error:
        'collect.ts chose the model "anthropic/claude-opus-5-5", which demo\'s models does not list (anthropic/small-model, anthropic/large-model)',
    });
  });
});

describe("a job's models in flax agents check", () => {
  it("must be listed, take their thinking levels and include the default", async () => {
    const root = makeRepo({
      models: MODELS,
      jobs: {
        demo: jobFiles("demo", {
          model: SMALL.id,
          thinking: "off",
          models: [
            { model: SMALL.id, thinking: "off" },
            { model: LARGE.id, thinking: "off" },
            { model: "anthropic/unknown", thinking: "high" },
          ],
        }),
      },
    });
    const messages = await runCheck(allowlistsCheck, root);
    expect(
      messages.some((m) =>
        m.includes('"anthropic/unknown" is not listed in models.yml'),
      ),
    ).toBe(true);
    expect(messages.some((m) => m.includes("models[1].thinking"))).toBe(true);
    const good = makeRepo({
      models: MODELS,
      jobs: {
        demo: jobFiles("demo", {
          model: SMALL.id,
          thinking: "off",
          models: CHOICES,
        }),
      },
    });
    expect(await runCheck(allowlistsCheck, good)).toEqual([]);
    const noDefault = makeRepo({
      models: MODELS,
      jobs: {
        demo: jobFiles("demo", {
          model: LARGE.id,
          thinking: "low",
          models: CHOICES,
        }),
      },
    });
    expect(await runCheck(allowlistsCheck, noDefault)).toEqual([
      "jobs/demo/job.yml: models: model and thinking (anthropic/large-model at low) must be one of the models entries: they are the default choice",
    ]);
  });

  it("gives a hand-started run an auto choice that leaves the model to collect.ts", async () => {
    const withChoices = await renderWorkflow(
      config(),
      BOX,
      [],
      [SMALL.id, LARGE.id],
      ["off", "low", "high"],
    );
    expect(withChoices).toContain("- auto");
    expect(withChoices).toMatch(/model:[\s\S]*?default: auto/);
    const without = await renderWorkflow(
      withoutModels(),
      BOX,
      [],
      [SMALL.id, LARGE.id],
      ["off", "low", "high"],
    );
    expect(without).not.toContain("- auto");
    expect(without).toContain(`default: ${SMALL.id}`);
  });
});

describe("a run of a job with models", () => {
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "agents-choice-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  async function run(input: unknown, model?: string) {
    const root = makeRepo({
      models: MODELS,
      jobs: {
        demo: {
          ...jobFiles("demo", {
            model: SMALL.id,
            thinking: "off",
            models: CHOICES,
            limits: { turns: 10, tokens_per_run: 100000, usd_per_month: 5 },
          }),
          "fixtures/input.json": JSON.stringify(input),
        },
      },
    });
    await generate(loadRepo(root));
    const dir = scratch();
    const result = await runJob({
      root,
      name: "demo",
      stub: true,
      scratch: dir,
      out: join(dir, "report"),
      env: {},
      log: () => {},
      ...(model === undefined ? {} : { model }),
    });
    const status = JSON.parse(
      readFileSync(join(dir, "report", "status.json"), "utf8"),
    );
    const summary = readFileSync(join(dir, "report", "summary.md"), "utf8");
    return { result, status, summary };
  }

  it("runs the model collect.ts chose and reserves the month at that model's price", async () => {
    const { result, status, summary } = await run({
      text: "hello",
      model: LARGE.id,
      model_reason: "a large change, alone on the larger model",
    });
    expect(result.ok).toBe(true);
    expect(status.model).toBe(LARGE.id);
    expect(status.thinking).toBe("high");
    expect(status.modelChoice).toEqual({
      model: LARGE.id,
      thinking: "high",
      reason: "a large change, alone on the larger model",
    });
    // 100,000 tokens at the large model's higher price of $10 a million.
    expect(status.budget.reserveUsd).toBeCloseTo(1, 6);
    expect(summary).toContain(
      "| Model choice | a large change, alone on the larger model |",
    );
  });

  it("stays on the default, reserving at its price, when collect.ts names the small model", async () => {
    const { status } = await run({ text: "hello", model: SMALL.id });
    expect(status.model).toBe(SMALL.id);
    expect(status.thinking).toBe("off");
    expect(status.budget.reserveUsd).toBeCloseTo(0.5, 6);
  });

  it("fails before starting when collect.ts names a model the job does not list", async () => {
    const { result } = await run({ text: "hello", model: "anthropic/other" });
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain(
      'collect.ts chose the model "anthropic/other"',
    );
  });

  it("keeps a model picked by hand, at its entry's thinking level", async () => {
    const { status } = await run({ text: "hello", model: SMALL.id }, LARGE.id);
    expect(status.model).toBe(LARGE.id);
    expect(status.thinking).toBe("high");
    expect(status.modelChoice.reason).toBe("chosen by hand for this run");
  });
});
