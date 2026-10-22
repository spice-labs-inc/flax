import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { generatedCheck } from "../src/check/generated.ts";
import { runChecks } from "../src/check/index.ts";
import { generate } from "../src/generate/generate.ts";
import {
  jobToolSecrets,
  KIT_ACTION_STEP,
  renderAll,
  renderRevisePoll,
  renderWorkflow,
  REVISE_RUN_NAME,
} from "../src/generate/render.ts";
import type { JobConfig } from "../src/lib/job.ts";
import type { ToolEntry } from "../src/lib/tools.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { PATCH_SET_SCHEMA } from "../src/lib/schemas.ts";
import type { Box } from "../src/lib/box.ts";
import {
  BOX,
  formatted,
  jobConfig,
  jobFiles,
  makeRepo,
  run,
  toolFiles,
  toolSpec,
} from "./helpers.ts";

function sampleRepo(): string {
  return makeRepo({
    jobs: {
      nightly: jobFiles("nightly", { trigger: { schedule: "0 13 * * *" } }),
      followup: jobFiles("followup", { trigger: { after: "nightly" } }),
      adhoc: jobFiles("adhoc"),
    },
  });
}

async function workflow(
  overrides: Record<string, unknown>,
): Promise<Record<string, any>> {
  return parse(
    await renderWorkflow(
      jobConfig("demo", overrides) as unknown as JobConfig,
      BOX as Box,
    ),
  );
}

