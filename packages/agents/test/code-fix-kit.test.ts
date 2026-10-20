import { FIXTURE_WORKSPACE } from "./helpers.ts";
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
import { parse } from "yaml";
import { jobOptionsCheck } from "../src/check/job-options.ts";
import {
  LEDGER_IN_ENV,
  LEDGER_OUT_ENV,
  readLedger,
  writeLedger,
} from "../src/collect/env.ts";
import { loadAllowlists, type RepoCode } from "../src/lib/allowlists.ts";
import type { JobConfig, Output } from "../src/lib/job.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { generate } from "../src/generate/generate.ts";
import { KIT_ACTION_STEP } from "../src/generate/render.ts";
import { loadRepo } from "../src/lib/repo.ts";
import {
  checkPatchSet,
  NEVER_CODE_FIX,
  type CheckContext,
  type PinnedPage,
} from "../src/output-check/pr.ts";
import {
  findLedgerRun,
  keepLedger,
  ledgerArtifact,
  ledgerProblem,
  prepareLedger,
} from "../src/run-job/job-ledger.ts";
import { runPrStage, type PrStageOptions } from "../src/run-job/pr-output.ts";
import { ReportWriter } from "../src/run-job/report.ts";
import {
  buildReviewInput,
  codeFixRules,
  kitRules,
  reviewPrompt,
  type ReviewInput,
} from "../src/run-job/review.ts";
import { FakeWriter } from "./fake-writer.ts";
import { jobFiles, makeRepo, run } from "./helpers.ts";

const ENGINE = "notes-co/engine";
const BASE = "b".repeat(40);
const DEPLOYED = "d".repeat(40);
const SRC = "pqc_report/src/report.rs";
const TEST = "pqc_report/tests/cycle.rs";
const NOW = new Date("2026-10-14T23:00:00Z");
const CODE: Record<string, RepoCode> = {
  [ENGINE]: {
    paths: ["runtime/src/**/*.rs", "pqc_report/src/**/*.rs", "*/tests/**/*.rs"],
    tests: ["*/tests/**/*.rs"],
    test_command: "cargo test --workspace --locked",
  },
};
const SRC_LINES = [
  "fn walk(item: &Item, parents: &Vec<&Item>) {",
  "    for c in &item.children {",
  "        walk(c, parents);",
  "    }",
  "}",
];
const GIVEN: PinnedPage = {
  repo: ENGINE,
  path: SRC,
  commit: BASE,
  lines: SRC_LINES,
};
const ABSENT: PinnedPage = {
  repo: ENGINE,
  path: TEST,
  commit: BASE,
  lines: [],
  absent: true,
};
const RESULTS = [
  {
    tool: "logs-search",
    text: JSON.stringify({
      hits: [{ body: "thread 'w' has overflowed its stack" }],
    }),
  },
];
const OVERFLOW = { tool: "logs-search", quote: "has overflowed its stack" };
const OWN_CODE = { repo: ENGINE, path: SRC, line: 3, commit: DEPLOYED };

/** A guard on the walk, citing the code it changes at the deployed commit and the crash line. */
function guardPage(path = SRC, evidence: unknown[] = [OWN_CODE, OVERFLOW]) {
  return {
    repo: ENGINE,
    path,
    decision: "patch",
    reason: "The walk recursed into an item already on its path.",
    patch: `--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,4 @@\n fn walk(item: &Item, parents: &Vec<&Item>) {\n     for c in &item.children {\n+        if parents.iter().any(|p| p.id == c.id) { continue; }\n         walk(c, parents);\n`,
    changes: [
      {
        removed: [],
        added: [
          "        if parents.iter().any(|p| p.id == c.id) { continue; }",
        ],
        evidence,
      },
    ],
  };
}

