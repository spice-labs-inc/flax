import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { parse, stringify } from "yaml";
import { partProblems } from "../src/check/media.ts";
import { generate } from "../src/generate/generate.ts";
import { renderWorkflow } from "../src/generate/render.ts";
import type { Box } from "../src/lib/box.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { loadRepo } from "../src/lib/repo.ts";
import type { JobConfig } from "../src/lib/job.ts";
import { mediaPartArtifact } from "../src/lib/media.ts";
import {
  leavePartFailure,
  mergeMediaParts,
  partReason,
} from "../src/run-job/media-parts.ts";
import { runJob, type RunOptions } from "../src/run-job/run.ts";
import { makeRepo } from "./helpers.ts";
import { mediaDir, OVERVIEW, writeMedia } from "./youtube-media.ts";

const JOB = "videos";
const DOCS = "notes-co/public-docs";
const MAP = "src/data/videos.json";
const NOW = new Date("2026-10-06T16:00:00Z");

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-parts-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function partsJob(overrides: Record<string, unknown> = {}): JobConfig {
  return {
    name: JOB,
    owner: "octocat",
    purpose: "Uploads the demo videos for review.",
    trigger: { manual: true },
    model: "none",
    tools: [],
    media: {
      network: "public",
      secrets: ["ELEVENLABS_API_KEY", "LIVETESTS_MAILBOX_USER"],
      timeout_minutes: 5,
      parts: [
        { id: "alpha" },
        { id: "beta", secrets: ["ELEVENLABS_API_KEY"], edition_heap: true },
        { id: "gamma" },
      ],
    },
    output: { kind: "youtube", playlist: null, docs_repo: DOCS, map_path: MAP },
    mode: "shadow",
    ...overrides,
  } as JobConfig;
}

