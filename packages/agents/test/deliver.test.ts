import { generateKeyPairSync } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  deliverPlan,
  deliverRevision,
  planProblem,
  pullBody,
  type DeliveryMeta,
} from "../src/deliver/deliver.ts";
import {
  GithubWriter,
  openGithubWriter,
  WRITE_PERMISSIONS,
  BASE_WRITE_PERMISSIONS,
} from "../src/deliver/github-writer.ts";
import {
  citedAuthors,
  fileLines,
  fileText,
  planDelivery,
} from "../src/deliver/plan.ts";
import { applyStamps, inputStamps } from "../src/deliver/stamps.ts";
import {
  commitAuthor,
  deliveryBranch,
  isAgentBranch,
} from "../src/deliver/writer.ts";
import type { CheckContext, ProposedPage } from "../src/output-check/pr.ts";
import { fakeGithubFetch, FakeWriter, WRITER_TOKEN } from "./fake-writer.ts";

const ATLAS = "notes-co/atlas";
const BASE = "c".repeat(40);
const NOW = new Date("2026-09-30T04:00:00Z");
const PAGE = ["---", "name: engine", "---", "", "Listens on port 8080."];
const PATCH =
  "--- a/repos/engine.md\n+++ b/repos/engine.md\n@@ -5 +5 @@\n-Listens on port 8080.\n+Listens on port 9090.\n";

const policy = {
  repos: [ATLAS],
  paths: ["repos/*.md", "INDEX.md"],
  maxChangedLines: 10,
};

function context(pages = [{ path: "repos/engine.md", commit: BASE }]) {
  return {
    policy,
    pinned: pages.map((p) => ({ repo: ATLAS, ...p, lines: PAGE })),
  } satisfies CheckContext;
}

const patched: ProposedPage = {
  repo: ATLAS,
  path: "repos/engine.md",
  decision: "patch",
  reason: "engine moved to 9090.",
  patch: PATCH,
  changes: [
    {
      removed: ["Listens on port 8080."],
      added: ["Listens on port 9090."],
      evidence: [{ repo: "notes-co/engine", commit: "f".repeat(40) }],
    },
  ],
};

const meta: DeliveryMeta = {
  model: "acme/test-model",
  runName: "job-demo-1-1",
  runUrl: "https://github.com/notes-co/agents/actions/runs/1",
  untrustedTools: [],
  reviewReasons: ["The commit sets the port to 9090."],
};

function plan() {
  const p = planDelivery("demo", { pages: [patched] }, context(), NOW);
  if ("error" in p) throw new Error(p.error);
  return p;
}

describe("agent branches", () => {
  it("names one branch per job and day, and nothing else counts", () => {
    expect(deliveryBranch("atlas-doc-refresh", NOW)).toBe(
      "agent/atlas-doc-refresh/2026-09-30",
    );
    for (const ok of [
      "agent/demo/2026-09-30",
      "agent/atlas-doc-refresh/2026-01-01",
    ])
      expect(isAgentBranch(ok), ok).toBe(true);
    for (const bad of [
      "main",
      "agent/demo",
      "agent/demo/main",
      "agent/demo/2026-09-30/x",
      "agent/../main",
      "refs/heads/agent/demo/2026-09-30",
      "agent/Demo/2026-09-30",
    ])
      expect(isAgentBranch(bad), bad).toBe(false);
  });
});

describe("the delivery plan", () => {
  it("applies each checked patch to the page it was checked against, per repository", () => {
    const p = plan();
    expect(p.branch).toBe("agent/demo/2026-09-30");
    expect(p.repos).toHaveLength(1);
    expect(p.repos[0]!.base).toBe(BASE);
    expect(p.repos[0]!.files[0]!.after).toEqual([
      "---",
      "name: engine",
      "---",
      "",
      "Listens on port 9090.",
    ]);
    expect(p.repos[0]!.files[0]!.changedLines).toBe(2);
  });

  it("leaves no_change pages out and refuses pages of one repository read at different commits", () => {
    const unchanged = {
      ...patched,
      path: "INDEX.md",
      decision: "no_change" as const,
    };
    const none = planDelivery("demo", { pages: [unchanged] }, context(), NOW);
    expect("error" in none ? none.error : none.repos).toEqual([]);
    const split = planDelivery(
      "demo",
      {
        pages: [
          patched,
          {
            ...patched,
            path: "INDEX.md",
            patch: PATCH.replaceAll("repos/engine.md", "INDEX.md"),
          },
        ],
      },
      context([
        { path: "repos/engine.md", commit: BASE },
        { path: "INDEX.md", commit: "d".repeat(40) },
      ]),
      NOW,
    );
    expect(split).toEqual({
      error: `the pages of ${ATLAS} were read at different commits (cccccccccccc and dddddddddddd); one pull request needs one base`,
    });
  });

  it("is refused again at delivery when it leaves the job's repositories, paths or line limit", () => {
    const p = plan();
    expect(planProblem(p, policy)).toBeUndefined();
    expect(planProblem(p, { ...policy, repos: ["notes-co/other"] })).toBe(
      `${ATLAS} is not a repository this job may change`,
    );
    expect(planProblem(p, { ...policy, paths: ["INDEX.md"] })).toBe(
      `${ATLAS}/repos/engine.md is outside the paths this job may change`,
    );
    expect(planProblem(p, { ...policy, maxChangedLines: 1 })).toBe(
      `${ATLAS}: 2 changed lines, more than the limit of 1`,
    );
    expect(planProblem({ ...p, branch: "main" }, policy)).toBe(
      "main is not a branch of demo",
    );
    expect(
      planProblem({ ...p, branch: "agent/other/2026-09-30" }, policy),
    ).toBe("agent/other/2026-09-30 is not a branch of demo");
  });

  it("turns lines back into the same file text, final newline or not", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const { lines, finalNewline } = fileLines(text);
        expect(fileText(lines, finalNewline)).toBe(text);
      }),
    );
  });
});

