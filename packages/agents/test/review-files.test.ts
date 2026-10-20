import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  Change,
  CheckContext,
  ProposedPage,
} from "../src/output-check/pr.ts";
import { citedFileReader } from "../src/run-job/run.ts";
import {
  citationProblems,
  citedFiles,
  type CitedFile,
  MAX_FILE_LINES,
  MAX_FILES,
  MAX_PAGE_BYTES,
  trimFile,
  wantedFiles,
} from "../src/run-job/review-files.ts";
import { reviewPrompt } from "../src/run-job/review.ts";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

function context(sources: unknown[]): CheckContext {
  return { sources } as unknown as CheckContext;
}

const commitSource = (commit: string, paths: string[]) => ({
  kind: "commit",
  repo: "notes-co/widget",
  commit,
  date: "2026-10-01T00:00:00Z",
  title: "A change (#77)",
  files: paths.map((path) => ({ path, status: "modified" })),
  excerpt: [],
});

function page(
  evidence: { repo: string; commit?: string; path?: string; line?: number }[][],
  added = ["Uses `ImageScanner` for images."],
): ProposedPage {
  return {
    repo: "notes-co/atlas",
    path: "repos/widget.md",
    decision: "patch",
    reason: "r",
    patch: "p",
    changes: evidence.map((ev) => ({ removed: [], added, evidence: ev })),
  } as unknown as ProposedPage;
}

describe("the files a proposal cites", () => {
  it("are each file cited by path into a commit source, once, at the source's full commit", () => {
    const ctx = context([commitSource(SHA, ["action.yml", "src/a.scala"])]);
    const cite = {
      repo: "notes-co/widget",
      commit: SHA.slice(0, 7),
      path: "action.yml",
    };
    const wanted = wantedFiles(
      [page([[cite], [cite, { ...cite, path: "src/a.scala" }]])],
      ctx,
    );
    expect(wanted.map((w) => `${w.commit}:${w.path}`)).toEqual([
      `${SHA}:action.yml`,
      `${SHA}:src/a.scala`,
    ]);
    expect(wanted[0]!.needles.has("ImageScanner")).toBe(true);
  });

  it("leave out commit citations with no path, unresolved citations and code sources that carry their lines", () => {
    const ctx = context([
      commitSource(SHA, ["action.yml"]),
      {
        kind: "code",
        repo: "notes-co/widget",
        commit: SHA2,
        path: "x.scala",
        start_line: 1,
        lines: ["a", "b"],
      },
    ]);
    const wanted = wantedFiles(
      [
        page([
          [{ repo: "notes-co/widget", commit: SHA }],
          [{ repo: "notes-co/widget", commit: SHA, path: "nope.yml" }],
          [
            {
              repo: "notes-co/widget",
              commit: SHA2,
              path: "x.scala",
              line: 1,
            },
          ],
        ]),
      ],
      ctx,
    );
    expect(wanted).toEqual([]);
  });
});

describe("a cited file's content", () => {
  it("is shown whole and numbered when it fits", () => {
    expect(trimFile("one\ntwo\n", [])).toEqual({
      text: "1: one\n2: two",
      shown: "all",
      lines: 2,
    });
  });

  it("is cut to the lines around what the change names when the file is too long", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`);
    lines[1499] = "val scanner = new ImageScanner()";
    const got = trimFile(lines.join("\n"), ["ImageScanner"]);
    expect(got.shown).toBe("excerpts");
    expect(got.lines).toBe(2000);
    expect(got.text).toContain("1500: val scanner = new ImageScanner()");
    expect(got.text.startsWith("...\n1485: ")).toBe(true);
    expect(got.text.endsWith("1515: line 1515\n...")).toBe(true);
  });

  it("falls back to the start of the file, within the line cap, when nothing named is found", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`);
    const got = trimFile(lines.join("\n"), ["NotThere"]);
    expect(got.text.split("\n").filter((l) => l !== "...")).toHaveLength(
      MAX_FILE_LINES,
    );
    expect(got.text.startsWith("1: line 1\n")).toBe(true);
  });
});

describe("cited files for the second check", () => {
  const ctx = context([commitSource(SHA, ["action.yml", "gone.yml", "x.yml"])]);
  const cite = (path: string) => ({
    repo: "notes-co/widget",
    commit: SHA,
    path,
  });

  it("are read once each, and an unreadable or missing file is noted instead of failing", async () => {
    const reads: string[] = [];
    const got = await citedFiles(
      [
        page([
          [cite("action.yml"), cite("gone.yml")],
          [cite("action.yml")],
          [cite("x.yml")],
        ]),
      ],
      ctx,
      (_repo, _commit, path) => {
        reads.push(path);
        if (path === "gone.yml") return Promise.resolve(undefined);
        if (path === "x.yml")
          return Promise.reject(new Error("GitHub answered 500\nmore"));
        return Promise.resolve("inputs:\n  image: x\n");
      },
    );
    expect(reads).toEqual(["action.yml", "gone.yml", "x.yml"]);
    expect(got).toEqual([
      {
        repo: "notes-co/widget",
        commit: SHA,
        path: "action.yml",
        lines: 2,
        shown: "all",
        text: "1: inputs:\n2:   image: x",
      },
      {
        repo: "notes-co/widget",
        commit: SHA,
        path: "gone.yml",
        note: "does not exist at this commit",
      },
      {
        repo: "notes-co/widget",
        commit: SHA,
        path: "x.yml",
        note: "could not be read: GitHub answered 500",
      },
    ]);
  });

  it("stop at the file count cap with a note for the rest", async () => {
    const paths = Array.from({ length: MAX_FILES + 2 }, (_, i) => `f${i}.yml`);
    const got = await citedFiles(
      [page([paths.map(cite)])],
      context([commitSource(SHA, paths)]),
      () => Promise.resolve("a\n"),
    );
    expect(got.filter((f) => f.text !== undefined)).toHaveLength(MAX_FILES);
    expect(got.at(-1)!.note).toMatch(/limit on cited file content/);
  });
});

