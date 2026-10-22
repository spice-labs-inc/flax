import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { jobOptionsCheck } from "../src/check/job-options.ts";
import { generate } from "../src/generate/generate.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { PATCH_SET_SCHEMA } from "../src/lib/schemas.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { checkReport } from "../src/output-check/report.ts";
import { runJob } from "../src/run-job/run.ts";
import {
  jobFiles,
  makeRepo,
  POST_CHANNEL,
  READ_CHANNEL,
  run,
} from "./helpers.ts";

const ATLAS = "notes-co/atlas";
const BASE = "c".repeat(40);
const ENGINE_COMMIT = "f".repeat(40);
const PATH = "repos/engine.md";
const KEY = "engine-port-9090";
const WHO = { uid: process.getuid!(), home: "/nonexistent-home" };

const INPUT = {
  fingerprint: KEY,
  pages: [
    {
      repo: ATLAS,
      path: PATH,
      commit: BASE,
      lines: ["# engine", "", "Listens on port 8080."],
    },
  ],
};

const ANSWER = {
  pages: [
    {
      repo: ATLAS,
      path: PATH,
      decision: "patch",
      reason: "engine moved to port 9090.",
      patch: `--- a/${PATH}\n+++ b/${PATH}\n@@ -3 +3 @@\n-Listens on port 8080.\n+Listens on port 9090.\n`,
      changes: [
        {
          removed: ["Listens on port 8080."],
          added: ["Listens on port 9090."],
          evidence: [
            {
              repo: "notes-co/engine",
              commit: ENGINE_COMMIT,
              path: "src/main.rs",
            },
          ],
        },
      ],
    },
  ],
};

const OUTPUT = {
  kind: "pr",
  repos: [ATLAS],
  paths: ["repos/*.md"],
  max_changed_lines: 40,
  untrusted_input: "open_pr",
};

function publishPrinting(value: unknown): string {
  return `const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { answer } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
console.log(JSON.stringify({ ...${JSON.stringify(value)}, answer }));
`;
}