function testPage(
  path = TEST,
  body = [
    "#[test]",
    "fn cycle() { let v = vec![1, 2]; assert_eq!(v.len(), 2); }",
  ],
) {
  return {
    repo: ENGINE,
    path,
    decision: "patch",
    reason: "A cycle must end the walk.",
    patch: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${body.length} @@\n${body.map((l) => `+${l}`).join("\n")}\n`,
    changes: [{ removed: [], added: body, evidence: [OWN_CODE, OVERFLOW] }],
  };
}

const OUTPUT: Extract<Output, { kind: "pr" }> = {
  kind: "pr",
  repos: [ENGINE],
  paths: ["runtime/src/**/*.rs", "pqc_report/src/**/*.rs", "*/tests/**/*.rs"],
  max_changed_lines: 120,
  untrusted_input: "open_pr",
  tool_citations: true,
  new_files: { max: 1, paths: ["*/tests/**/*.rs"] },
};

function context(
  policy: Partial<CheckContext["policy"]> = {},
  pinned: PinnedPage[] = [GIVEN, ABSENT],
): CheckContext {
  return {
    policy: {
      repos: OUTPUT.repos,
      paths: OUTPUT.paths,
      maxChangedLines: 120,
      toolCitations: true,
      newFiles: { max: 1, paths: ["*/tests/**/*.rs"] },
      codeFix: { repos: CODE },
      ...policy,
    },
    pinned,
    toolQuotes: { tools: ["logs-search"], results: RESULTS },
  };
}

describe("a code fix (output.code_fix) in the PR checker", () => {
  it("cites the very code it changes, which a docs job may not", () => {
    const ok = checkPatchSet({ pages: [guardPage(), testPage()] }, context());
    expect(ok.problems).toEqual([]);
    expect(ok.pages.map((p) => [p.path, p.ok, p.problems])).toEqual([
      [SRC, true, []],
      [TEST, true, []],
    ]);
    const docs = checkPatchSet(
      { pages: [guardPage()] },
      withoutCodeFix(context()),
    );
    expect(docs.pages[0]!.problems).toEqual([
      `change 1, evidence 1: ${ENGINE} ${SRC}:3 @${DEPLOYED} is documentation this job maintains, not a primary source`,
    ]);
  });

  it("keeps each page inside its repository's code paths and never touches build, workflow, deployment or migration files", () => {
    const outside = checkPatchSet(
      { pages: [guardPage("cumin/src/jobs.rs")] },
      context({ paths: ["**/*.rs"] }, [
        { ...GIVEN, path: "cumin/src/jobs.rs" },
      ]),
    );
    expect(outside.pages[0]!.problems).toEqual([
      `cumin/src/jobs.rs is outside the code paths repos.yml gives ${ENGINE} (runtime/src/**/*.rs, pqc_report/src/**/*.rs, */tests/**/*.rs)`,
    ]);
    const build = checkPatchSet(
      { pages: [guardPage("runtime/src/build.rs")] },
      context({}, [{ ...GIVEN, path: "runtime/src/build.rs" }]),
    );
    expect(build.pages[0]!.problems[0]).toMatch(
      /^runtime\/src\/build\.rs is a workflow, build, dependency, deployment or migration file/,
    );
    const noRepo = checkPatchSet(
      { pages: [guardPage()] },
      context({ codeFix: { repos: {} } }),
    );
    expect(noRepo.pages[0]!.problems).toEqual([
      `${ENGINE} has no code settings in repos.yml, so this job fixes no code there`,
    ]);
    for (const p of [
      ".github/workflows/ci.yml",
      "Cargo.toml",
      "Cargo.lock",
      "runtime/build.rs",
      "pom.xml",
      "build.sbt",
      "project/plugins.sbt",
      "Dockerfile",
      "docker/Dockerfile.dev",
      "pnpm-lock.yaml",
      "package.json",
      "chart/values.yaml",
      "charts/x/templates/a.yaml",
      "src/main/resources/db/migration/V2__x.sql",
      "relational_db/migrations/0001.sql",
    ])
      expect(NEVER_CODE_FIX.test(p), p).toBe(true);
    for (const p of [
      SRC,
      TEST,
      "src/main/java/io/notesco/backend/X.java",
      "src/routes/+page.server.ts",
    ])
      expect(NEVER_CODE_FIX.test(p), p).toBe(false);
  });

  it("creates a file only under its repository's test paths", () => {
    const created = checkPatchSet(
      { pages: [testPage("pqc_report/src/new.rs")] },
      context({ newFiles: { max: 1, paths: ["**/*.rs"] } }, [
        { ...ABSENT, path: "pqc_report/src/new.rs" },
      ]),
    );
    expect(created.pages[0]!.problems).toEqual([
      `the patch creates pqc_report/src/new.rs, but a code fix creates files only under ${ENGINE}'s test paths (*/tests/**/*.rs)`,
    ]);
  });

  it("changes code in a TypeScript file, where a docs job changes only literal values, and reads ![...] in code as code, not an image", () => {
    const TS = "runtime/src/x.ts";
    const tsCode: Record<string, RepoCode> = {
      [ENGINE]: { ...CODE[ENGINE]!, paths: ["runtime/src/**/*.ts"] },
    };
    const page = {
      repo: ENGINE,
      path: TS,
      decision: "patch",
      reason: "Guard the undefined item.",
      patch: `--- a/${TS}\n+++ b/${TS}\n@@ -1,1 +1,2 @@\n export function f(x?: number) { return x; }\n+export const g = (x?: number) => x ?? 0;\n`,
      changes: [
        {
          removed: [],
          added: ["export const g = (x?: number) => x ?? 0;"],
          evidence: [OVERFLOW],
        },
      ],
    };
    const pinned = [
      {
        repo: ENGINE,
        path: TS,
        commit: BASE,
        lines: ["export function f(x?: number) { return x; }"],
      },
    ];
    expect(
      checkPatchSet(
        { pages: [page] },
        context(
          { paths: ["runtime/src/**/*.ts"], codeFix: { repos: tsCode } },
          pinned,
        ),
      ).ok,
    ).toBe(true);
    expect(
      checkPatchSet(
        { pages: [page] },
        withoutCodeFix(context({ paths: ["runtime/src/**/*.ts"] }, pinned)),
      ).pages[0]!.problems[0],
    ).toMatch(/changes code, not only the text of strings and numbers/);
    // vec![...] in a Rust test is a macro; a docs job's Markdown page would read it as an image.
    expect(checkPatchSet({ pages: [testPage()] }, context()).ok).toBe(true);
    const md = checkPatchSet(
      { pages: [testPage("runtime/tests/notes.md")] },
      context(
        {
          paths: ["**/*.md"],
          newFiles: { max: 1, paths: ["**/*.md"] },
          codeFix: {
            repos: {
              [ENGINE]: {
                ...CODE[ENGINE]!,
                paths: ["**/*.md"],
                tests: ["**/*.md"],
              },
            },
          },
        },
        [{ ...ABSENT, path: "runtime/tests/notes.md" }],
      ),
    );
    expect(md.pages[0]!.problems.join("\n")).toMatch(/adds a Markdown image/);
  });
});

