import { describe, expect, it } from "vitest";
import type {
  CheckContext,
  ProposedPage,
  Source,
} from "../src/output-check/pr.ts";
import {
  creditCommitBytes,
  creditedCommits,
  creditPatchLines,
  creditsOf,
  MAX_PAGE_COMMIT_BYTES,
  MAX_PAGE_CREDITS,
  pacificDay,
  pageCredits,
} from "../src/run-job/review-commits.ts";
import {
  buildReviewInput,
  fitReviewInput,
  reviewPrompt,
} from "../src/run-job/review.ts";
import { citedFileReader } from "../src/run-job/run.ts";

const ATLAS = "notes-co/atlas";
const ACTION = "notes-co/action-notes-survey";
const PARENT = "1".repeat(40);
const BRANCH = "2".repeat(40);
const MERGE29 = "f5369383b27f7a8fb168d634aadef0afd4e0aec8";
const MERGE30 = "89cdcdd9286f5132ccbc5a0ac86d35d6e6f4f5a7";
const FEATURE = "a201dd7abf8b1951139c249ddce16af0214ab49d";

const commitSource = (commit: string, title: string): Source => ({
  kind: "commit",
  repo: ACTION,
  commit,
  date: "2026-09-15T14:54:32Z",
  title,
  files: [{ path: "action.yml", status: "modified" }],
  excerpt: [],
});

function context(sources: Source[] = []): CheckContext {
  return {
    policy: { repos: [ATLAS], paths: ["repos/*.md"], maxChangedLines: 800 },
    pinned: [],
    sources,
  };
}

function page(
  added: string[],
  evidence: { repo: string; commit?: string; path?: string }[] = [
    { repo: ACTION, commit: MERGE29, path: "action.yml" },
  ],
  path = "repos/action-notes-survey.md",
  removed: string[] = [],
): ProposedPage {
  return {
    repo: ATLAS,
    path,
    decision: "patch",
    reason: "r",
    patch: "p",
    changes: [{ removed, added, evidence }],
  };
}

const file = (filename: string, patch: string) => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch,
});

/** A stand-in for GitHub's API: answers by path, undefined for anything else, and records each path read. */
function github(answers: Record<string, unknown>) {
  const paths: string[] = [];
  return {
    paths,
    read: (path: string) => {
      paths.push(path);
      const answer = answers[path];
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer);
    },
  };
}

const repoApi = `/repos/notes-co/action-notes-survey`;

const mergeCommit = (sha: string, n: number, date: string) => ({
  sha,
  commit: {
    message: `Merge pull request #${n} from notes-co/branch\n\nbody`,
    committer: { date },
    author: { date: "2026-08-27T10:00:00Z" },
  },
  parents: [{ sha: PARENT }, { sha: BRANCH }],
  files: [file("ignored.txt", "+not the pull request's diff")],
});

const pull = (n: number, merge: string, mergedAt: string | null) => ({
  number: n,
  title: `Pull request ${n}`,
  merged_at: mergedAt,
  merge_commit_sha: merge,
  base: { ref: "main", repo: { default_branch: "main" } },
});

const ANSWERS: Record<string, unknown> = {
  [`${repoApi}/commits/f536938`]: mergeCommit(
    MERGE29,
    29,
    "2026-09-15T14:54:32Z",
  ),
  [`${repoApi}/commits/${MERGE29}`]: mergeCommit(
    MERGE29,
    29,
    "2026-09-15T14:54:32Z",
  ),
  [`${repoApi}/commits/${MERGE29}/pulls`]: [
    pull(29, MERGE29, "2026-09-15T14:54:32Z"),
  ],
  [`${repoApi}/compare/${PARENT}...${MERGE29}`]: {
    commits: [
      {
        sha: BRANCH,
        commit: {
          message: "Add image mode",
          committer: { date: "2026-08-27T10:00:00Z" },
        },
      },
    ],
    files: [
      file("README.md", "+image mode"),
      file("action.yml", "   subject:\n     required: true\n+  image:"),
    ],
  },
  [`${repoApi}/pulls/29`]: pull(29, MERGE29, "2026-09-15T14:54:32Z"),
};