async function stubRun(
  files: Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  const root = makeRepo({
    jobs: {
      demo: {
        ...jobFiles("demo", { output: { ...OUTPUT, ...extra } }),
        "output.json": JSON.stringify(PATCH_SET_SCHEMA),
        "fixtures/input.json": JSON.stringify(INPUT),
        "fixtures/output.json": JSON.stringify(ANSWER),
        "collect.ts": "console.log('{}');\n",
        ...files,
      },
    },
    repos: [ATLAS],
    channels: {
      post: [POST_CHANNEL],
      read: [READ_CHANNEL],
      links: ["https://github.com/notes-co/"],
    },
    files: { "package.json": JSON.stringify({ type: "module" }) },
  });
  await generate(loadRepo(root));
  const dir = mkdtempSync(join(tmpdir(), "pr-kit-run-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "report");
  const result = await runJob({
    root,
    name: "demo",
    stub: true,
    scratch: dir,
    out,
    identity: WHO,
    log: () => {},
  });
  return { root, out, result };
}

describe("a stub run of a pull request job with the kit's options", () => {
  it("plans its pull request on the branch of the key collect.ts gave", async () => {
    const { out, result } = await stubRun(
      {},
      { branch_key: { from: "input", field: "fingerprint" } },
    );
    expect(result.ok).toBe(true);
    expect(result.report?.delivery).toMatchObject({
      outcome: "shadow",
      branch: `agent/demo/${KEY}`,
    });
    expect(
      readFileSync(join(out, "delivery", "notes-co-atlas.md"), "utf8"),
    ).toMatch(new RegExp(`^# demo: ${KEY}, 1 page \\(\\d{4}-\\d{2}-\\d{2}\\)`));
  });

  it("fails before any model runs when the input's key is not a key", async () => {
    const { result } = await stubRun(
      {
        "fixtures/input.json": JSON.stringify({
          ...INPUT,
          fingerprint: "2026-10-14",
        }),
      },
      { branch_key: { from: "input", field: "fingerprint" } },
    );
    expect(result.ok).toBe(false);
    expect(result.report?.launch).toBeUndefined();
    expect(result.messages[0]).toContain(
      "the input's fingerprint is not a branch key",
    );
  });

  it("writes publish.ts's sections into the pull request it would open", async () => {
    const { root, out, result } = await stubRun({
      "publish.ts": publishPrinting({
        publish: true,
        sections: [
          {
            title: "Why now",
            paragraphs: ["The port moved in engine 0.17."],
            links: [
              {
                text: "the commit",
                url: "https://github.com/notes-co/engine/commit/ffff",
              },
            ],
          },
        ],
      }),
    });
    expect(result.ok).toBe(true);
    const body = readFileSync(
      join(out, "delivery", "notes-co-atlas.md"),
      "utf8",
    );
    expect(body).toContain(
      "**Why now**\n\nThe port moved in engine 0.17.\n\n- [the commit](https://github.com/notes-co/engine/commit/ffff)\n\n**Reviewing**",
    );
    // The report checks again offline as it did in the run.
    expect(checkReport(root, out).result.ok).toBe(true);
  });

  it("fails when a section links outside channels.yml's links", async () => {
    const { result } = await stubRun({
      "publish.ts": publishPrinting({
        publish: true,
        sections: [
          {
            title: "Evidence",
            links: [{ text: "x", url: "https://evil.example/x" }],
          },
        ],
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toBe(
      "demo: jobs/demo/publish.ts wrote a section link the kit does not allow: sections[0].links[0] points outside the links channels.yml allows",
    );
  });
});

describe("checking a report again offline", () => {
  it("holds the answer to the pages the run read on demand", async () => {
    const root = makeRepo({
      jobs: {
        demo: jobFiles("demo", {
          output: { ...OUTPUT, pages_on_demand: { paths: ["repos/*.md"] } },
        }),
      },
      repos: [ATLAS],
    });
    const dir = mkdtempSync(join(tmpdir(), "pr-kit-report-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const write = (file: string, value: unknown) =>
      writeFileSync(join(dir, file), JSON.stringify(value));
    write("status.json", { job: "demo", model: "m", inputSource: "collect" });
    write("input.json", { pages: [] });
    write("answer.json", ANSWER);
    expect(checkReport(root, dir).result.pages[0]!.problems).toEqual([
      "no pinned copy of this page was given to the run, so the patch cannot be checked against it",
    ]);
    write("pages-on-demand.json", { pages: INPUT.pages, skipped: [] });
    expect(checkReport(root, dir).result.ok).toBe(true);
  });
});

describe("the jobs shipped today", () => {
  it("use none of the options but the crash investigator, so they run as before", () => {
    for (const job of loadRepo(FIXTURE_WORKSPACE).jobs) {
      const output = job.config?.output;
      if (output?.kind !== "pr" || job.name === "crash-investigator") continue;
      for (const key of [
        "branch_key",
        "pages_on_demand",
        "new_files",
        "tool_citations",
      ])
        expect(output, `${job.name} ${key}`).not.toHaveProperty(key);
    }
  });
});

describe("flax agents check on the pull request options", () => {
  it("wants tools for tool quotes, a model for pages on demand and an answer key, and collect.ts for an input key", async () => {
    const root = makeRepo({
      jobs: {
        quotes: jobFiles("quotes", {
          output: { ...OUTPUT, tool_citations: true },
        }),
        coded: jobFiles("coded", {
          model: "none",
          thinking: undefined,
          limits: undefined,
          media: {
            network: "public",
            secrets: [],
            timeout_minutes: 5,
            pr_paths: ["repos/*.md"],
          },
          output: {
            ...OUTPUT,
            pages_on_demand: { paths: ["repos/*.md"] },
            branch_key: { from: "answer", field: "key" },
          },
        }),
        keyed: jobFiles("keyed", {
          output: { ...OUTPUT, branch_key: { from: "input", field: "key" } },
        }),
        fine: {
          ...jobFiles("fine", {
            tools: ["web-fetch"],
            output: {
              ...OUTPUT,
              tool_citations: true,
              pages_on_demand: { paths: ["repos/*.md"] },
              new_files: { max: 1, paths: ["repos/new-*.md"] },
              branch_key: { from: "input", field: "key" },
            },
          }),
          "collect.ts": "console.log('{}');\n",
        },
      },
      repos: [ATLAS],
    });
    expect(await run(jobOptionsCheck, root)).toEqual([
      "jobs/coded/job.yml: output.pages_on_demand: pages on demand are for pages a model's patch names; a job with model: none gives its pages in the input",
      "jobs/coded/job.yml: output.branch_key.from: a job with model: none has no model answer to read the key from; use from: input",
      "jobs/keyed/job.yml: output.branch_key.from: the key comes from the input, but the job has no collect.ts to set it",
      "jobs/quotes/job.yml: output.tool_citations: a quote of a tool result needs a tool the model calls; the job lists no tools",
    ]);
  });
});