describe("the pull request text", () => {
  it("says what changed and why in plain words, links its sources, and keeps the model's words from rendering as markdown", () => {
    const p = plan();
    const loud = {
      ...p,
      repos: [
        {
          ...p.repos[0]!,
          files: [
            {
              ...p.repos[0]!.files[0]!,
              reason:
                "cc @octocat <img src=x> ``` see https://evil.example [x](y)",
            },
          ],
        },
      ],
    };
    const body = pullBody(
      "demo",
      loud.repos[0]!,
      meta,
      "agent/demo/2026-09-30",
    );
    expect(body.split("\n")[0]).toBe(
      "Updates 1 page in `atlas` that no longer matched the code. Opened by the Notes Agent `demo`; a person reviews and merges it.",
    );
    expect(body).toContain("**What changed and why**");
    expect(body).toContain(
      "- [`repos/engine.md`](https://github.com/notes-co/atlas/blob/agent/demo/2026-09-30/repos/engine.md): ",
    );
    expect(body).toContain(
      "Source: [engine@fffffff](https://github.com/notes-co/engine/commit/ffffffffffffffffffffffffffffffffffffffff).",
    );
    expect(body).toContain(
      "Submit a review with **Request changes**, or comment `/agent` with what to change. The Notes Agent replies in each comment's thread within about 15 minutes",
    );
    expect(body).toContain("<details><summary>Run details</summary>");
    expect(body).toContain(
      "| Run | [job-demo-1-1](https://github.com/notes-co/agents/actions/runs/1) |",
    );
    expect(body).toContain("| Untrusted input | none seen |");
    expect(body).not.toContain("**Preview**");
    expect(body).not.toContain("@octocat");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("https://evil.example");
    expect(body).toContain("\\[x\\]\\(y\\)");
    expect(body).not.toContain("```text");
    expect(body).not.toContain("Listens on port 8080.");
    expect(body).toContain("- The commit sets the port to 9090.");
  });

  it("names a cited commit by its pull request when the source title has one", () => {
    const body = pullBody(
      "demo",
      plan().repos[0]!,
      {
        ...meta,
        sourceTitles: {
          [`notes-co/engine@${"f".repeat(40)}`]: "Rename the port (#614)",
        },
      },
      "agent/demo/2026-09-30",
    );
    expect(body).toContain(
      "Source: [engine#614](https://github.com/notes-co/engine/pull/614).",
    );
  });

  it("prints the repository's preview with each changed page's local address", () => {
    const body = pullBody(
      "demo",
      plan().repos[0]!,
      {
        ...meta,
        previews: {
          [ATLAS]: {
            commands: ["pnpm install", "pnpm dev"],
            url: "http://localhost:4321",
            pages: { dir: "repos", prefix: "/docs/" },
            docs: "https://github.com/notes-co/atlas#development",
          },
        },
      },
      "agent/demo/2026-09-30",
    );
    expect(body).toContain(
      [
        "**Preview**",
        "",
        "```sh",
        "git switch agent/demo/2026-09-30",
        "pnpm install",
        "pnpm dev",
        "```",
        "",
        "- http://localhost:4321/docs/engine/",
        "",
        "More in the repository's [instructions](https://github.com/notes-co/atlas#development).",
      ].join("\n"),
    );
  });
});