describe("what a change credits", () => {
  it("is every commit sha with a digit and pull request number its added lines name, in the repositories its evidence cites, never the job's own", () => {
    const got = creditsOf(
      [
        "- 2026-09-15 PR #29 (merge f536938): image mode; see notes-cli#12 and atlas#4.",
        "Fixed by `defaced` and abc1234567; &#123; is an entity.",
      ],
      [],
      [
        { repo: ACTION, commit: MERGE29, path: "action.yml" },
        { repo: ATLAS, commit: MERGE29, path: "INDEX.md" },
      ],
      [ATLAS],
    );
    expect(got).toEqual([
      { repos: [ACTION], ref: "f536938" },
      { repos: [ACTION], ref: "abc1234567" },
      { repos: [ACTION], ref: "#29" },
      { repos: ["notes-co/notes-cli"], ref: "#12" },
    ]);
  });

  it("includes a commit cited with no path, at the commit its source resolves to", () => {
    const ctx = context([commitSource(FEATURE, "Replace RepoType")]);
    const got = pageCredits(
      page(
        ["format x host model since 2026-09-29"],
        [{ repo: ACTION, commit: FEATURE.slice(0, 7) }],
      ),
      ctx,
    );
    expect(got).toEqual([{ repos: [ACTION], ref: FEATURE, cited: true }]);
  });

  it("puts credits the removed lines already make after the new ones", () => {
    const got = pageCredits(
      page(
        ["- PR #30 (merge 89cdcdd) and PR #8 (merge ae08049)"],
        undefined,
        undefined,
        ["- PR #8 (merge ae08049)"],
      ),
      context(),
    );
    expect(got.map((c) => `${c.ref}${c.kept ? " kept" : ""}`)).toEqual([
      "89cdcdd",
      "#30",
      "ae08049 kept",
      "#8 kept",
    ]);
  });
});