describe("each page's share of cited file content", () => {
  it("shows an 825-line file whole, and gives each page its own budget", async () => {
    const lines = Array.from({ length: 825 }, (_, i) => `case Kind${i}`);
    const file = lines.join("\n");
    const other = (path: string) => ({
      ...page([[{ repo: "notes-co/widget", commit: SHA, path }]]),
      path,
    });
    // Two pages, each citing files that together fill most of a page budget.
    const big = (n: number) =>
      Array.from(
        { length: 900 },
        (_, i) => `p${n} line ${i} ${"x".repeat(60)}`,
      ).join("\n");
    const bigPaths = Array.from({ length: 6 }, (_, i) => `big${i}.scala`);
    const pageA = {
      ...page([
        bigPaths.slice(0, 3).map((path) => ({
          repo: "notes-co/widget",
          commit: SHA,
          path,
        })),
      ]),
      path: "repos/a.md",
    } as ProposedPage;
    const pageB = {
      ...page([
        bigPaths.slice(3).map((path) => ({
          repo: "notes-co/widget",
          commit: SHA,
          path,
        })),
      ]),
      path: "repos/b.md",
    } as ProposedPage;
    const got = await citedFiles(
      [other("Repository.scala") as ProposedPage, pageA, pageB],
      context([commitSource(SHA, ["Repository.scala", ...bigPaths])]),
      (_r, _c, path) =>
        Promise.resolve(
          path === "Repository.scala" ? file : big(Number(path.slice(3, 4))),
        ),
    );
    const repo = got.find((f) => f.path === "Repository.scala")!;
    expect(repo.shown).toBe("all");
    expect(repo.text).toContain("825: case Kind824");
    const shownBig = got.filter(
      (f) => f.path.startsWith("big") && f.text !== undefined,
    );
    const perPage = (paths: string[]) =>
      shownBig
        .filter((f) => paths.includes(f.path))
        .reduce((n, f) => n + f.text!.length, 0);
    expect(perPage(bigPaths.slice(0, 3))).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    // The second page is not starved by the first.
    expect(shownBig.some((f) => bigPaths.slice(3).includes(f.path))).toBe(true);
  });
});

describe("the second check's prompt", () => {
  it("says a file citation is judged against the file content shown", () => {
    expect(reviewPrompt()).toContain("`cited_files`");
    expect(reviewPrompt()).toContain(
      "judge a change against this content, not only against the",
    );
  });
});

describe("the cited file reader", () => {
  it("makes one reader token, reads raw content at the commit, treats 404 as missing and revokes on close", async () => {
    const calls: string[] = [];
    let made = 0;
    let revoked = 0;
    const secrets: string[] = [];
    const reader = citedFileReader(
      {},
      (s) => secrets.push(s),
      ((url: string, init: RequestInit) => {
        calls.push(`${url} ${(init.headers as Record<string, string>).accept}`);
        if (url.includes("missing"))
          return Promise.resolve(new Response("", { status: 404 }));
        return Promise.resolve(new Response("body"));
      }) as typeof fetch,
      () => {
        made += 1;
        return Promise.resolve({
          token: "t0k",
          revoke: async () => void (revoked += 1),
        });
      },
    );
    expect(
      await reader.read("notes-co/widget", SHA, "src/a b.yml"),
    ).toBe("body");
    expect(
      await reader.read("notes-co/widget", SHA, "missing.yml"),
    ).toBeUndefined();
    await reader.close();
    expect(made).toBe(1);
    expect(revoked).toBe(1);
    expect(secrets).toEqual(["t0k"]);
    expect(calls[0]).toBe(
      `https://api.github.com/repos/notes-co/widget/contents/src/a%20b.yml?ref=${SHA} application/vnd.github.raw+json`,
    );
  });
});