describe("delivering a plan", () => {
  function writer(text = `${PAGE.join("\n")}\n`) {
    const w = new FakeWriter();
    w.put(ATLAS, BASE, "repos/engine.md", text);
    return w;
  }

  it("commits the checked page to the day's branch with the fixed author and opens one pull request, ready for review", async () => {
    const w = writer();
    const [pull, ...more] = await deliverPlan(plan(), policy, w, meta, NOW);
    expect(more).toEqual([]);
    expect(pull).toMatchObject({
      repo: ATLAS,
      branch: "agent/demo/2026-09-30",
      updated: false,
      replaced: [],
    });
    const commit = w.commits[0]!.request;
    expect(commit.base).toBe(BASE);
    expect(commit.author).toEqual(commitAuthor());
    expect(commit.files).toEqual([
      {
        path: "repos/engine.md",
        text: "---\nname: engine\n---\n\nListens on port 9090.\n",
        mode: "100644",
      },
    ]);
    const opened = w.pulls.find((p) => p.number === pull!.number)!;
    expect(opened).toMatchObject({
      draft: false,
      base: "main",
      title: "demo: 1 page (2026-09-30)",
    });
    expect(w.calls).toEqual([
      `readFile ${ATLAS} ccccccc repos/engine.md`,
      `commitFiles ${ATLAS} agent/demo/2026-09-30`,
      `openPulls ${ATLAS}`,
      `defaultBranch ${ATLAS}`,
      `openPull ${ATLAS} agent/demo/2026-09-30`,
      `createCheck ${ATLAS} ${pull!.commit.slice(0, 7)} completed`,
    ]);
    // The Notes Agent check lands on the new head commit, completed.
    expect(w.checks).toEqual([
      expect.objectContaining({
        repo: ATLAS,
        name: "Notes Agent / demo",
        branch: "agent/demo/2026-09-30",
        headSha: pull!.commit,
        status: "completed",
        conclusion: "success",
        title: "1 page changed, no second check needed",
      }),
    ]);
    expect(pull!.check).toMatchObject({
      name: "Notes Agent / demo",
      head: pull!.commit,
      conclusion: "success",
      id: w.checks[0]!.id,
    });
    expect(w.checks[0]!.summary).toContain("**PR checker:** passed");
    expect(w.checks[0]!.summary).toContain("- `repos/engine.md`: 2 lines");
  });

  it("marks the check neutral and names the pages left out, with the second check, the cost and the run", async () => {
    const w = writer();
    const [pull] = await deliverPlan(
      plan(),
      policy,
      w,
      {
        ...meta,
        runUrl: "https://github.com/notes-co/agents/actions/runs/9",
        reviewReasons: ["fine"],
        secondCheck: "approved without the pages left out",
        costUsd: 0.0559,
        leftOut: [
          {
            repo: ATLAS,
            path: "repos/widget.md",
            why: "change 1 cites only documentation",
          },
        ],
      },
      NOW,
    );
    const check = w.checks[0]!;
    expect(check).toMatchObject({
      conclusion: "neutral",
      title: "1 page changed, 1 left out, second check approved",
      detailsUrl:
        "https://github.com/notes-co/agents/actions/runs/9",
    });
    expect(check.summary).toContain(
      "**Second check:** approved without the pages left out",
    );
    expect(check.summary).toContain("**Model cost:** $0.0559");
    expect(check.summary).toContain(
      "- `repos/widget.md`: change 1 cites only documentation",
    );
    expect(pull!.check?.conclusion).toBe("neutral");
  });

  it("delivers anyway when GitHub refuses the check run, and records why", async () => {
    const w = writer();
    w.refuseChecks =
      "POST /repos/notes-co/atlas/check-runs returned 403";
    const [pull] = await deliverPlan(plan(), policy, w, meta, NOW);
    expect(pull!.number).toBeGreaterThan(0);
    expect(pull!.check).toMatchObject({
      refused: "POST /repos/notes-co/atlas/check-runs returned 403",
    });
    expect(pull!.check?.id).toBeUndefined();
  });

  it("keeps at most one open pull request per repository and job: an earlier one is closed as replaced, after the new one opens", async () => {
    const w = writer();
    const old = w.open({ repo: ATLAS, branch: "agent/demo/2026-09-29" });
    const human = w.open({
      repo: ATLAS,
      branch: "agent/demo/2026-09-28",
      byBot: false,
    });
    const fork = w.open({
      repo: ATLAS,
      branch: "agent/demo/2026-09-27",
      sameRepo: false,
    });
    const other = w.open({ repo: ATLAS, branch: "agent/other-job/2026-09-29" });
    const [pull] = await deliverPlan(plan(), policy, w, meta, NOW);
    expect(pull!.replaced).toEqual([old.number]);
    expect(old.state).toBe("closed");
    expect(old.comments[0]).toBe(
      `Replaced by #${pull!.number}, which the job \`demo\` opened from a newer run. The job keeps at most one open pull request per repository.`,
    );
    expect(w.deleted).toEqual([`${ATLAS}:agent/demo/2026-09-29`]);
    for (const p of [human, fork, other]) expect(p.state).toBe("open");
    expect(
      w.calls.indexOf(`openPull ${ATLAS} agent/demo/2026-09-30`),
    ).toBeLessThan(w.calls.indexOf(`closePull ${ATLAS} #${old.number}`));
  });

  it("updates the pull request already open on today's branch instead of opening another", async () => {
    const w = writer();
    const today = w.open({
      repo: ATLAS,
      branch: "agent/demo/2026-09-30",
      title: "old",
    });
    const [pull] = await deliverPlan(plan(), policy, w, meta, NOW);
    expect(pull).toMatchObject({
      number: today.number,
      updated: true,
      replaced: [],
    });
    expect(today.title).toBe("demo: 1 page (2026-09-30)");
    expect(w.calls.some((c) => c.startsWith("openPull "))).toBe(false);
  });

  it("writes nothing when the page at the base commit is not the page the run checked", async () => {
    for (const w of [
      writer("---\nname: engine\n---\n\nListens on port 7070.\n"),
      new FakeWriter(),
    ]) {
      await expect(deliverPlan(plan(), policy, w, meta, NOW)).rejects.toThrow(
        /notes-co\/atlas\/repos\/engine\.md (at cccccccccccc is not the page the run was given|does not exist at cccccccccccc)/,
      );
      expect(w.commits).toEqual([]);
      expect(w.pulls.filter((p) => p.draft === false)).toEqual([]);
    }
  });

  it("keeps the file's mode and whether it ended with a newline", async () => {
    const w = new FakeWriter();
    w.put(ATLAS, BASE, "repos/engine.md", PAGE.join("\n"), "100755");
    await deliverPlan(plan(), policy, w, meta, NOW);
    expect(w.commits[0]!.request.files[0]).toMatchObject({
      text: "---\nname: engine\n---\n\nListens on port 9090.",
      mode: "100755",
    });
  });
});