describe("the commits a proposal credits", () => {
  it("show a merge commit's whole pull request, its subject, when it landed and the pull request, once for a sha and a number that name it", async () => {
    const gh = github(ANSWERS);
    const got = await creditedCommits(
      [page(["- 2026-09-15 PR #29 (merge f536938): image input added."])],
      context(),
      gh.read,
    );
    expect(got).toEqual([
      {
        repo: ACTION,
        named: ["f536938", "#29"],
        sha: MERGE29,
        subject: "Merge pull request #29 from notes-co/branch",
        committed_at: "2026-09-15T14:54:32Z",
        landed_at: "2026-09-15T14:54:32Z",
        landed_day_pacific: "2026-09-15",
        pull: {
          number: 29,
          title: "Pull request 29",
          merged_at: "2026-09-15T14:54:32Z",
          merge_commit: MERGE29,
        },
        commits: [
          {
            sha: BRANCH,
            date: "2026-08-27T10:00:00Z",
            subject: "Add image mode",
          },
        ],
        files: [
          {
            path: "action.yml",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "   subject:\n     required: true\n+  image:",
          },
          {
            path: "README.md",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "+image mode",
          },
        ],
      },
    ]);
    // The merge commit's own file list is never used; the comparison with its first parent is.
    expect(gh.paths).toContain(`${repoApi}/compare/${PARENT}...${MERGE29}`);
    expect(JSON.stringify(got)).not.toContain("ignored.txt");
  });

  it("date a branch commit by the merge of the pull request that landed it, not its own date", async () => {
    const gh = github({
      [`${repoApi}/commits/${FEATURE}`]: {
        sha: FEATURE,
        commit: {
          message: "Replace RepoType",
          committer: { date: "2026-09-28T09:17:18Z" },
        },
        parents: [{ sha: PARENT }],
        files: [file("Repository.scala", "+enum Format")],
      },
      [`${repoApi}/commits/${FEATURE}/pulls`]: [
        { ...pull(55, "3".repeat(40), null) },
        {
          ...pull(
            56,
            "5ebfbe1cde85f482c886fdcabaa64936c4f6e5e4",
            "2026-09-29T18:50:23Z",
          ),
        },
      ],
    });
    const got = await creditedCommits(
      [page(["model since 2026-09-29"], [{ repo: ACTION, commit: FEATURE }])],
      context([commitSource(FEATURE, "Replace RepoType")]),
      gh.read,
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      sha: FEATURE,
      cited: true,
      named: [],
      committed_at: "2026-09-28T09:17:18Z",
      landed_at: "2026-09-29T18:50:23Z",
      pull: { number: 56, merged_at: "2026-09-29T18:50:23Z" },
      files: [{ path: "Repository.scala", patch: "+enum Format" }],
    });
    expect(got[0]!.commits).toBeUndefined();
  });

  it("give a merge at 18:30 Pacific time the Pacific day, the day before its UTC landed_at", async () => {
    const gh = github({
      [`${repoApi}/commits/${FEATURE}`]: {
        sha: FEATURE,
        commit: {
          message: "Evening change",
          committer: { date: "2026-10-08T20:00:00Z" },
        },
        parents: [{ sha: PARENT }],
        files: [file("action.yml", "+  image:")],
      },
      [`${repoApi}/commits/${FEATURE}/pulls`]: [
        pull(
          41,
          "5ebfbe1cde85f482c886fdcabaa64936c4f6e5e4",
          "2026-10-09T01:30:00Z",
        ),
      ],
    });
    const got = await creditedCommits(
      [
        page(
          ["- 2026-10-08: PR #41 (merge a201dd7) image input."],
          [{ repo: ACTION, commit: FEATURE }],
        ),
      ],
      context([commitSource(FEATURE, "Evening change")]),
      gh.read,
    );
    expect(got[0]).toMatchObject({
      landed_at: "2026-10-09T01:30:00Z",
      landed_day_pacific: "2026-10-08",
    });
    expect(pacificDay("2026-10-09T07:00:00Z")).toBe("2026-10-09");
    expect(pacificDay("not a time")).toBeUndefined();
  });

  it("leave out a sha or number GitHub does not know, note what could not be read, and say when a named pull request is not merged", async () => {
    const gh = github({
      [`${repoApi}/commits/deadbee1`]: new Error("GitHub answered 502"),
      [`${repoApi}/pulls/31`]: pull(31, "", null),
    });
    const got = await creditedCommits(
      [page(["Commits 1234567 and deadbee1; PR #31 and #32."])],
      context(),
      gh.read,
    );
    expect(got).toEqual([
      {
        repo: ACTION,
        named: ["deadbee1"],
        note: "could not be read: GitHub answered 502",
      },
      {
        repo: ACTION,
        named: ["#31"],
        pull: { number: 31, title: "Pull request 31", merged_at: null },
        note: "this pull request is not merged",
      },
    ]);
  });

  it("read every credit of a page that names many, each with a diff, with fewer lines per file instead of fewer credits", async () => {
    const big = "+".concat("x".repeat(100)).concat("\n").repeat(118);
    const answers: Record<string, unknown> = {};
    const shas = Array.from(
      { length: 45 },
      (_, i) => `${String(i + 10).padStart(7, "0")}${"a".repeat(33)}`,
    );
    for (const sha of shas) {
      answers[`${repoApi}/commits/${sha.slice(0, 8)}`] = {
        sha,
        commit: { message: "c", committer: { date: "2026-10-01T00:00:00Z" } },
        parents: [{ sha: PARENT }],
        files: Array.from({ length: 4 }, (_, i) => file(`f${i}.txt`, big)),
      };
      answers[`${repoApi}/commits/${sha}/pulls`] = [];
    }
    const got = await creditedCommits(
      [page([shas.map((s) => s.slice(0, 8)).join(" ")])],
      context(),
      github(answers).read,
    );
    expect(got).toHaveLength(45);
    expect(got.map((c) => c.named[0])).toEqual(shas.map((s) => s.slice(0, 8)));
    const lines = creditPatchLines(45);
    expect(lines).toBe(42);
    for (const c of got) {
      expect(c.note).toBeUndefined();
      expect(c.files![0]!.patch!.split("\n")).toHaveLength(lines);
      expect(JSON.stringify(c).length).toBeLessThanOrEqual(
        creditCommitBytes(45) + 2_000,
      );
    }
    const total = got.reduce((n, c) => n + JSON.stringify(c).length, 0);
    expect(total).toBeLessThanOrEqual(MAX_PAGE_COMMIT_BYTES + 45 * 2_000);
  });

  it("list the credits of a page past the limit unread, with a note, without reading them", async () => {
    const answers: Record<string, unknown> = {};
    const shas = Array.from(
      { length: MAX_PAGE_CREDITS + 3 },
      (_, i) => `${String(i + 10).padStart(7, "0")}${"b".repeat(33)}`,
    );
    for (const sha of shas) {
      answers[`${repoApi}/commits/${sha.slice(0, 8)}`] = {
        sha,
        commit: { message: "c", committer: { date: "2026-10-01T00:00:00Z" } },
        parents: [{ sha: PARENT }],
        files: [file("a.txt", "+a")],
      };
      answers[`${repoApi}/commits/${sha}/pulls`] = [];
    }
    const gh = github(answers);
    const got = await creditedCommits(
      [page([shas.map((s) => s.slice(0, 8)).join(" ")])],
      context(),
      gh.read,
    );
    expect(got).toHaveLength(MAX_PAGE_CREDITS + 3);
    expect(got.slice(-3)).toEqual(
      shas.slice(-3).map((s) => ({
        repo: ACTION,
        named: [s.slice(0, 8)],
        note: `not read: the page credits more than ${MAX_PAGE_CREDITS} commits and pull requests`,
      })),
    );
    for (const s of shas.slice(-3))
      expect(gh.paths.some((p) => p.includes(s.slice(0, 8)))).toBe(false);
  });
});