describe("citations the cited files disprove", () => {
  const ctx = context([commitSource(SHA, ["action.yml", "gone.yml"])]);
  const cite = (path: string, line?: number) => ({
    repo: "notes-co/widget",
    commit: SHA.slice(0, 7),
    path,
    ...(line === undefined ? {} : { line }),
  });
  const file = (path: string, extra: Record<string, unknown>) => ({
    repo: "notes-co/widget",
    commit: SHA,
    path,
    ...extra,
  });

  it("are a file missing at the cited commit and a line past the file's end", () => {
    const problems = citationProblems(
      [page([[cite("gone.yml")], [cite("action.yml", 12)]])],
      ctx,
      [
        file("gone.yml", { note: "does not exist at this commit" }),
        file("action.yml", { text: "a\nb\nc", lines: 3 }),
      ],
    );
    expect([...problems]).toEqual([
      [
        "notes-co/atlas/repos/widget.md",
        [
          `cites notes-co/widget/gone.yml at ${SHA.slice(0, 12)}, which does not exist at that commit`,
          `cites line 12 of notes-co/widget/action.yml at ${SHA.slice(0, 12)}, which has 3 lines`,
        ],
      ],
    ]);
  });

  it("leave out lines within the file, and files not read for the size limit or an error", () => {
    const problems = citationProblems(
      [page([[cite("action.yml", 3)], [cite("gone.yml", 99)]])],
      ctx,
      [
        file("action.yml", { text: "a\nb\nc", lines: 3 }),
        file("gone.yml", {
          lines: 2,
          note: "not shown: the review's limit on cited file content was reached",
        }),
      ],
    );
    // The limit note still knows the length, so a line past it is still disproved.
    expect([...problems.values()].flat()).toEqual([
      `cites line 99 of notes-co/widget/gone.yml at ${SHA.slice(0, 12)}, which has 2 lines`,
    ]);
    expect(
      citationProblems([page([[cite("gone.yml")]])], ctx, [
        file("gone.yml", { note: "could not be read: timeout" }),
      ]).size,
    ).toBe(0);
  });
});

describe("claims about code that only cited documentation shows", () => {
  const ACTION = "notes-co/action-notes-survey";
  const AT = "f5369383b27f7a8fb168d634aadef0afd4e0aec8";
  /** Run 37950687564's survey change and the two files it cites, at the commit it cites. */
  const RUN_A = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "fixtures/review-files/survey-docker-config.json",
      ),
      "utf8",
    ),
  ) as { change: Change; files: Record<string, string> };
  const ctx = {
    sources: [
      {
        kind: "commit",
        repo: ACTION,
        commit: AT,
        date: "2026-09-15T14:54:32Z",
        title: "every change",
        files: [
          { path: "action.yml", status: "modified" },
          { path: "README.md", status: "modified" },
        ],
        excerpt: [],
      },
      {
        kind: "commit",
        repo: ACTION,
        commit: "49fadcb078267f33756cc056b72af7ffd9c3d17e",
        date: "2026-08-27T21:45:50Z",
        title: "feat: add image-mode survey",
        files: [],
        excerpt: [],
      },
    ],
  } as unknown as CheckContext;
  const files = (shown: "all" | "excerpts" = "all"): CitedFile[] =>
    Object.entries(RUN_A.files).map(([path, content]) => {
      const t = trimFile(content, []);
      return {
        repo: ACTION,
        commit: AT,
        path,
        ...t,
        ...(path === "action.yml" ? { shown } : {}),
      };
    });
  const pageOf = (...changes: Change[]): ProposedPage => ({
    repo: "notes-co/atlas",
    path: "repos/action-notes-survey.md",
    decision: "patch",
    reason: "r",
    patch: "p",
    changes,
  });
  const withAdded = (added: string[], extra: Partial<Change> = {}) => ({
    ...RUN_A.change,
    added,
    ...extra,
  });
  const problems = (p: ProposedPage, f = files()) =>
    [...citationProblems([p], ctx, f).values()].flat();

  it("leave out run 37950687564's survey page: only README.md, not action.yml, has the docker config mount's `docker/login-action`", () => {
    expect(problems(pageOf(RUN_A.change))).toEqual([
      `"the action mounts the runner's docker config read-only into the CLI container...": quotes \`docker/login-action\`, which only the documentation it cites has (README.md), not the code it cites (action.yml); documentation alone is not evidence for what code does`,
    ]);
  });

  it("pass a clause whose quoted code the cited code file has, even when the documentation has it too", () => {
    expect(
      problems(
        pageOf(
          withAdded([
            "- Image mode: when `image` is set, `action.yml` runs `notes survey image` with `--subject`.",
          ]),
        ),
      ),
    ).toEqual([]);
  });

  it("pass a clause about what a document says, and one the page's removed lines already make", () => {
    expect(
      problems(
        pageOf(
          withAdded([
            "- README.md still says the action mounts the docker config written by `docker/login-action`.",
          ]),
        ),
      ),
    ).toEqual([]);
    expect(
      problems(
        pageOf(withAdded(RUN_A.change.added, { removed: RUN_A.change.added })),
      ),
    ).toEqual([]);
  });

  it("judge nothing when a cited code file is shown only in part, or a cited commit's diff could show the claim", () => {
    expect(problems(pageOf(RUN_A.change), files("excerpts"))).toEqual([]);
    expect(
      problems(
        pageOf(
          withAdded(RUN_A.change.added, {
            evidence: [
              ...RUN_A.change.evidence,
              { repo: ACTION, commit: "49fadcb" },
            ],
          }),
        ),
      ),
    ).toEqual([]);
  });
});