async function partsRepo(
  config: JobConfig,
  extra: Record<string, string> = {},
): Promise<string> {
  const root = makeRepo({
    jobs: {
      [JOB]: {
        "job.yml": stringify(config),
        "media.ts": "export {};\n",
        ...extra,
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
    env: { PATH: process.env.PATH ?? "" },
    now: () => NOW,
    readDocs: () =>
      Promise.resolve({
        state: {
          repo: DOCS,
          path: MAP,
          branch: "main",
          base: "a".repeat(40),
          openPulls: [],
          text: "{}\n",
        },
        secrets: [],
      }),
    ...extra,
  };
}

describe("merging the media of a stage's parts", () => {
  it("copies each part's files, merges their data and lists each part without media with why", () => {
    const parts = scratch();
    const dir = (id: string) => join(parts, id);
    writeMedia(dir("alpha"), { alpha: OVERVIEW }, (m) => {
      (m.data as Record<string, unknown>).resources = {
        alpha: { machineBytes: 1 },
      };
    });
    writeMedia(dir("beta"), { beta: { title: "Beta" } });
    leavePartFailure(
      dir("gamma"),
      "gamma",
      "jobs/videos/media.ts failed (exit 1): no scenario was recorded: gamma: the score never moved",
    );
    const out = join(scratch(), "merged");
    const merged = mergeMediaParts(
      ["alpha", "beta", "gamma", "delta"],
      dir,
      out,
    );
    expect(merged.manifest.files.map((f) => f.path).sort()).toEqual([
      "alpha/captions.vtt",
      "alpha/poster.png",
      "alpha/video.mp4",
      "beta/captions.vtt",
      "beta/poster.png",
      "beta/video.mp4",
    ]);
    const data = merged.manifest.data as Record<string, unknown>;
    expect(Object.keys(data.scenarios as object)).toEqual(["alpha", "beta"]);
    expect(data.resources).toEqual({ alpha: { machineBytes: 1 } });
    expect(data.failed).toEqual([
      { scenario: "gamma", reason: "the score never moved" },
      {
        scenario: "delta",
        reason:
          "its recording job ended without media; see the media-delta job's log",
      },
    ]);
    expect(readFileSync(join(out, "beta/video.mp4"), "utf8")).toContain(
      "mp4 bytes of beta",
    );
  });

  it("refuses two parts that make the same file, and fails when no part left media", () => {
    const parts = scratch();
    writeMedia(join(parts, "a"), { same: OVERVIEW });
    writeMedia(join(parts, "b"), { same: OVERVIEW });
    expect(() =>
      mergeMediaParts(["a", "b"], (id) => join(parts, id), join(parts, "m")),
    ).toThrow("parts a and b both made");
    leavePartFailure(join(parts, "c"), "c", "boom");
    expect(() =>
      mergeMediaParts(["c", "d"], (id) => join(parts, id), join(parts, "n")),
    ).toThrow(
      "no part was recorded: c: boom; d: its recording job ended without media; see the media-d job's log",
    );
  });

  it("keeps a part's reason without the runner's prefix", () => {
    expect(
      partReason(
        "jobs/demo-videos/media.ts failed (exit 1): no scenario was recorded: board-ready-posture: consent decision HTTP 400",
      ),
    ).toBe("consent decision HTTP 400");
    expect(partReason("x".repeat(400))).toHaveLength(300);
  });
});

describe("a youtube job split into parts", () => {
  it("records one part with only that part's secrets and delivers nothing", async () => {
    const root = await partsRepo(partsJob());
    expect((await runJob(options(root, { part: "beta" }))).messages).toEqual([
      "ELEVENLABS_API_KEY is not set; a shadow youtube job needs it",
    ]);
    expect(
      (await runJob(options(root, { part: "beta", preflight: true }))).messages,
    ).toEqual([`${JOB}: ready to run (mode shadow, no model, part beta).`]);
    expect((await runJob(options(root, { part: "omega" }))).messages).toEqual([
      `${JOB}: omega is not one of its media parts (alpha, beta, gamma)`,
    ]);
    expect(
      (await runJob(options(root, { part: "alpha", editionHeap: "8g" })))
        .messages,
    ).toEqual([
      "--edition-heap is only for a part with edition_heap: true in job.yml",
    ]);
    expect(
      (await runJob(options(root, { part: "beta", editionHeap: "-Xmx8g" })))
        .messages,
    ).toEqual([
      '--edition-heap takes a size java\'s -Xmx takes, such as 8g or 4096m, not "-Xmx8g"',
    ]);
  });

  it("leaves why a part has no media when its media.ts fails", async () => {
    const root = await partsRepo(partsJob(), {
      "media.ts": 'throw new Error("the fixture org could not be created");\n',
    });
    const mediaOut = join(scratch(), "media-part");
    const opts = options(root, {
      part: "gamma",
      mediaOut,
      env: {
        PATH: process.env.PATH ?? "",
        ELEVENLABS_API_KEY: "k",
        LIVETESTS_MAILBOX_USER: "u",
      },
    });
    const result = await runJob(opts);
    expect(result.ok).toBe(false);
    const left = JSON.parse(
      readFileSync(join(mediaOut, "failed.json"), "utf8"),
    );
    expect(left.part).toBe("gamma");
    expect(left.reason).toContain("the fixture org could not be created");
    expect(existsSync(join(mediaOut, "media.json"))).toBe(false);
    const status = JSON.parse(
      readFileSync(join(opts.out, "status.json"), "utf8"),
    );
    expect(status.part).toBe("gamma");
    expect(status.youtube).toBeUndefined();
  });

  it("delivers the parts' media once, with no media secret, naming the parts that left none", async () => {
    const root = await partsRepo(partsJob());
    const parts = scratch();
    writeMedia(join(parts, mediaPartArtifact(JOB, "alpha")), {
      alpha: OVERVIEW,
    });
    writeMedia(join(parts, mediaPartArtifact(JOB, "beta")), {
      beta: { title: "Beta" },
    });
    mkdirSync(join(parts, mediaPartArtifact(JOB, "gamma")));
    writeFileSync(
      join(parts, mediaPartArtifact(JOB, "gamma"), "failed.json"),
      JSON.stringify({ part: "gamma", reason: "timed out" }),
    );
    const opts = options(root, { mediaParts: parts });
    const result = await runJob(opts);
    // The run still fails after delivering, since a part is missing.
    expect(result.ok).toBe(false);
    const status = JSON.parse(
      readFileSync(join(opts.out, "status.json"), "utf8"),
    );
    expect(status.media.source).toBe("parts");
    expect(status.youtube.outcome).toBe("shadow");
    expect(
      status.youtube.videos.map((v: { scenario: string }) => v.scenario),
    ).toEqual(["alpha", "beta"]);
    expect(status.youtube.notRecorded).toEqual([
      { scenario: "gamma", reason: "timed out" },
    ]);
    expect(existsSync(join(opts.out, "media/alpha/video.mp4"))).toBe(true);
  });

  it("is refused for a job whose stage has no parts", async () => {
    const config = partsJob();
    delete config.media!.parts;
    const root = await partsRepo(config);
    expect(
      (await runJob(options(root, { mediaParts: mediaDir() }))).messages,
    ).toEqual([`${JOB}: its media stage has no parts`]);
  });
});

describe("the workflow of a stage split into parts", () => {
  async function workflow(config: JobConfig) {
    return parse(await renderWorkflow(config, {} as Box)) as {
      on: { workflow_dispatch: { inputs?: Record<string, unknown> } };
      jobs: Record<
        string,
        {
          needs?: string[];
          if?: string;
          "runs-on": unknown;
          "timeout-minutes": number;
          steps: {
            name?: string;
            run?: string;
            env?: Record<string, string>;
          }[];
        }
      >;
    };
  }

  it("records each part in a job of its own on the agents pool, and delivers once after all of them", async () => {
    const config = partsJob({
      media: {
        ...partsJob().media,
        network: "tailnet",
        model: {
          model: "anthropic/claude-haiku-4-5",
          usd_per_run: 1,
          usd_per_month: 5,
        },
        parts: [
          { id: "alpha", model: true, timeout_minutes: 40 },
          {
            id: "beta",
            network: "public",
            secrets: ["ELEVENLABS_API_KEY"],
            edition_heap: true,
          },
        ],
      },
    });
    const wf = await workflow(config);
    expect(Object.keys(wf.jobs)).toEqual([
      "media-alpha",
      "media-beta",
      "deliver",
    ]);
    for (const job of Object.values(wf.jobs))
      expect(job["runs-on"]).toEqual(["self-hosted", "pool-a", "agents"]);
    const run = (id: string) =>
      wf.jobs[id]!.steps.find((s) => s.name === "Run the job")!;
    const names = (id: string) => wf.jobs[id]!.steps.map((s) => s.name);
    // Only the part with model: true gets the issuer key; each gets its own secrets.
    expect(Object.keys(run("media-alpha").env!)).toEqual([
      "LLM_GATEWAY_ISSUER_KEY",
      "ELEVENLABS_API_KEY",
      "LIVETESTS_MAILBOX_USER",
    ]);
    expect(Object.keys(run("media-beta").env!)).toEqual([
      "ELEVENLABS_API_KEY",
      "RUN_EDITION_HEAP",
    ]);
    expect(run("media-beta").run).toContain("--part beta");
    expect(run("media-beta").run).toContain(
      '${RUN_EDITION_HEAP:+--edition-heap "$RUN_EDITION_HEAP"}',
    );
    expect(names("media-alpha")).toContain("Join the tailnet");
    expect(names("media-beta")).not.toContain("Join the tailnet");
    expect(wf.jobs["media-alpha"]!["timeout-minutes"]).toBe(10 + 40 + 5);
    expect(wf.on.workflow_dispatch.inputs).toHaveProperty("edition_heap");
    // The delivery job waits for every part, however it ended, and gets no media secret.
    const deliver = wf.jobs.deliver!;
    expect([deliver.needs, deliver.if]).toEqual([
      ["media-alpha", "media-beta"],
      "${{ !cancelled() }}",
    ]);
    expect(Object.keys(run("deliver").env!)).toEqual([
      "AGENTS_READER_APP_ID",
      "AGENTS_READER_PRIVATE_KEY",
    ]);
    expect(names("deliver")).not.toContain("Join the tailnet");
    expect(run("deliver").run).toContain(
      '--media-parts "$RUNNER_TEMP/media-parts"',
    );
  });

  it("checks that only a youtube job with model: none splits, each part once, with the stage's secrets and a part for its key", () => {
    const base = partsJob();
    const file = "jobs/videos/job.yml";
    expect(partProblems(file, base, { key_max_minutes: 120 })).toEqual([]);
    const bad = partsJob({
      media: {
        ...base.media,
        model: { model: "m/x", usd_per_run: 1, usd_per_month: 5 },
        parts: [
          { id: "alpha", secrets: ["TS_OAUTH_SECRET"] },
          { id: "alpha", model: true, timeout_minutes: 115 },
        ],
      },
    });
    expect(
      partProblems(file, bad, { key_max_minutes: 120 }).map((p) => p.message),
    ).toEqual([
      "TS_OAUTH_SECRET is not one of the stage's secrets; a part gets a subset of media.secrets",
      "alpha is listed twice",
      "the part's media key would live 125 minutes, over the gateway's 120-minute ceiling (key_max_minutes in gateway.yml)",
    ]);
    const pr = partsJob({
      output: {
        kind: "pr",
        repos: [DOCS],
        paths: ["x"],
        max_changed_lines: 10,
        untrusted_input: "report_only",
      },
    });
    expect(partProblems(file, pr, undefined).map((p) => p.message)[0]).toMatch(
      /only a job with model: none and output kind youtube/,
    );
  });
});