describe("stamps the job's code sets", () => {
  const OLD = "analyzed_commit: 0a0a0a0 2026-09-01";
  const NEW = "analyzed_commit: 1111111 2026-09-30";
  const DOC = ["---", "name: engine", OLD, "---", "", "Listens on port 8080."];
  const stampPolicy = { ...policy, stampKeys: ["analyzed_commit"] };
  const stamp = (path: string, extra: Record<string, unknown> = {}) => ({
    repo: ATLAS,
    path,
    commit: BASE,
    key: "analyzed_commit",
    value: "1111111 2026-09-30",
    ...extra,
  });
  const pinnedAt = (paths: string[]) =>
    ({
      policy: stampPolicy,
      pinned: paths.map((path) => ({
        repo: ATLAS,
        path,
        commit: BASE,
        lines: DOC,
      })),
    }) satisfies CheckContext;
  const engine = { ...patched, patch: PATCH.replace("-5 +5", "-6 +6") };
  const listed = (path: string): ProposedPage => ({
    repo: ATLAS,
    path,
    decision: "no_change",
    reason: "Still true.",
  });

  it("are read from the input only as the job's pr output allows", () => {
    expect(inputStamps({}, stampPolicy)).toEqual({ stamps: [] });
    const ok = stamp("repos/engine.md");
    expect(inputStamps({ stamps: [{ ...ok, why: "x" }] }, stampPolicy)).toEqual(
      { stamps: [ok] },
    );
    const refused: [unknown, string][] = [
      [{ stamps: "x" }, "the input's stamps is not a list"],
      [
        { stamps: [stamp("repos/engine.md", { key: "depends_on" })] },
        "stamps[0]: depends_on is not among the job's stamp_keys (analyzed_commit)",
      ],
      [
        { stamps: [stamp("src/main.rs")] },
        "stamps[0]: src/main.rs is outside the paths this job may change",
      ],
      [
        { stamps: [stamp("../x.md")] },
        "stamps[0].path is not a plain relative path",
      ],
      [
        {
          stamps: [stamp("repos/engine.md", { repo: "notes-co/other" })],
        },
        "stamps[0]: notes-co/other is not a repository this job may change",
      ],
      [
        { stamps: [stamp("repos/engine.md", { commit: "ccccccc" })] },
        "stamps[0].commit is not a 40-character commit sha",
      ],
      [
        { stamps: [ok, ok] },
        `stamps[1]: ${ATLAS}/repos/engine.md has more than one analyzed_commit stamp`,
      ],
    ];
    for (const [input, error] of refused)
      expect(inputStamps(input, stampPolicy)).toEqual({ error });
    for (const value of [
      "a\nb",
      "a: b",
      "a #b",
      " a",
      "a  b",
      "",
      "x".repeat(201),
    ])
      expect(
        inputStamps(
          { stamps: [stamp("repos/engine.md", { value })] },
          stampPolicy,
        ),
        JSON.stringify(value),
      ).toMatchObject({
        error: expect.stringMatching(
          /^stamps\[0\]\.value is not a plain value/,
        ),
      });
    expect(inputStamps({ stamps: [ok] }, policy)).toEqual({
      error:
        "stamps[0]: analyzed_commit is not among the job's stamp_keys (none)",
    });
  });

  it("change only the stamped key's own line, which must already be there", () => {
    const value = { key: "analyzed_commit", value: "1111111 2026-09-30" };
    expect(applyStamps(DOC, [value])).toEqual({
      lines: DOC.map((l) => (l === OLD ? NEW : l)),
    });
    expect(applyStamps(DOC, [{ ...value, key: "analysis_source" }])).toEqual({
      error: "has no analysis_source in its frontmatter to stamp",
    });
    expect(applyStamps(["# engine"], [value])).toEqual({
      error: "has no frontmatter to stamp",
    });
    expect(
      applyStamps(["---", "analyzed_commit:", "  - a", "---"], [value]),
    ).toEqual({
      error:
        "analyzed_commit spans more than one line; a stamp replaces one line",
    });
    expect(
      applyStamps(["---", "x: analyzed_commit: 1", "---"], [value]),
    ).toEqual({
      error: "has no analyzed_commit in its frontmatter to stamp",
    });
  });

  it("apply to a patched page and a page the answer lists, never to a page the model was given but left out, and always to a page it was not given", () => {
    const p = planDelivery(
      "demo",
      { pages: [engine, listed("repos/alpha.md")] },
      pinnedAt(["repos/engine.md", "repos/alpha.md", "repos/beta.md"]),
      NOW,
      [
        "repos/engine.md",
        "repos/alpha.md",
        "repos/beta.md",
        "repos/gamma.md",
      ].map((path) => stamp(path)),
    );
    if ("error" in p) throw new Error(p.error);
    const [repo] = p.repos;
    expect(repo!.files.map((f) => [f.path, f.changedLines, f.stamps])).toEqual([
      [
        "repos/engine.md",
        2,
        [{ key: "analyzed_commit", value: "1111111 2026-09-30" }],
      ],
    ]);
    expect(repo!.files[0]!.after).toEqual([
      "---",
      "name: engine",
      NEW,
      "---",
      "",
      "Listens on port 9090.",
    ]);
    expect(repo!.stamped.map((s) => [s.path, s.before !== undefined])).toEqual([
      ["repos/alpha.md", true],
      ["repos/gamma.md", false],
    ]);
    expect(planProblem(p, stampPolicy)).toBeUndefined();
    expect(planProblem(p, policy)).toBe(
      `${ATLAS}/repos/engine.md: analyzed_commit is not a key this job's code may stamp`,
    );
  });

  it("need the commit the pages were read at, and a page with only stamps needs no answer", () => {
    const moved = planDelivery(
      "demo",
      { pages: [engine] },
      pinnedAt(["repos/engine.md"]),
      NOW,
      [stamp("repos/engine.md", { commit: "d".repeat(40) })],
    );
    expect(moved).toEqual({
      error: `the analyzed_commit stamp of ${ATLAS}/repos/engine.md is for commit dddddddddddd, but the page was read at cccccccccccc`,
    });
    const alone = planDelivery("demo", { pages: [] }, pinnedAt([]), NOW, [
      stamp("repos/gamma.md"),
    ]);
    if ("error" in alone) throw new Error(alone.error);
    expect(alone.repos).toEqual([
      {
        repo: ATLAS,
        base: BASE,
        files: [],
        stamped: [
          {
            path: "repos/gamma.md",
            stamps: [{ key: "analyzed_commit", value: "1111111 2026-09-30" }],
          },
        ],
        reviewers: [],
      },
    ]);
  });

  it("are committed with the patched pages, a page with only stamps read at the base, and listed in the pull request", async () => {
    const w = new FakeWriter();
    for (const path of ["repos/engine.md", "repos/alpha.md", "repos/gamma.md"])
      w.put(ATLAS, BASE, path, `${DOC.join("\n")}\n`);
    const p = planDelivery(
      "demo",
      { pages: [engine, listed("repos/alpha.md")] },
      pinnedAt(["repos/engine.md", "repos/alpha.md"]),
      NOW,
      ["repos/engine.md", "repos/alpha.md", "repos/gamma.md"].map((path) =>
        stamp(path),
      ),
    );
    if ("error" in p) throw new Error(p.error);
    const [pull] = await deliverPlan(p, stampPolicy, w, meta, NOW);
    const stampedText = `${DOC.join("\n").replace(OLD, NEW)}\n`;
    expect(w.commits[0]!.request.files).toEqual([
      {
        path: "repos/engine.md",
        text: stampedText.replace("8080", "9090"),
        mode: "100644",
      },
      { path: "repos/alpha.md", text: stampedText, mode: "100644" },
      { path: "repos/gamma.md", text: stampedText, mode: "100644" },
    ]);
    expect(w.commits[0]!.request.message).toBe(
      "demo: 1 page, 2 stamped\n\n- repos/engine.md\n- repos/alpha.md (stamped)\n- repos/gamma.md (stamped)\n\nRun: job-demo-1-1",
    );
    const opened = w.pulls.find((x) => x.number === pull!.number)!;
    expect(opened.title).toBe("demo: 1 page, 2 stamped (2026-09-30)");
    expect(opened.body!.split("\n")[0]).toBe(
      "Updates 3 pages in `atlas` that no longer matched the code. Opened by the Notes Agent `demo`; a person reviews and merges it.",
    );
    expect(opened.body).toContain(
      "  The job's code also set `analyzed_commit: 1111111 2026-09-30`.",
    );
    expect(opened.body).toContain(
      "- [`repos/alpha.md`](https://github.com/notes-co/atlas/blob/agent/demo/2026-09-30/repos/alpha.md): the job's code set `analyzed_commit: 1111111 2026-09-30`.\n- [`repos/gamma.md`](https://github.com/notes-co/atlas/blob/agent/demo/2026-09-30/repos/gamma.md): the job's code set `analyzed_commit: 1111111 2026-09-30`.",
    );
  });

  it("write nothing when a page with only stamps cannot take them", async () => {
    const w = new FakeWriter();
    w.put(ATLAS, BASE, "repos/gamma.md", "---\nname: gamma\n---\n");
    const p = planDelivery("demo", { pages: [] }, pinnedAt([]), NOW, [
      stamp("repos/gamma.md"),
    ]);
    if ("error" in p) throw new Error(p.error);
    await expect(
      deliverPlan(p, stampPolicy, w, { ...meta, reviewReasons: [] }, NOW),
    ).rejects.toThrow(
      `${ATLAS}/repos/gamma.md has no analyzed_commit in its frontmatter to stamp`,
    );
    expect(w.commits).toEqual([]);
  });

  it("say in the pull request that no second check ran when the model changed no page", () => {
    const p = planDelivery("demo", { pages: [] }, pinnedAt([]), NOW, [
      stamp("repos/gamma.md"),
    ]);
    if ("error" in p) throw new Error(p.error);
    expect(
      pullBody(
        "demo",
        p.repos[0]!,
        { ...meta, reviewReasons: [] },
        "agent/demo/2026-09-30",
      ),
    ).toContain(
      "| Checks | schema, quotes, PR checker; no page changed, so there was no second check |",
    );
  });

  it("name the attribution check among the checks when it ran", () => {
    const body = (m: DeliveryMeta) =>
      pullBody("demo", plan().repos[0]!, m, "agent/demo/2026-09-30");
    expect(body({ ...meta, attributionChecked: true })).toContain(
      "| Checks | schema, quotes, PR checker, attribution check, second check approved |",
    );
    expect(body(meta)).toContain(
      "| Checks | schema, quotes, PR checker, second check approved |",
    );
  });
});