describe("the second check of a code fix", () => {
  it("holds it to the code-fix rules, sees the pull request's body, and leaves every other job's prompt and rules as they were", () => {
    const rules = kitRules([], {
      codeFix: { repos: CODE },
      toolCitations: true,
      newFiles: { max: 1, paths: ["*/tests/**/*.rs"] },
    });
    expect(rules).toEqual(
      codeFixRules({
        toolCitations: true,
        newFiles: { max: 1, paths: ["*/tests/**/*.rs"] },
      }),
    );
    expect(rules.join("\n")).toMatch(/no refactoring, renaming, reformatting/);
    expect(rules.join("\n")).toMatch(
      /synthetic input built in the test itself/,
    );
    expect(rules.join("\n")).not.toMatch(/Frontmatter/);
    expect(kitRules([])[0]).toBe(
      "Change facts only: no rewording, restyling, reordering or restructuring, and no new sections, links, notes or pages.",
    );
    const code = reviewPrompt(true);
    expect(code).toMatch(/^You are the second check on a proposed fix to code/);
    expect(code).toContain(
      "- `body`: when present, the pull request's explanation",
    );
    expect(code).toContain("## What to return");
    expect(reviewPrompt()).toBe(reviewPrompt(false));
    expect(reviewPrompt()).toMatch(
      /^You are the second check on a proposed change to documentation/,
    );
    expect(reviewPrompt()).not.toContain("`body`");

    const sections = [
      { title: "Root cause", paragraphs: ["The walk has no cycle check."] },
    ];
    const withBody = buildReviewInput(
      [guardPage() as never],
      context(),
      "Fix the crash.",
      sections,
    );
    expect(withBody.body).toEqual(sections);
    expect(
      buildReviewInput(
        [guardPage() as never],
        withoutCodeFix(context()),
        "x",
        sections,
      ).body,
    ).toBeUndefined();
  });
});