describe("generated files", () => {
  it("renders the same bytes every time and on every copy of the repository", async () => {
    const first = sampleRepo();
    const second = sampleRepo();
    await generate(loadRepo(first));
    await generate(loadRepo(second));
    const files = await renderAll(
      loadRepo(first).jobs.map((j) => j.config!),
      BOX as Box,
      [],
      loadRepo(first).allowlists.models.map((m) => m.id),
    );
    expect([...files.keys()]).toEqual([
      ".github/workflows/job-adhoc.yml",
      ".github/workflows/job-followup.yml",
      ".github/workflows/job-nightly.yml",
      "JOBS.md",
    ]);
    for (const [file, content] of files) {
      expect(readFileSync(join(first, file), "utf8")).toBe(content);
      expect(readFileSync(join(second, file), "utf8")).toBe(content);
    }
    expect(await generate(loadRepo(first))).toEqual({
      written: [],
      unchanged: [...files.keys()],
      removed: [],
    });
  });

  it("passes every check straight after generating", async () => {
    const root = sampleRepo();
    await generate(loadRepo(root));
    expect(formatted(await runChecks(loadRepo(root)))).toEqual([]);
  });

  it("fails when a generated workflow is edited by hand", async () => {
    const root = sampleRepo();
    await generate(loadRepo(root));
    const file = join(root, ".github/workflows/job-adhoc.yml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("contents: read", "contents: write"),
    );
    expect(await run(generatedCheck, root)).toEqual([
      ".github/workflows/job-adhoc.yml: is out of date or was edited by hand; run flax agents generate",
    ]);
  });

  it("fails when JOBS.md is edited or a generated file is missing", async () => {
    const root = sampleRepo();
    expect(await run(generatedCheck, root)).toEqual([
      ".github/workflows/job-adhoc.yml: is missing; run flax agents generate",
      ".github/workflows/job-followup.yml: is missing; run flax agents generate",
      ".github/workflows/job-nightly.yml: is missing; run flax agents generate",
      "JOBS.md: is missing; run flax agents generate",
    ]);
    await generate(loadRepo(root));
    writeFileSync(join(root, "JOBS.md"), "# Jobs\n");
    expect(await run(generatedCheck, root)).toEqual([
      "JOBS.md: is out of date or was edited by hand; run flax agents generate",
    ]);
  });

  it("flags and then removes the workflow of a job that no longer exists", async () => {
    const root = sampleRepo();
    await generate(loadRepo(root));
    writeFileSync(
      join(root, ".github/workflows/job-gone.yml"),
      "name: job-gone\n",
    );
    writeFileSync(join(root, ".github/workflows/check.yml"), "name: Check\n");
    expect(await run(generatedCheck, root)).toEqual([
      ".github/workflows/job-gone.yml: belongs to no job; run flax agents generate",
    ]);
    expect((await generate(loadRepo(root))).removed).toEqual([
      ".github/workflows/job-gone.yml",
    ]);
    expect(await run(generatedCheck, root)).toEqual([]);
  });

  it("refuses to generate while a job.yml is invalid", async () => {
    const root = makeRepo({
      jobs: { demo: jobFiles("demo", { mode: "maybe" }) },
    });
    await expect(generate(loadRepo(root))).rejects.toThrow(
      "job.yml and box.yml problems must be fixed",
    );
  });

  it("refuses to generate while box.yml is invalid, but not while it is only unpinned", async () => {
    const broken = makeRepo({
      jobs: { demo: jobFiles("demo") },
      box: { ...BOX, image: "lbx:docker" },
    });
    await expect(generate(loadRepo(broken))).rejects.toThrow(
      "job.yml and box.yml problems must be fixed",
    );
    expect(await run(generatedCheck, broken)).toEqual([]);
    const unpinned = makeRepo({
      jobs: { demo: jobFiles("demo") },
      box: { ...BOX, pinned: false },
    });
    expect((await generate(loadRepo(unpinned))).written).toContain(
      ".github/workflows/job-demo.yml",
    );
  });

  it("starts with the do-not-edit header", async () => {
    const text = await renderWorkflow(
      jobConfig("demo") as unknown as JobConfig,
      BOX as Box,
    );
    expect(text.split("\n")[0]).toBe(
      "# Generated from jobs/demo/job.yml by flax agents generate. Do not edit.",
    );
    const root = sampleRepo();
    await generate(loadRepo(root));
    expect(readFileSync(join(root, "JOBS.md"), "utf8").split("\n")[0]).toBe(
      "<!-- Generated from jobs/*/job.yml by flax agents generate. Do not edit. -->",
    );
  });

  it("locks permissions down and runs on the agents pool", async () => {
    const wf = await workflow({
      limits: { turns: 20, tokens_per_run: 1, usd_per_month: 1 },
    });
    expect(wf.permissions).toEqual({});
    expect(wf.concurrency).toEqual({
      group: "job-demo",
      "cancel-in-progress": false,
    });
    expect(wf.jobs.run["runs-on"]).toEqual(["self-hosted", "pool-a", "agents"]);
    expect(wf.jobs.run.permissions).toEqual({
      contents: "read",
      packages: "read",
    });
    expect(wf.jobs.run["timeout-minutes"]).toBe(50);
  });

  it("checks first, then hands the kit action the pinned box and the issuer key, and keeps the report and the maintainer notes", async () => {
    const steps: Record<string, any>[] = (await workflow({})).jobs.run.steps;
    const byName = (name: string) => steps.find((s) => s.name === name)!;
    const names = steps.map((s) => s.name ?? s.uses ?? s.run);
    expect(names).toEqual([
      "actions/checkout@v5",
      "actions/setup-node@v6",
      "Check the job and the pinned box",
      KIT_ACTION_STEP,
      "Keep the report",
      "Keep the maintainer notes",
    ]);
    // Node only: the committed runner bundle needs no install and no tsx.
    expect(steps[1]).toEqual({
      uses: "actions/setup-node@v6",
      with: { "node-version": 24 },
    });
    expect(JSON.stringify(steps)).not.toMatch(/pnpm|tsx|npm |npx/);
    expect(byName("Check the job and the pinned box").run).toBe(
      "node dist/run-job.mjs demo --preflight",
    );
    // The image login and pull, the release binary check and lbx on PATH are the action's (action.yml).
    expect(JSON.stringify(steps)).not.toMatch(
      /docker pull|ghcr\.io\/login|Check out lbx|GITHUB_PATH|BOX_REPO_TOKEN/,
    );
    const runStep = byName(KIT_ACTION_STEP);
    expect(runStep.uses).toBe("spice-labs-inc/flax/packages/agents@main");
    expect(runStep.with).toEqual({
      job: "demo",
      workspace: ".",
      "box-image": BOX.image,
      "box-repository": "spice-labs-inc/lbx",
      "box-release": BOX.box_release,
      "box-sha256": BOX.lbx_sha256,
      args: '--out "$RUNNER_TEMP/job-output"',
    });
    expect(runStep.env).toEqual({
      LLM_GATEWAY_ISSUER_KEY: "${{ secrets.LLM_GATEWAY_ISSUER_KEY }}",
    });
    expect(runStep.run).toBeUndefined();
    const keep = byName("Keep the report");
    expect(keep.if).toBe("always()");
    expect(keep.uses).toBe("actions/upload-artifact@v4");
    expect(keep.with).toEqual({
      name: "job-demo-report",
      path: "${{ runner.temp }}/job-output/",
      "retention-days": 90,
      "if-no-files-found": "ignore",
    });
    const notes = byName("Keep the maintainer notes");
    expect(notes.if).toBe("always()");
    expect(notes.uses).toBe("actions/upload-artifact@v4");
    expect(notes.with).toEqual({
      name: "job-demo-maintainer-notes",
      path: "${{ runner.temp }}/job-output/maintainer-notes.json",
      "retention-days": 90,
      "if-no-files-found": "ignore",
    });
    // Only the run step sees the issuer key, and no step a model provider's key.
    expect(JSON.stringify(steps)).not.toContain("ACME_API_KEY");
    const withKey = steps.filter((s) =>
      JSON.stringify(s).includes("LLM_GATEWAY_ISSUER_KEY"),
    );
    expect(withKey).toEqual([runStep]);
  });

  it("changes when box.yml changes, so a new pin shows up as a workflow diff", async () => {
    const root = sampleRepo();
    await generate(loadRepo(root));
    // The commit is a record only; the workflow carries the release, the binary's sha256 and the image.
    writeFileSync(
      join(root, "box.yml"),
      stringify({ ...BOX, box_commit: "f".repeat(40) }),
    );
    expect(await run(generatedCheck, root)).toEqual([]);
    writeFileSync(
      join(root, "box.yml"),
      stringify({ ...BOX, lbx_sha256: "f".repeat(64) }),
    );
    expect(await run(generatedCheck, root)).toEqual([
      ".github/workflows/job-adhoc.yml: is out of date or was edited by hand; run flax agents generate",
      ".github/workflows/job-followup.yml: is out of date or was edited by hand; run flax agents generate",
      ".github/workflows/job-nightly.yml: is out of date or was edited by hand; run flax agents generate",
    ]);
  });

  it("passes the run step only the secrets its tools' upstreams need", async () => {
    const tool = (name: string, server: string) =>
      ({
        name,
        spec: toolSpec(name, { upstream: { server, operations: [] } }),
        problems: [],
      }) as unknown as ToolEntry;
    const tools = [
      tool("pods", "kubernetes"),
      tool("runs", "github"),
      tool("logs", "openobserve"),
      tool("history", "slack"),
      tool("echo", "builtin"),
    ];
    const secretsFor = (names: string[]) =>
      jobToolSecrets(
        jobConfig("demo", { tools: names }) as unknown as JobConfig,
        tools,
      );
    expect(secretsFor([])).toEqual([]);
    expect(secretsFor(["echo"])).toEqual([]);
    expect(secretsFor(["pods"])).toEqual([
      "KUBECONFIG_DEV",
      "KUBECONFIG_STAGING",
      "KUBECONFIG_PROD",
      "KUBECONFIG_SHARED_SERVICES",
    ]);
    expect(secretsFor(["runs"])).toEqual([
      "AGENTS_READER_APP_ID",
      "AGENTS_READER_PRIVATE_KEY",
    ]);
    expect(secretsFor(["logs"])).toEqual([
      "KUBECONFIG_SHARED_SERVICES",
      "OPENOBSERVE_CI_AUTH",
    ]);
    expect(secretsFor(["history"])).toEqual(["SLACK_AGENTS_BOT_TOKEN"]);
    // Each secret once, in a fixed order, whatever order the tools come in.
    expect(secretsFor(["history", "logs", "pods"])).toEqual([
      "KUBECONFIG_DEV",
      "KUBECONFIG_STAGING",
      "KUBECONFIG_PROD",
      "KUBECONFIG_SHARED_SERVICES",
      "OPENOBSERVE_CI_AUTH",
      "SLACK_AGENTS_BOT_TOKEN",
    ]);

    const wf = parse(
      await renderWorkflow(
        jobConfig("demo", { tools: ["history"] }) as unknown as JobConfig,
        BOX as Box,
        tools,
      ),
    );
    const steps: Record<string, any>[] = wf.jobs.run.steps;
    const runStep = steps.find((s) => s.name === KIT_ACTION_STEP)!;
    expect(runStep.env).toEqual({
      LLM_GATEWAY_ISSUER_KEY: "${{ secrets.LLM_GATEWAY_ISSUER_KEY }}",
      SLACK_AGENTS_BOT_TOKEN: "${{ secrets.SLACK_AGENTS_BOT_TOKEN }}",
    });
    // No other step sees a tool credential.
    expect(
      steps.filter((s) => JSON.stringify(s).includes("SLACK_AGENTS_BOT_TOKEN")),
    ).toEqual([runStep]);
  });

  it("gives the writer app's secrets to a live pull request job only, and time for its second check", async () => {
    const pr = {
      kind: "pr",
      repos: ["notes-co/atlas"],
      paths: ["repos/*.md"],
      max_changed_lines: 10,
      untrusted_input: "report_only",
    };
    const runEnv = async (overrides: Record<string, unknown>) => {
      const wf = await workflow(overrides);
      const steps: Record<string, any>[] = wf.jobs.run.steps;
      return {
        env: steps.find((s) => s.name === KIT_ACTION_STEP)!.env,
        timeout: wf.jobs.run["timeout-minutes"],
        steps,
      };
    };
    const live = await runEnv({ output: pr, mode: "live" });
    // The reader app's secrets let a revision run read the original run's report.
    expect(live.env).toEqual({
      LLM_GATEWAY_ISSUER_KEY: "${{ secrets.LLM_GATEWAY_ISSUER_KEY }}",
      AGENTS_WRITER_APP_ID: "${{ secrets.AGENTS_WRITER_APP_ID }}",
      AGENTS_WRITER_PRIVATE_KEY: "${{ secrets.AGENTS_WRITER_PRIVATE_KEY }}",
      AGENTS_READER_APP_ID: "${{ secrets.AGENTS_READER_APP_ID }}",
      AGENTS_READER_PRIVATE_KEY: "${{ secrets.AGENTS_READER_PRIVATE_KEY }}",
      RUN_REVISE: "${{ inputs.revise }}",
      RUN_REVIEW_MODEL: "${{ inputs.review_model }}",
      RUN_REVIEW_THINKING: "${{ inputs.review_thinking }}",
      RUN_REPLAY: "${{ inputs.replay_run }}",
    });
    expect(
      live.steps.filter((s) => JSON.stringify(s).includes("AGENTS_WRITER")),
    ).toHaveLength(1);
    // 10 minutes of setup, 2 a turn, and 10 for the second check.
    expect(live.timeout).toBe(10 + 2 * 10 + 10);
    const shadow = await runEnv({ output: pr });
    // A shadow run can still replay an earlier run's input, which it reads with the reader app.
    expect(shadow.env).toEqual({
      LLM_GATEWAY_ISSUER_KEY: "${{ secrets.LLM_GATEWAY_ISSUER_KEY }}",
      AGENTS_READER_APP_ID: "${{ secrets.AGENTS_READER_APP_ID }}",
      AGENTS_READER_PRIVATE_KEY: "${{ secrets.AGENTS_READER_PRIVATE_KEY }}",
      RUN_REVISE: "${{ inputs.revise }}",
      RUN_REVIEW_MODEL: "${{ inputs.review_model }}",
      RUN_REVIEW_THINKING: "${{ inputs.review_thinking }}",
      RUN_REPLAY: "${{ inputs.replay_run }}",
    });
    expect(shadow.timeout).toBe(40);
    expect((await runEnv({ mode: "live" })).env).toEqual({
      LLM_GATEWAY_ISSUER_KEY: "${{ secrets.LLM_GATEWAY_ISSUER_KEY }}",
    });
    expect((await runEnv({})).timeout).toBe(30);
  });

  it("lets a pull request job be started to revise a pull request, naming it in the run name", async () => {
    const pr = {
      kind: "pr",
      repos: ["notes-co/atlas"],
      paths: ["repos/*.md"],
      max_changed_lines: 10,
      untrusted_input: "report_only",
    };
    const revise = {
      description:
        "A pull request to revise, owner/name#number; empty for a normal run",
      type: "string",
      required: false,
      default: "",
    };
    const wf = await workflow({
      output: pr,
      mode: "live",
      tools: [],
      trigger: { schedule: "0 14 * * *" },
    });
    expect(wf["run-name"]).toBe(REVISE_RUN_NAME);
    expect(REVISE_RUN_NAME).toBe(
      "${{ inputs.revise != '' && format('{0} revise {1}', github.workflow, inputs.revise) || github.workflow }}",
    );
    expect(wf.on).toEqual({
      schedule: [{ cron: "0 14 * * *" }],
      workflow_dispatch: {
        inputs: {
          revise,
          replay_run: {
            description:
              "An earlier run id whose input to run again (shadow only): the same input for another model; empty for a normal run",
            type: "string",
            required: false,
            default: "",
          },
        },
      },
    });
    const steps: Record<string, any>[] = wf.jobs.run.steps;
    const runStep = steps.find((s) => s.name === KIT_ACTION_STEP)!;
    // The input reaches the command only through the environment.
    expect(runStep.with.args).toBe(
      '--out "$RUNNER_TEMP/job-output" ${RUN_REVISE:+--revise "$RUN_REVISE"} --review-model "$RUN_REVIEW_MODEL" --review-thinking "$RUN_REVIEW_THINKING" ${RUN_REPLAY:+--replay "$RUN_REPLAY"}',
    );
    expect(
      steps.filter((s) => JSON.stringify(s).includes("inputs.revise")),
    ).toEqual([runStep]);

    const picked = parse(
      await renderWorkflow(
        jobConfig("demo", { output: pr }) as unknown as JobConfig,
        BOX as Box,
        [],
        ["acme/test-model"],
      ),
    );
    expect(Object.keys(picked.on.workflow_dispatch.inputs)).toEqual([
      "model",
      "thinking",
      "revise",
      "review_model",
      "review_thinking",
      "replay_run",
    ]);
    expect(
      picked.jobs.run.steps.find((s: any) => s.name === KIT_ACTION_STEP).with
        .args,
    ).toBe(
      '--model "$RUN_MODEL" --thinking "$RUN_THINKING" --out "$RUNNER_TEMP/job-output" ${RUN_REVISE:+--revise "$RUN_REVISE"} --review-model "$RUN_REVIEW_MODEL" --review-thinking "$RUN_REVIEW_THINKING" ${RUN_REPLAY:+--replay "$RUN_REPLAY"}',
    );

    const other = await workflow({});
    expect(other["run-name"]).toBeUndefined();
    expect(JSON.stringify(other)).not.toContain("revise");
  });

  it("generates the revision poller's workflow on the agents pool, with only what it needs", async () => {
    const wf = parse(await renderRevisePoll());
    expect(wf).toEqual({
      name: "Revision poller",
      on: { schedule: [{ cron: "*/10 * * * *" }], workflow_dispatch: {} },
      permissions: {},
      concurrency: { group: "revise-poll", "cancel-in-progress": false },
      jobs: {
        poll: {
          "runs-on": ["self-hosted", "pool-a", "agents"],
          "timeout-minutes": 10,
          permissions: { actions: "write", contents: "read" },
          steps: [
            {
              uses: "actions/checkout@v5",
              with: { "persist-credentials": false },
            },
            { uses: "actions/setup-node@v6", with: { "node-version": 24 } },
            {
              name: "Start revision runs",
              env: {
                AGENTS_READER_APP_ID: "${{ secrets.AGENTS_READER_APP_ID }}",
                AGENTS_READER_PRIVATE_KEY:
                  "${{ secrets.AGENTS_READER_PRIVATE_KEY }}",
                AGENTS_WRITER_APP_ID: "${{ secrets.AGENTS_WRITER_APP_ID }}",
                AGENTS_WRITER_PRIVATE_KEY:
                  "${{ secrets.AGENTS_WRITER_PRIVATE_KEY }}",
                GH_TOKEN: "${{ github.token }}",
              },
              run: "node dist/revise-poll.mjs",
            },
          ],
        },
      },
    });
    const root = livePrRepo();
    await generate(loadRepo(root));
    const file = join(root, ".github/workflows/revise-poll.yml");
    writeFileSync(file, readFileSync(file, "utf8").replace("*/10", "*/5"));
    expect(await run(generatedCheck, root)).toEqual([
      ".github/workflows/revise-poll.yml: is out of date or was edited by hand; run flax agents generate",
    ]);
  });

  it("writes the poller only while a live job opens pull requests, and removes it after", async () => {
    const root = livePrRepo();
    await generate(loadRepo(root));
    expect(existsSync(join(root, ".github/workflows/revise-poll.yml"))).toBe(
      true,
    );
    const job = join(root, "jobs/demo/job.yml");
    writeFileSync(
      job,
      readFileSync(job, "utf8").replace("mode: live", "mode: shadow"),
    );
    expect((await generate(loadRepo(root))).removed).toEqual([
      ".github/workflows/revise-poll.yml",
    ]);
    const sample = sampleRepo();
    await generate(loadRepo(sample));
    expect(existsSync(join(sample, ".github/workflows/revise-poll.yml"))).toBe(
      false,
    );
  });

  it("changes when a tool the job lists moves to another upstream", async () => {
    const root = makeRepo({
      jobs: { demo: jobFiles("demo", { tools: ["lookup"] }) },
      tools: ["lookup"],
    });
    await generate(loadRepo(root));
    expect(
      readFileSync(join(root, ".github/workflows/job-demo.yml"), "utf8"),
    ).not.toContain("SLACK_AGENTS_BOT_TOKEN");
    const slack = toolFiles("lookup", {
      upstream: { server: "slack", operations: ["conversations.history"] },
    });
    writeFileSync(join(root, "tools/lookup/tool.yml"), slack["tool.yml"]!);
    expect(await run(generatedCheck, root)).toEqual([
      ".github/workflows/job-demo.yml: is out of date or was edited by hand; run flax agents generate",
    ]);
    await generate(loadRepo(root));
    expect(
      readFileSync(join(root, ".github/workflows/job-demo.yml"), "utf8"),
    ).toContain(
      "SLACK_AGENTS_BOT_TOKEN: ${{ secrets.SLACK_AGENTS_BOT_TOKEN }}",
    );
  });

  it("maps each trigger form, always keeping workflow_dispatch", async () => {
    expect((await workflow({})).on).toEqual({ workflow_dispatch: {} });
    expect((await workflow({ trigger: { schedule: "5 4 * * *" } })).on).toEqual(
      {
        schedule: [{ cron: "5 4 * * *" }],
        workflow_dispatch: {},
      },
    );
    const chained = await workflow({ trigger: { after: "nightly" } });
    expect(chained.on).toEqual({
      workflow_run: {
        workflows: ["job-nightly"],
        types: ["completed"],
        branches: ["main"],
      },
      workflow_dispatch: {},
    });
    expect(chained.jobs.run.if).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
  });
});

/** A repository with one live pull request job, which the revision poller serves. */
function livePrRepo(): string {
  const atlas = "notes-co/atlas";
  return makeRepo({
    jobs: {
      demo: {
        ...jobFiles("demo", {
          mode: "live",
          output: {
            kind: "pr",
            repos: [atlas],
            paths: ["repos/*.md"],
            max_changed_lines: 40,
            untrusted_input: "report_only",
          },
        }),
        "output.json": JSON.stringify(PATCH_SET_SCHEMA),
        "SHADOW_RUNS.md": Array.from(
          { length: 4 },
          (_, i) =>
            `- https://github.com/notes-co/agents/actions/runs/${i + 1}`,
        ).join("\n"),
      },
    },
    repos: [atlas],
  });
}