describe("the GitHub writer", () => {
  const TREE = "a".repeat(40);
  const SUB = "b".repeat(40);
  const BLOB = "9".repeat(40);
  const state = () => ({
    commits: { [BASE]: TREE },
    trees: {
      [TREE]: [{ path: "repos", type: "tree", sha: SUB, mode: "040000" }],
      [SUB]: [{ path: "engine.md", type: "blob", sha: BLOB, mode: "100644" }],
    },
    blobs: { [BLOB]: `${PAGE.join("\n")}\n` },
  });

  it("reads a file at a commit by walking its trees, with its mode", async () => {
    const gh = fakeGithubFetch(state());
    const w = new GithubWriter({
      token: "t0ken",
      apiUrl: "https://api.test",
      fetch: gh.fetch,
    });
    expect(await w.readFile(ATLAS, BASE, "repos/engine.md")).toEqual({
      text: `${PAGE.join("\n")}\n`,
      mode: "100644",
    });
    expect(await w.readFile(ATLAS, BASE, "repos/backend.md")).toBeUndefined();
    expect(
      gh.requests.every((r) => r.auth === "token t0ken" && r.method === "GET"),
    ).toBe(true);
  });

  it("commits on the base, creates the agent branch or moves it, and opens pull requests ready for review", async () => {
    const gh = fakeGithubFetch({
      ...state(),
      refs: { "agent/demo/2026-09-29": "3".repeat(40) },
    });
    const w = new GithubWriter({
      token: "t0ken",
      apiUrl: "https://api.test",
      fetch: gh.fetch,
    });
    const request = {
      base: BASE,
      message: "demo: 1 page",
      author: commitAuthor(),
      date: NOW,
      files: [{ path: "repos/engine.md", text: "new\n", mode: "100644" }],
    };
    await w.commitFiles(ATLAS, { ...request, branch: "agent/demo/2026-09-30" });
    await w.commitFiles(ATLAS, { ...request, branch: "agent/demo/2026-09-29" });
    await w.openPull(ATLAS, {
      branch: "agent/demo/2026-09-30",
      base: "main",
      title: "t",
      body: "b",
    });
    const writes = gh.requests.filter((r) => r.method !== "GET");
    const repo = "/repos/notes-co/atlas";
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${repo}/git/trees`,
      `POST ${repo}/git/commits`,
      `POST ${repo}/git/refs`,
      `POST ${repo}/git/trees`,
      `POST ${repo}/git/commits`,
      `PATCH ${repo}/git/refs/heads/agent/demo/2026-09-29`,
      `POST ${repo}/pulls`,
    ]);
    expect(writes[0]!.body).toEqual({
      base_tree: TREE,
      tree: [
        {
          path: "repos/engine.md",
          mode: "100644",
          type: "blob",
          content: "new\n",
        },
      ],
    });
    const who = { ...commitAuthor(), date: NOW.toISOString() };
    expect(writes[1]!.body).toEqual({
      message: "demo: 1 page",
      tree: "1".repeat(40),
      parents: [BASE],
      author: who,
      committer: who,
    });
    expect(writes[2]!.body).toEqual({
      ref: "refs/heads/agent/demo/2026-09-30",
      sha: "2".repeat(40),
    });
    expect(writes[5]!.body).toEqual({ sha: "2".repeat(40), force: true });
    expect(writes[6]!.body).toEqual({
      title: "t",
      head: "agent/demo/2026-09-30",
      base: "main",
      body: "b",
      draft: false,
      maintainer_can_modify: false,
    });
  });

  it("refuses any branch but an agent branch and any repository outside the organization, before sending anything", async () => {
    const gh = fakeGithubFetch(state());
    const w = new GithubWriter({
      token: "t0ken",
      apiUrl: "https://api.test",
      fetch: gh.fetch,
    });
    const request = {
      base: BASE,
      message: "m",
      author: commitAuthor(),
      date: NOW,
      files: [],
    };
    for (const branch of ["main", "agent/demo/main", "release/1.0"]) {
      await expect(
        w.commitFiles(ATLAS, { ...request, branch }),
      ).rejects.toThrow("is not an agent branch");
      await expect(w.deleteBranch(ATLAS, branch)).rejects.toThrow(
        "is not an agent branch",
      );
      await expect(
        w.openPull(ATLAS, { branch, base: "main", title: "t", body: "b" }),
      ).rejects.toThrow("is not an agent branch");
    }
    await expect(w.defaultBranch("octocat/atlas")).rejects.toThrow(
      "octocat/atlas is not a notes-co repository",
    );
    expect(gh.requests).toEqual([]);
    // Asking for a review and replying in a review thread are the review calls; none submits or approves. The one merge call merges only agent pull requests (below).
    expect(
      Object.getOwnPropertyNames(GithubWriter.prototype).filter((n) =>
        /merge|approve|review/i.test(n),
      ),
    ).toEqual(["replyToReviewComment", "requestReviewers", "mergePull"]);
  });

  it("merges only an open pull request from an agent branch of the same repository at the expected head", async () => {
    const head = "a".repeat(40);
    const pull = (
      over: Record<string, unknown> = {},
      h: Record<string, unknown> = {},
    ) => ({
      state: "open",
      head: {
        ref: "agent/demo/2026-10-07",
        sha: head,
        repo: { full_name: ATLAS },
        ...h,
      },
      ...over,
    });
    const writerFor = (p: unknown) => {
      const gh = fakeGithubFetch({ pull: p });
      return {
        gh,
        w: new GithubWriter({
          token: "t0ken",
          apiUrl: "https://api.test",
          fetch: gh.fetch,
        }),
      };
    };
    const ok = writerFor(pull());
    expect(await ok.w.mergePull(ATLAS, 42, head)).toEqual({
      sha: "9".repeat(40),
    });
    expect(ok.gh.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /repos/notes-co/atlas/pulls/42",
      "PUT /repos/notes-co/atlas/pulls/42/merge",
    ]);
    expect(ok.gh.requests[1]!.body).toEqual({
      merge_method: "squash",
      sha: head,
    });
    for (const [p, why] of [
      [pull({}, { ref: "main" }), "is not from an agent branch"],
      [
        pull({}, { repo: { full_name: "someone/atlas" } }),
        "is not from an agent branch",
      ],
      [pull({ state: "closed" }), "is not open"],
      [pull({}, { sha: "b".repeat(40) }), "moved past"],
    ] as const) {
      const bad = writerFor(p);
      await expect(bad.w.mergePull(ATLAS, 42, head)).rejects.toThrow(why);
      expect(bad.gh.requests.some((r) => r.method === "PUT")).toBe(false);
    }
  });

  it("asks for reviewers with one POST, and keeps GitHub's short reason when it refuses", async () => {
    const gh = fakeGithubFetch(state());
    const w = new GithubWriter({
      token: "t0ken",
      apiUrl: "https://api.test",
      fetch: gh.fetch,
    });
    await w.requestReviewers(ATLAS, 42, { reviewers: ["alice"] });
    await w.requestReviewers(ATLAS, 42, { teamReviewers: ["engineering"] });
    expect(
      gh.requests.map((r) => ({ call: `${r.method} ${r.path}`, body: r.body })),
    ).toEqual([
      {
        call: "POST /repos/notes-co/atlas/pulls/42/requested_reviewers",
        body: { reviewers: ["alice"], team_reviewers: [] },
      },
      {
        call: "POST /repos/notes-co/atlas/pulls/42/requested_reviewers",
        body: { reviewers: [], team_reviewers: ["engineering"] },
      },
    ]);
    const refusing = new GithubWriter({
      token: "t0ken",
      apiUrl: "https://api.test",
      fetch: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              message: "Reviews may only be requested from collaborators",
            }),
            { status: 422 },
          ),
        )) as typeof fetch,
    });
    await expect(
      refusing.requestReviewers(ATLAS, 42, { reviewers: ["outsider"] }),
    ).rejects.toThrow(
      /^POST \/repos\/notes-co\/atlas\/pulls\/42\/requested_reviewers returned 422: Reviews may only be requested from collaborators$/,
    );
    await expect(
      w.requestReviewers("octocat/atlas", 42, { reviewers: ["alice"] }),
    ).rejects.toThrow("is not a notes-co repository");
  });

  it("lists open pull requests with who opened them and from where, closes with a comment, and names only the status of a failure", async () => {
    const gh = fakeGithubFetch({
      pulls: [
        {
          number: 5,
          html_url: "u5",
          head: { ref: "agent/demo/2026-09-29", repo: { full_name: ATLAS } },
          user: { type: "Bot" },
        },
        {
          number: 6,
          html_url: "u6",
          head: {
            ref: "agent/demo/2026-09-28",
            repo: { full_name: "someone/atlas" },
          },
          user: { type: "User" },
        },
      ],
    });
    const w = new GithubWriter({
      token: "t0ken",
      apiUrl: "https://api.test",
      fetch: gh.fetch,
    });
    expect(await w.openPulls(ATLAS)).toEqual([
      {
        number: 5,
        url: "u5",
        branch: "agent/demo/2026-09-29",
        sameRepo: true,
        byBot: true,
      },
      {
        number: 6,
        url: "u6",
        branch: "agent/demo/2026-09-28",
        sameRepo: false,
        byBot: false,
      },
    ]);
    await w.closePull(ATLAS, 5, "Replaced by #42.");
    const repo = "/repos/notes-co/atlas";
    expect(
      gh.requests.slice(-2).map((r) => [r.method, r.path, r.body]),
    ).toEqual([
      ["POST", `${repo}/issues/5/comments`, { body: "Replaced by #42." }],
      ["PATCH", `${repo}/pulls/5`, { state: "closed" }],
    ]);
    await expect(w.readFile(ATLAS, "e".repeat(40), "x.md")).rejects.toThrow(
      `GET ${repo}/git/commits/${"e".repeat(40)} returned 404`,
    );
  });
});

describe("the writer app's token", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const env = {
    AGENTS_WRITER_APP_ID: "12",
    AGENTS_WRITER_PRIVATE_KEY: privateKey,
  };

  it("asks for contents, pull requests and checks write and members read on the target repositories only, and revokes it on close", async () => {
    const gh = fakeGithubFetch();
    const opened = await openGithubWriter(env, [ATLAS], {
      apiUrl: "https://api.test",
      fetch: gh.fetch,
    });
    expect(opened.secrets).toEqual([WRITER_TOKEN]);
    const create = gh.requests.find((r) => r.path.endsWith("/access_tokens"))!;
    expect(create.body).toEqual({
      repositories: ["atlas"],
      permissions: WRITE_PERMISSIONS,
    });
    expect(WRITE_PERMISSIONS).toEqual({
      checks: "write",
      contents: "write",
      members: "read",
      metadata: "read",
      pull_requests: "write",
    });
    expect(opened.missing).toBeUndefined();
    await opened.close();
    expect(gh.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/installation/token",
      auth: `token ${WRITER_TOKEN}`,
    });
  });

  it("goes on without checks and members when the installation has not accepted them, and says so", async () => {
    const gh = fakeGithubFetch({ lacking: ["checks"] });
    const opened = await openGithubWriter(env, [ATLAS], {
      apiUrl: "https://api.test",
      fetch: gh.fetch,
    });
    const asked = gh.requests
      .filter((r) => r.path.endsWith("/access_tokens"))
      .map((r) => (r.body as { permissions: object }).permissions);
    expect(asked).toEqual([WRITE_PERMISSIONS, BASE_WRITE_PERMISSIONS]);
    expect(opened.missing).toEqual(["checks", "members"]);
    await expect(
      opened.writer.createCheck(ATLAS, {
        name: "Notes Agent / demo",
        branch: "agent/demo/2026-10-06",
        headSha: "a".repeat(40),
        status: "completed",
        conclusion: "success",
        title: "t",
        summary: "s",
      }),
    ).rejects.toThrow("the writer app has no Checks permission");
    expect(gh.requests.some((r) => r.path.includes("/check-runs"))).toBe(false);
  });

  it("writes check runs only on the head commit of one of the job's own branches", async () => {
    const head = "a".repeat(40);
    const gh = fakeGithubFetch({
      refs: { "agent/demo/2026-10-06": head },
      checkRuns: [{ id: 5, status: "queued" }],
    });
    const w = new GithubWriter({
      token: "t0ken",
      apiUrl: "https://api.test",
      fetch: gh.fetch,
    });
    const fields = {
      status: "completed" as const,
      conclusion: "success" as const,
      title: "2 pages changed, second check approved",
      summary: "s",
      detailsUrl:
        "https://github.com/notes-co/agents/actions/runs/1",
    };
    expect(
      await w.createCheck(ATLAS, {
        name: "Notes Agent / demo",
        branch: "agent/demo/2026-10-06",
        headSha: head,
        ...fields,
      }),
    ).toBe(77);
    const post = gh.requests.find((r) => r.path.endsWith("/check-runs"))!;
    expect(post.body).toMatchObject({
      name: "Notes Agent / demo",
      head_sha: head,
      status: "completed",
      conclusion: "success",
      details_url: fields.detailsUrl,
      output: { title: fields.title, summary: "s" },
    });
    await w.updateCheck(ATLAS, 5, {
      status: "in_progress",
      title: "t",
      summary: "s",
    });
    expect(gh.requests.at(-1)).toMatchObject({
      method: "PATCH",
      path: "/repos/notes-co/atlas/check-runs/5",
      body: { status: "in_progress", output: { title: "t", summary: "s" } },
    });
    expect(await w.findChecks(ATLAS, head, "Notes Agent / demo")).toEqual([
      { id: 5, status: "queued" },
    ]);
    for (const branch of ["main", "release/1.0"])
      await expect(
        w.createCheck(ATLAS, { name: "x", branch, headSha: head, ...fields }),
      ).rejects.toThrow("is not an agent branch");
    await expect(
      w.createCheck(ATLAS, {
        name: "x",
        branch: "agent/demo/2026-10-06",
        headSha: "b".repeat(40),
        ...fields,
      }),
    ).rejects.toThrow("is not at bbbbbbbbbbbb, so no check run was written");
  });

  it("refuses and revokes a token granted more permissions or repositories than it asked for", async () => {
    const wider = fakeGithubFetch({
      granted: { permissions: { ...WRITE_PERMISSIONS, workflows: "write" } },
    });
    await expect(
      openGithubWriter(env, [ATLAS], {
        apiUrl: "https://api.test",
        fetch: wider.fetch,
      }),
    ).rejects.toThrow(
      "the installation token was granted more than the access it asked for (workflows:write); it was revoked",
    );
    const more = fakeGithubFetch({
      granted: { repositories: ["atlas", "backend"] },
    });
    await expect(
      openGithubWriter(env, [ATLAS], {
        apiUrl: "https://api.test",
        fetch: more.fetch,
      }),
    ).rejects.toThrow(
      "the installation token reaches repositories it did not ask for (backend); it was revoked",
    );
    for (const gh of [wider, more])
      expect(gh.requests.at(-1)).toMatchObject({
        method: "DELETE",
        path: "/installation/token",
      });
  });

  it("needs both secrets", async () => {
    await expect(openGithubWriter({}, [ATLAS])).rejects.toThrow(
      "AGENTS_WRITER_APP_ID and AGENTS_WRITER_PRIVATE_KEY must be set to open pull requests",
    );
  });
});

describe("review requests", () => {
  const ENGINE = "notes-co/engine";
  const BACKEND = "notes-co/backend";
  const commitSource = (repo: string, sha: string, authors?: string[]) => ({
    kind: "commit" as const,
    repo,
    commit: sha,
    date: "2026-09-29T00:00:00Z",
    title: "a change",
    files: [{ path: "src/config.rs", status: "modified" }],
    excerpt: [],
    ...(authors === undefined ? {} : { authors }),
  });
  const sources = [
    commitSource(ENGINE, "f".repeat(40), ["alice", "bob"]),
    commitSource(BACKEND, "d".repeat(40), ["carol"]),
    commitSource(ENGINE, "e".repeat(40)),
  ];
  const cited = (
    evidence: { repo: string; commit?: string; path?: string }[],
  ) => ({
    ...patched,
    changes: [{ ...patched.changes![0]!, evidence }],
  });
  const reviewPlan = (page: ProposedPage, team?: string) => {
    const p = planDelivery(
      "demo",
      { pages: [page] },
      {
        ...context(),
        policy: {
          ...policy,
          ...(team === undefined ? {} : { reviewTeam: team }),
        },
        sources,
      },
      NOW,
    );
    if ("error" in p) throw new Error(p.error);
    return p;
  };
  const writer = () => {
    const w = new FakeWriter();
    w.put(ATLAS, BASE, "repos/engine.md", `${PAGE.join("\n")}\n`);
    return w;
  };

  it("asks the people whose changes the patch cites, once each, never the authors of changes it does not cite", () => {
    const p = reviewPlan(
      cited([
        { repo: ENGINE, commit: "f".repeat(40) },
        { repo: ENGINE, commit: "fffffff", path: "src/config.rs" },
        { repo: ENGINE, commit: "e".repeat(40) },
      ]),
    );
    expect(p.repos[0]!.reviewers).toEqual(["alice", "bob"]);
  });

  it("takes at most ten people and never a login GitHub would not have", () => {
    expect(
      citedAuthors(
        [
          {
            changes: [
              {
                removed: [],
                added: [],
                evidence: [{ repo: ENGINE, commit: "f".repeat(40) }],
              },
            ],
          },
        ],
        [
          commitSource(ENGINE, "f".repeat(40), [
            ...Array.from({ length: 12 }, (_, i) => `dev${i}`),
            "Dev0",
            "bot[bot]",
          ]),
        ],
      ),
    ).toEqual(Array.from({ length: 10 }, (_, i) => `dev${i}`));
    expect(
      citedAuthors(
        [
          {
            changes: [
              {
                removed: [],
                added: [],
                evidence: [{ repo: ENGINE, commit: "f".repeat(40) }],
              },
            ],
          },
        ],
        [
          commitSource(ENGINE, "f".repeat(40), [
            "-x",
            "a b",
            "agents[bot]",
          ]),
        ],
      ),
    ).toEqual([]);
  });

  it("asks each person and the team on a new pull request, one request each", async () => {
    const w = writer();
    const [pull] = await deliverPlan(
      reviewPlan(
        cited([
          { repo: ENGINE, commit: "f".repeat(40) },
          { repo: BACKEND, commit: "d".repeat(40) },
        ]),
        "engineering",
      ),
      { ...policy, reviewTeam: "engineering" },
      w,
      meta,
      NOW,
    );
    expect(pull!.reviews).toEqual({
      requested: ["alice", "bob", "carol", "team:engineering"],
      refused: [],
    });
    expect(w.calls.filter((c) => c.startsWith("requestReviewers"))).toEqual([
      `requestReviewers ${ATLAS} #${pull!.number} alice`,
      `requestReviewers ${ATLAS} #${pull!.number} bob`,
      `requestReviewers ${ATLAS} #${pull!.number} carol`,
      `requestReviewers ${ATLAS} #${pull!.number} team:engineering`,
    ]);
  });

  it("records whom GitHub refuses and still asks the others, without failing delivery", async () => {
    const w = writer();
    w.refuseReviewers.add("bob");
    w.refuseReviewers.add("team:engineering");
    const [pull] = await deliverPlan(
      reviewPlan(cited([{ repo: ENGINE, commit: "f".repeat(40) }])),
      { ...policy, reviewTeam: "engineering" },
      w,
      meta,
      NOW,
    );
    expect(pull!.reviews).toEqual({
      requested: ["alice"],
      refused: [
        {
          who: "bob",
          why: `POST /repos/${ATLAS}/pulls/${pull!.number}/requested_reviewers returned 422`,
        },
        {
          who: "team:engineering",
          why: `POST /repos/${ATLAS}/pulls/${pull!.number}/requested_reviewers returned 422`,
        },
      ],
    });
    expect(w.pulls.find((p) => p.number === pull!.number)!.state).toBe("open");
  });

  it("asks no one again when it updates today's pull request or writes a revision", async () => {
    const w = writer();
    const today = w.open({ repo: ATLAS, branch: "agent/demo/2026-09-30" });
    const p = reviewPlan(cited([{ repo: ENGINE, commit: "f".repeat(40) }]));
    const [pull] = await deliverPlan(
      p,
      { ...policy, reviewTeam: "engineering" },
      w,
      meta,
      NOW,
    );
    expect(pull).toMatchObject({ number: today.number, updated: true });
    expect(pull!.reviews).toBeUndefined();
    w.branches.set(`${ATLAS}:agent/demo/2026-09-30`, BASE);
    await deliverRevision(
      { ...p, branch: "agent/demo/2026-09-30" },
      { ...policy, reviewTeam: "engineering" },
      w,
      { runName: "job-demo-2", round: 1 },
      NOW,
    );
    expect(w.calls.some((c) => c.startsWith("requestReviewers"))).toBe(false);
  });
});