describe("draft pull requests (output.draft)", () => {
  function stage(output: Partial<Extract<Output, { kind: "pr" }>>) {
    const dir = mkdtempSync(join(tmpdir(), "code-fix-kit-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const w = new FakeWriter();
    w.put(ENGINE, BASE, SRC, `${SRC_LINES.join("\n")}\n`);
    const reviewed: ReviewInput[] = [];
    const o: PrStageOptions = {
      job: "crash-check",
      output: { ...OUTPUT, code_fix: true, ...output },
      repoCode: CODE,
      mode: "live",
      stub: false,
      answer: { pages: [guardPage()] },
      input: { pages: [GIVEN] },
      jobPrompt: "Fix the crash.",
      untrusted: { seen: false, model: [], collect: [] },
      model: "acme/test-model",
      runName: "job-crash-check-1-1",
      report: new ReportWriter(dir, []),
      now: NOW,
      sections: [{ title: "What happened", paragraphs: ["It crashed."] }],
      review: (input) => {
        reviewed.push(input);
        return Promise.resolve({
          verdict: {
            verdict: "approve",
            reasons: [{ text: "The code shows it." }],
          },
        });
      },
      openWriter: () =>
        Promise.resolve({
          writer: w,
          secrets: [],
          close: () => Promise.resolve(),
        }),
      toolQuotes: { tools: ["logs-search"], results: RESULTS },
      branchKey: "engine-stack-overflow-0a1b2c3d",
    };
    return { o, w, dir, reviewed };
  }

  it("opens the pull request as a draft, counts files, and shows the second check the body", async () => {
    const s = stage({ draft: true });
    const { record, failure } = await runPrStage(s.o);
    expect(failure).toBeUndefined();
    expect(record.outcome).toBe("delivered");
    expect(s.w.calls).toContain(
      `openPull ${ENGINE} agent/crash-check/engine-stack-overflow-0a1b2c3d draft`,
    );
    expect(s.w.pulls[0]!.draft).toBe(true);
    expect(s.w.pulls[0]!.title).toBe(
      "crash-check: engine-stack-overflow-0a1b2c3d, 1 file (2026-10-14)",
    );
    expect(s.w.pulls[0]!.body).toMatch(
      /^Updates 1 file in `engine`\. Opened by the Notes Agent `crash-check`/,
    );
    expect(s.reviewed[0]!.body).toEqual([
      { title: "What happened", paragraphs: ["It crashed."] },
    ]);
  });

  it("opens a ready pull request without the option, as before", async () => {
    const s = stage({});
    await runPrStage(s.o);
    expect(s.w.calls).toContain(
      `openPull ${ENGINE} agent/crash-check/engine-stack-overflow-0a1b2c3d`,
    );
    expect(s.w.pulls[0]!.draft).toBe(false);
  });
});

describe("repos.yml code settings and flax agents check", () => {
  it("are read per repository: engine and backend, and none for the docs repositories", () => {
    const { allowlists, problems } = loadAllowlists(FIXTURE_WORKSPACE);
    expect(problems).toEqual([]);
    expect(Object.keys(allowlists.repoCode).sort()).toEqual([
      "notes-co/backend",
      "notes-co/engine",
    ]);
    expect(allowlists.repoCode[ENGINE]).toEqual({
      paths: [
        "runtime/src/**/*.rs",
        "pqc_report/src/**/*.rs",
        "*/tests/**/*.rs",
      ],
      tests: ["*/tests/**/*.rs"],
      test_command: "cargo test --workspace --all-targets --locked",
    });
    expect(allowlists.repoCode["notes-co/backend"]!.paths).toEqual([
      "src/main/java/**/*.java",
      "src/test/java/**/*.java",
    ]);
  });

  it("refuse a code fix with no code settings, in the kit's own repository, or with a glob over a build file, and a ledger without collect.ts", async () => {
    const pr = (extra: Record<string, unknown>) => ({
      kind: "pr",
      repos: [ENGINE],
      paths: ["runtime/src/**/*.rs"],
      max_changed_lines: 40,
      untrusted_input: "open_pr",
      code_fix: true,
      ...extra,
    });
    const root = makeRepo({
      jobs: {
        bare: jobFiles("bare", {
          output: pr({ repos: ["notes-co/agents"] }),
        }),
        globs: jobFiles("globs", {
          output: pr({ paths: ["runtime/src/**/*.rs", "Cargo.toml"] }),
        }),
        fine: jobFiles("fine", { output: pr({}) }),
        ledgered: jobFiles("ledgered", { ledger: true, output: pr({}) }),
      },
      repos: [
        "notes-co/agents",
        {
          repo: ENGINE,
          code: {
            paths: ["runtime/src/**/*.rs", ".github/workflows/*.yml"],
            tests: ["*/tests/**/*.rs"],
            test_command: "cargo test",
          },
        },
      ],
    });
    expect(await run(jobOptionsCheck, root)).toEqual([
      "jobs/bare/job.yml: output.code_fix: notes-co/agents holds the kit's own code, which no job fixes",
      "jobs/bare/job.yml: output.code_fix: notes-co/agents has no code settings in repos.yml (code: paths, tests, test_command), so a code fix has nowhere to go",
      "repos.yml: notes-co/engine code glob .github/workflows/*.yml names a workflow, build, dependency, deployment or migration file, which a code fix never changes",
      "jobs/globs/job.yml: output.paths: Cargo.toml names a workflow, build, dependency, deployment or migration file, which a code fix never changes",
      "jobs/ledgered/job.yml: ledger: a ledger is what collect.ts keeps between runs; the job needs a model and a collect.ts",
    ]);
  });
});

describe("a job's ledger (ledger: true)", () => {
  function dirs() {
    const root = mkdtempSync(join(tmpdir(), "ledger-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    return root;
  }

  it("reaches collect.ts from the previous run and goes to the next, checked", () => {
    const root = dirs();
    const previous = join(root, "previous");
    const out = join(root, "out");
    const run = join(root, "run");
    mkdirSync(previous, { recursive: true });
    writeFileSync(
      join(previous, "ledger.json"),
      JSON.stringify({ version: 1, entries: { a: 1 } }),
    );
    const prepared = prepareLedger(run, previous);
    expect(prepared.record).toEqual({ read: true, written: false });
    expect(readLedger(prepared.env)).toEqual({ version: 1, entries: { a: 1 } });
    writeLedger({ version: 1, entries: { a: 2 } }, prepared.env);
    const kept = keepLedger(prepared.next, out, prepared.record);
    expect(kept.error).toBeUndefined();
    expect(JSON.parse(readFileSync(join(out, "ledger.json"), "utf8"))).toEqual({
      version: 1,
      entries: { a: 2 },
    });
    expect(prepared.record).toMatchObject({ read: true, written: true });
  });

  it("starts empty when there is none, ignores one that is not an object, and refuses to keep a bad one", () => {
    const root = dirs();
    const none = prepareLedger(join(root, "a"), undefined);
    expect(none.env[LEDGER_IN_ENV]).toBeUndefined();
    expect(none.env[LEDGER_OUT_ENV]).toBe(none.next);
    expect(readLedger(none.env)).toBeUndefined();
    expect(keepLedger(none.next, join(root, "out"), none.record)).toEqual({});
    const bad = join(root, "bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "ledger.json"), "[1, 2]");
    expect(prepareLedger(join(root, "b"), bad).record).toEqual({
      read: false,
      written: false,
      ignored: "it is not a JSON object",
    });
    writeFileSync(none.next, "{not json");
    expect(keepLedger(none.next, undefined, none.record).error).toMatch(
      /^collect\.ts wrote a ledger the kit cannot keep: it is not JSON/,
    );
    expect(ledgerProblem("x".repeat(300 * 1024))).toMatch(/over 262144 bytes/);
    expect(existsSync(join(root, "out", "ledger.json"))).toBe(false);
  });

  it("is found as the newest artifact of another run, for the workflow to download", async () => {
    const root = dirs();
    const output = join(root, "github_output");
    writeFileSync(output, "");
    const fetched: string[] = [];
    const found = await findLedgerRun({
      job: "crash-check",
      env: {
        GH_TOKEN: "t",
        GITHUB_REPOSITORY: "notes-co/agents",
        GITHUB_RUN_ID: "9",
        GITHUB_OUTPUT: output,
      },
      fetch: ((url: string) => {
        fetched.push(url);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              artifacts: [
                {
                  name: ledgerArtifact("crash-check"),
                  expired: false,
                  workflow_run: { id: 9 },
                },
                {
                  name: ledgerArtifact("crash-check"),
                  expired: false,
                  workflow_run: { id: 7 },
                },
              ],
            }),
          ),
        );
      }) as typeof fetch,
    });
    expect(found).toEqual({
      ok: true,
      message: "crash-check: the previous job-crash-check-ledger is in run 7.",
    });
    expect(readFileSync(output, "utf8")).toBe("run_id=7\n");
    expect(fetched[0]).toBe(
      "https://api.github.com/repos/notes-co/agents/actions/artifacts?name=job-crash-check-ledger&per_page=20",
    );
  });

  it("gets its own steps in the generated workflow, with actions: read, and a job without a ledger keeps none", async () => {
    const root = makeRepo({
      jobs: {
        demo: {
          ...jobFiles("demo", { ledger: true }),
          "collect.ts": 'console.log(JSON.stringify({ text: "hi" }));\n',
        },
        other: jobFiles("other"),
      },
    });
    const repo = loadRepo(root);
    expect(repo.jobs.find((j) => j.name === "demo")!.config!.ledger).toBe(true);
    await generate(repo);
    type Workflow = {
      jobs: {
        run: {
          permissions: Record<string, string>;
          steps: {
            name: string;
            run?: string;
            with?: Record<string, unknown>;
          }[];
        };
      };
    };
    const read = (job: string) =>
      parse(
        readFileSync(join(root, `.github/workflows/job-${job}.yml`), "utf8"),
      ) as Workflow;
    const workflow = read("demo");
    const steps = workflow.jobs.run.steps;
    const names = steps.map((s) => s.name);
    expect(names.indexOf("Find the previous ledger")).toBeLessThan(
      names.indexOf(KIT_ACTION_STEP),
    );
    expect(names.indexOf("Download the previous ledger")).toBeLessThan(
      names.indexOf(KIT_ACTION_STEP),
    );
    expect(names.indexOf("Keep the ledger")).toBeGreaterThan(
      names.indexOf(KIT_ACTION_STEP),
    );
    expect(steps.find((s) => s.name === KIT_ACTION_STEP)!.with!.args).toContain(
      '--ledger-in "$RUNNER_TEMP/previous-ledger" --ledger-out "$RUNNER_TEMP/ledger"',
    );
    expect(steps.find((s) => s.name === "Keep the ledger")!.with).toMatchObject(
      { name: "job-demo-ledger" },
    );
    expect(workflow.jobs.run.permissions.actions).toBe("read");
    // A job without a ledger gets none of it.
    const other = read("other");
    expect(other.jobs.run.steps.map((s) => s.name)).not.toContain(
      "Find the previous ledger",
    );
    expect(other.jobs.run.permissions.actions).toBeUndefined();
  });

});

/** The same context for a job without output.code_fix. */
function withoutCodeFix(c: CheckContext): CheckContext {
  const { codeFix: _, ...policy } = c.policy;
  return { ...c, policy };
}
