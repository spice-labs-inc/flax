import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { parse, stringify } from "yaml";
import { inputProblems } from "../src/check/media.ts";
import { jobSchemaCheck } from "../src/check/job-schema.ts";
import { generate } from "../src/generate/generate.ts";
import { mediaInputEnv, renderWorkflow } from "../src/generate/render.ts";
import type { Box } from "../src/lib/box.ts";
import { KIT_WORKFLOW_INPUTS, type JobConfig } from "../src/lib/job.ts";
import {
  MEDIA_INPUTS_ENV,
  mediaInputs,
  mediaInputsOn,
} from "../src/lib/media.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { runJob, type RunOptions } from "../src/run-job/run.ts";
import { jobFiles, makeRepo, run } from "./helpers.ts";

const JOB = "episodes";
const DOCS = "notes-co/public-docs";
const MAP = "src/data/episodes.json";
const INPUT = {
  name: "digest_fixture",
  description: "Use the fixture digest instead of the merged page",
};

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-inputs-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function inputsJob(overrides: Record<string, unknown> = {}): JobConfig {
  return {
    name: JOB,
    owner: "octocat",
    purpose: "Uploads the episodes for review.",
    trigger: { manual: true },
    model: "none",
    tools: [],
    media: {
      network: "public",
      secrets: ["ELEVENLABS_API_KEY"],
      timeout_minutes: 5,
      inputs: [INPUT, { name: "dry_cast", description: "Replay no casts" }],
    },
    output: { kind: "youtube", playlist: null, docs_repo: DOCS, map_path: MAP },
    mode: "shadow",
    ...overrides,
  } as JobConfig;
}

describe("the media inputs a run is given", () => {
  it("ticks true, leaves false and empty off, and refuses anything else", () => {
    expect(
      mediaInputsOn([
        "digest_fixture=true",
        "dry_cast=false",
        "other=",
        "digest_fixture=true",
      ]),
    ).toEqual(["digest_fixture"]);
    expect(() => mediaInputsOn(["digest_fixture=yes"])).toThrow(
      '--media-input digest_fixture takes true or false, not "yes"',
    );
    expect(() => mediaInputsOn(["digest_fixture"])).toThrow(
      '--media-input takes <name>=<true|false>, not "digest_fixture"',
    );
    expect(() => mediaInputsOn(["Bad-Name=true"])).toThrow(
      "--media-input takes <name>=<true|false>",
    );
  });

  it("reads the ticked names from media.ts's environment", () => {
    expect([...mediaInputs({ [MEDIA_INPUTS_ENV]: "a,b_c" })]).toEqual([
      "a",
      "b_c",
    ]);
    expect(mediaInputs({}).size).toBe(0);
    expect(mediaInputs({ [MEDIA_INPUTS_ENV]: "" }).size).toBe(0);
  });
});

describe("job.yml media.inputs", () => {
  async function schemaProblems(inputs: unknown): Promise<string[]> {
    return run(
      jobSchemaCheck,
      makeRepo({
        jobs: {
          demo: jobFiles("demo", {
            media: {
              network: "public",
              secrets: [],
              timeout_minutes: 5,
              inputs,
            },
          }),
        },
      }),
    );
  }

  it("accepts named one-line inputs and refuses bad names, long lists and line breaks", async () => {
    expect(await schemaProblems([INPUT])).toEqual([]);
    for (const bad of [
      [{ name: "Digest", description: "x" }],
      [{ name: "digest", description: "two\nlines" }],
      [{ name: "digest", description: "" }],
      [{ name: "digest" }],
      [1, 2, 3, 4, 5].map((n) => ({ name: `i${n}`, description: "x" })),
      [],
    ])
      expect(await schemaProblems(bad)).not.toEqual([]);
  });

  it("refuses inputs on a job that runs a model or splits into parts, a name twice and the kit's own names", () => {
    const file = "jobs/x/job.yml";
    expect(inputProblems(file, inputsJob(), inputsJob().media!)).toEqual([]);
    const modelJob = inputsJob({ model: "acme/acme-glm-5.3-flash" });
    expect(
      inputProblems(file, modelJob, modelJob.media!).map((p) => p.message),
    ).toEqual([
      "media inputs reach media.ts through a job's one run step; only a job with model: none may have them",
    ]);
    const media = {
      ...inputsJob().media!,
      parts: [{ id: "one" }],
      inputs: [INPUT, INPUT, { name: "media_model", description: "x" }],
    };
    expect(
      inputProblems(file, inputsJob({ media }), media).map((p) => p.message),
    ).toEqual([
      "a stage split into parts takes no inputs; each part runs in a workflow job of its own",
      "digest_fixture is listed twice",
      "media_model is a workflow input the kit already gives the job; name it otherwise",
    ]);
  });
});