describe("credited commits in the second check's input", () => {
  it("go with the page that credits them when the proposal is split per page, and their diffs are cut before cited files are left out", async () => {
    const pages = [
      page(["- PR #29 (merge f536938): image input added."]),
      page(
        ["Listens on port 9090."],
        [{ repo: ACTION, commit: MERGE29, path: "action.yml" }],
        "repos/other.md",
      ),
    ];
    const ctx = context([commitSource(MERGE29, "Merge pull request #29")]);
    const input = buildReviewInput(pages, ctx, "x");
    input.credited_commits = await creditedCommits(
      pages,
      ctx,
      github(ANSWERS).read,
    );
    const fitted = fitReviewInput(
      input,
      Buffer.byteLength(JSON.stringify(input)) - 10,
    );
    expect(fitted.inputs).toHaveLength(2);
    expect(fitted.inputs[0]!.credited_commits).toHaveLength(1);
    expect(fitted.inputs[1]!.credited_commits).toEqual([]);

    const long = "+line\n".repeat(200);
    const one = buildReviewInput([pages[0]!], ctx, "x");
    one.credited_commits = structuredClone(input.credited_commits);
    one.credited_commits[0]!.files![0]!.patch = long;
    one.cited_files = [
      {
        repo: ACTION,
        commit: MERGE29,
        path: "action.yml",
        lines: 1,
        shown: "all",
        text: "1: subject:",
      },
    ];
    const cut = fitReviewInput(
      one,
      Buffer.byteLength(JSON.stringify(one)) - 100,
    );
    const trimmed = cut.inputs[0]!;
    expect(trimmed.trimmed).toEqual([
      `credited commit ${ACTION}@${MERGE29.slice(0, 12)}: diff cut to 20 lines per file`,
    ]);
    expect(
      trimmed.credited_commits![0]!.files![0]!.patch!.split("\n"),
    ).toHaveLength(20);
    expect(trimmed.credited_commits![0]!.files![0]!.patch_cut).toBe(true);
    expect(trimmed.cited_files![0]!.text).toBe("1: subject:");
  });

  it("are explained to the second check, with the rules for history lines and their dates", () => {
    const prompt = reviewPrompt();
    expect(prompt).toContain("`credited_commits`");
    expect(prompt).toContain(
      "that commit's diff there does not show that change, or\n  shows another commit made it",
    );
    expect(prompt).toContain("`landed_at`");
    expect(prompt).toContain(
      "is not the credited change's `landed_day_pacific`",
    );
    expect(prompt).toContain(
      "Never judge that date by\n  the UTC day of `landed_at`, a commit's own `committed_at`",
    );
  });
});

describe("the reader's GitHub JSON reads", () => {
  it("share the cited file reader's token, treat 404 and 422 as unknown and read only repository paths", async () => {
    const calls: string[] = [];
    let made = 0;
    const reader = citedFileReader(
      {},
      () => undefined,
      ((url: string, init: RequestInit) => {
        calls.push(`${url} ${(init.headers as Record<string, string>).accept}`);
        if (url.endsWith("/missing"))
          return Promise.resolve(new Response("", { status: 404 }));
        if (url.endsWith("/unknown"))
          return Promise.resolve(new Response("", { status: 422 }));
        if (url.endsWith("/broken"))
          return Promise.resolve(new Response("", { status: 500 }));
        return Promise.resolve(new Response('{"sha":"x"}'));
      }) as typeof fetch,
      () => {
        made += 1;
        return Promise.resolve({ token: "t0k", revoke: async () => undefined });
      },
    );
    expect(await reader.json(`${repoApi}/commits/abc1234`)).toEqual({
      sha: "x",
    });
    expect(await reader.json(`${repoApi}/commits/missing`)).toBeUndefined();
    expect(await reader.json(`${repoApi}/commits/unknown`)).toBeUndefined();
    await expect(reader.json(`${repoApi}/commits/broken`)).rejects.toThrow(
      "GitHub answered 500",
    );
    await expect(reader.json("/user")).rejects.toThrow(
      "/user is not a repository path",
    );
    await reader.read(ACTION, MERGE29, "action.yml");
    expect(made).toBe(1);
    expect(calls[0]).toBe(
      `https://api.github.com${repoApi}/commits/abc1234 application/vnd.github+json`,
    );
  });
});