describe("the workflow of a job with media inputs", () => {
  it("offers each as a boolean and passes it to the run step, and knows every input the kit renders", async () => {
    const wf = parse(await renderWorkflow(inputsJob(), {} as Box)) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
      jobs: Record<
        string,
        {
          steps: {
            name?: string;
            run?: string;
            env?: Record<string, string>;
          }[];
        }
      >;
    };
    const inputs = wf.on.workflow_dispatch.inputs;
    expect(inputs.digest_fixture).toEqual({
      description: INPUT.description,
      type: "boolean",
      default: false,
    });
    const step = Object.values(wf.jobs)
      .flatMap((j) => j.steps)
      .find((s) => s.name === "Run the job")!;
    expect(step.env![mediaInputEnv("digest_fixture")]).toBe(
      "${{ inputs.digest_fixture }}",
    );
    expect(step.run).toContain(
      ' --media-input "digest_fixture=$RUN_MEDIA_INPUT_DIGEST_FIXTURE" --media-input "dry_cast=$RUN_MEDIA_INPUT_DRY_CAST"',
    );
    const preflight = Object.values(wf.jobs)
      .flatMap((j) => j.steps)
      .find((s) => s.name === "Check the job")!;
    expect(preflight.run).not.toContain("--media-input");

    const plain = parse(
      await renderWorkflow(
        inputsJob({ media: { ...inputsJob().media!, inputs: undefined } }),
        {} as Box,
      ),
    ) as { on: { workflow_dispatch: { inputs?: Record<string, unknown> } } };
    for (const name of Object.keys(plain.on.workflow_dispatch.inputs ?? {}))
      expect(KIT_WORKFLOW_INPUTS).toContain(name);
  });
});

describe("running a job with media inputs", () => {
  async function repo(): Promise<string> {
    const root = makeRepo({
      jobs: {
        [JOB]: {
          "job.yml": stringify(inputsJob()),
          // Fails on purpose, naming what it was given; the run's failure carries it.
          "media.ts": `throw new Error("inputs: " + (process.env.${MEDIA_INPUTS_ENV} ?? "unset"));\n`,
        },
      },
      repos: [DOCS],
    });
    await generate(loadRepo(root));
    return root;
  }

  function options(
    root: string,
    extra: Partial<RunOptions> = {},
  ): RunOptions & { out: string } {
    const dir = scratch();
    return {
      root,
      name: JOB,
      scratch: dir,
      out: join(dir, "report"),
      env: {
        PATH: process.env.PATH ?? "",
        ELEVENLABS_API_KEY: "test-value",
        AGENTS_READER_APP_ID: "1",
        AGENTS_READER_PRIVATE_KEY: "not-a-key",
      },
      now: () => new Date("2026-10-13T18:00:00Z"),
      ...extra,
    };
  }

  it("refuses a name the job does not list", async () => {
    const root = await repo();
    expect(
      (await runJob(options(root, { mediaInputs: ["nope"] }))).messages,
    ).toEqual([
      `${JOB}: --media-input nope is not one of its media inputs (digest_fixture, dry_cast)`,
    ]);
  });

  it("gives media.ts the ticked names, sorted, and nothing when none is ticked", async () => {
    const root = await repo();
    const ticked = await runJob(
      options(root, { mediaInputs: ["dry_cast", "digest_fixture"] }),
    );
    expect(ticked.ok).toBe(false);
    expect(ticked.messages.join("\n")).toContain(
      "inputs: digest_fixture,dry_cast",
    );
    const none = await runJob(options(root));
    expect(none.messages.join("\n")).toContain("inputs: unset");
  });
});
