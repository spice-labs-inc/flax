import { describe, expect, it } from "vitest";
import type {
  CheckContext,
  ProposedPage,
  Source,
} from "../src/output-check/pr.ts";
import {
  buildReviewInput,
  CLIPPED_MARK,
  fitReviewInput,
  MAX_CHANGE_NUMBER,
  MAX_REASON_CHARS,
  mergeVerdicts,
  parseVerdict,
  REVIEW_SCHEMA,
  reviewPrompt,
  shrinkNumbered,
  type ReviewInput,
} from "../src/run-job/review.ts";
import type { CreditedCommit } from "../src/run-job/review-commits.ts";

const REPO = "notes-co/widget";
const ATLAS = "notes-co/atlas";
const SHA = "a".repeat(40);

function commitSource(n: number, excerptLines = 10): Source {
  return {
    kind: "commit",
    repo: REPO,
    commit: `${n}`.padStart(40, "0"),
    date: "2026-10-01T00:00:00Z",
    title: `Change ${n} (#${n})`,
    files: [{ path: `src/F${n}.scala`, status: "modified" }],
    excerpt: [
      {
        path: `src/F${n}.scala`,
        removed: Array.from(
          { length: excerptLines },
          (_, i) => `old ${n} ${i}`,
        ),
        added: Array.from({ length: excerptLines }, (_, i) => `new ${n} ${i}`),
      },
    ],
  };
}

function page(path: string, cites: number[], changes = 1): ProposedPage {
  return {
    repo: ATLAS,
    path,
    decision: "patch",
    reason: `Refresh ${path}.`,
    patch: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    changes: Array.from({ length: changes }, (_, i) => ({
      removed: [`old ${i}`],
      added: [`new ${i} uses Repository and Credential`],
      evidence: cites.map((n) => ({
        repo: REPO,
        commit: `${n}`.padStart(40, "0"),
        path: `src/F${n}.scala`,
      })),
    })),
  };
}

function context(sources: Source[]): CheckContext {
  return {
    policy: {
      repos: [ATLAS],
      paths: ["repos/*.md", "ARCHITECTURE.md"],
      maxChangedLines: 800,
    },
    pinned: [],
    sources,
  };
}

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** A credited commit as the second check sees it, with a diff of about `bytes`. */
function credited(n: number, bytes = 5_000): CreditedCommit {
  const sha = `${n}`.padStart(7, "0").concat("c".repeat(33));
  return {
    repo: REPO,
    named: [sha.slice(0, 8)],
    sha,
    subject: `Change ${n}`,
    committed_at: "2026-10-01T00:00:00Z",
    landed_at: "2026-10-01T00:00:00Z",
    files: [
      {
        path: `src/F${n}.scala`,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "+x\n".repeat(Math.floor(bytes / 3)),
      },
    ],
  };
}

/** A page whose one change credits each of these commits by its short sha. */
function creditingPage(path: string, credits: CreditedCommit[]): ProposedPage {
  return {
    ...page(path, [1]),
    changes: [
      {
        removed: ["old history"],
        added: [`History: ${credits.map((c) => c.named[0]).join(", ")}.`],
        evidence: [
          { repo: REPO, commit: "1".padStart(40, "0"), path: "src/F1.scala" },
        ],
      },
    ],
  };
}

describe("the second check's input", () => {
  it("lists a source once however many changes cite it, and evidence names it by id", () => {
    const sources = [commitSource(1, 400), commitSource(2)];
    const input = buildReviewInput(
      [page("repos/widget.md", [1, 2], 40)],
      context(sources),
      "Refresh the atlas.",
    );
    expect(Object.keys(input.sources)).toEqual(["S1", "S2"]);
    expect(input.sources.S1).toBe(sources[0]);
    for (const change of input.proposal[0]!.changes)
      expect(change.evidence.map((e) => e.source_ids)).toEqual([
        ["S1"],
        ["S2"],
      ]);
    // 40 changes citing the same large source carry it once, not 40 times.
    expect(size(input)).toBeLessThan(size(sources) * 3);
    expect(size(input)).toBeLessThan(40 * size(sources[0]));
  });

  it("numbers the changes of each page from 1, for a reason to name one", () => {
    const input = buildReviewInput(
      [page("repos/a.md", [1], 3), page("repos/b.md", [1], 2)],
      context([commitSource(1)]),
      "Refresh the atlas.",
    );
    expect(
      input.proposal.map((p) => p.changes.map((c) => [c.change, c.added[0]])),
    ).toEqual([
      [
        [1, "new 0 uses Repository and Credential"],
        [2, "new 1 uses Repository and Credential"],
        [3, "new 2 uses Repository and Credential"],
      ],
      [
        [1, "new 0 uses Repository and Credential"],
        [2, "new 1 uses Repository and Credential"],
      ],
    ]);
  });

  it("leaves an input that fits as it is", () => {
    const input = buildReviewInput(
      [page("repos/a.md", [1])],
      context([commitSource(1)]),
      "x",
    );
    const fitted = fitReviewInput(input, 1_000_000);
    expect(fitted).toEqual({ inputs: [input], tooBig: [] });
    expect(fitted.inputs[0]!.trimmed).toBeUndefined();
  });

  it("shortens cited files first, largest first, and only then source excerpts, saying what it cut", () => {
    const input = buildReviewInput(
      [page("repos/a.md", [1, 2])],
      context([commitSource(1, 300), commitSource(2, 300)]),
      "x",
    );
    const big = Array.from(
      { length: 2000 },
      (_, i) => `${i + 1}: line ${i} ${i === 1000 ? "Repository" : "filler"}`,
    ).join("\n");
    input.cited_files = [
      {
        repo: REPO,
        commit: SHA,
        path: "src/F1.scala",
        lines: 2000,
        shown: "all",
        text: big,
      },
      {
        repo: REPO,
        commit: SHA,
        path: "src/F2.scala",
        lines: 3,
        shown: "all",
        text: "1: a\n2: b\n3: c",
      },
    ];
    // Enough room once the big file is cut to the lines around Repository.
    const afterFiles = fitReviewInput(input, size(input) - big.length + 9_000);
    expect(afterFiles.inputs).toHaveLength(1);
    const one = afterFiles.inputs[0]!;
    expect(one.trimmed).toEqual([
      `cited file ${REPO}/src/F1.scala shortened to the lines around what the changes name`,
    ]);
    expect(one.cited_files![0]!.text).toContain("1001: line 1000 Repository");
    expect(one.cited_files![0]!.shown).toBe("excerpts");
    expect(one.cited_files![1]!.text).toBe("1: a\n2: b\n3: c");
    expect(one.sources.S1).toEqual(input.sources.S1);
    // The original is never changed.
    expect(input.cited_files[0]!.text).toBe(big);

    // Tighter: files go, then excerpts are shortened.
    const { cited_files: _files, ...noFiles } = input;
    const tight = fitReviewInput(input, size(noFiles) - 4_000);
    expect(tight.inputs).toHaveLength(1);
    const notes = tight.inputs[0]!.trimmed!;
    const firstExcerpt = notes.findIndex((n) => n.startsWith("source "));
    expect(firstExcerpt).toBeGreaterThan(0);
    expect(
      notes.slice(0, firstExcerpt).every((n) => n.startsWith("cited file ")),
    ).toBe(true);
    const s1 = tight.inputs[0]!.sources.S1 as Extract<
      Source,
      { kind: "commit" }
    >;
    expect(s1.excerpt[0]!.removed.length).toBeLessThanOrEqual(20);
  });

  it("reviews one page at a time when trimming is not enough, and does not review a page still too big alone", () => {
    const pages = [
      page("repos/small.md", [1]),
      page("repos/widget.md", [2], 300),
    ];
    const input = buildReviewInput(
      pages,
      context([commitSource(1), commitSource(2)]),
      "x",
    );
    const small = buildReviewInput(
      [pages[0]!],
      context([commitSource(1)]),
      "x",
    );
    const fitted = fitReviewInput(input, size(small) + 2_000);
    expect(fitted.inputs.map((i) => i.proposal.map((p) => p.path))).toEqual([
      ["repos/small.md"],
    ]);
    expect(fitted.inputs[0]!.part).toEqual({ page: 1, of: 2 });
    expect(Object.keys(fitted.inputs[0]!.sources)).toEqual(["S1"]);
    expect(fitted.tooBig).toEqual([{ repo: ATLAS, path: "repos/widget.md" }]);
  });

  it("splits a proposal of several pages before trimming any of them", () => {
    const pages = [page("repos/a.md", [1], 30), page("repos/b.md", [2], 30)];
    const input = buildReviewInput(
      pages,
      context([commitSource(1), commitSource(2)]),
      "x",
    );
    const fitted = fitReviewInput(input, size(input) - 10);
    expect(fitted.inputs).toHaveLength(2);
    expect(fitted.inputs.every((i) => (i.trimmed ?? []).length === 0)).toBe(
      true,
    );
  });

  it("splits into one review per page when each fits alone", () => {
    const pages = [page("repos/a.md", [1], 30), page("repos/b.md", [2], 30)];
    const input = buildReviewInput(
      pages,
      context([commitSource(1), commitSource(2)]),
      "x",
    );
    const fitted = fitReviewInput(input, Math.ceil(size(input) * 0.7));
    expect(fitted.inputs.map((i) => i.part)).toEqual([
      { page: 1, of: 2 },
      { page: 2, of: 2 },
    ]);
    expect(fitted.tooBig).toEqual([]);
  });

  it("splits a page whose credited commits do not fit into parts by credits, each with the whole page change, cutting none", () => {
    const credits = Array.from({ length: 30 }, (_, i) => credited(i + 1));
    const one = creditingPage("repos/widget.md", credits);
    const input = buildReviewInput([one], context([commitSource(1)]), "x");
    input.credited_commits = structuredClone(credits);
    const base = size({ ...input, credited_commits: [] });
    const budget = base + 60_000;
    const fitted = fitReviewInput(input, budget);
    expect(fitted.tooBig).toEqual([]);
    expect(fitted.inputs.length).toBeGreaterThanOrEqual(3);
    const of = fitted.inputs.length;
    for (const [i, part] of fitted.inputs.entries()) {
      expect(size(part)).toBeLessThanOrEqual(budget);
      expect(part.proposal).toEqual(input.proposal);
      expect(part.trimmed).toBeUndefined();
      expect(part.part?.page).toBe(1);
      expect(part.part?.of).toBe(1);
      expect(part.part?.credits?.part).toBe(i + 1);
      expect(part.part?.credits?.of).toBe(of);
      const here = part.credited_commits!.map((c) => c.named[0]);
      expect(part.part?.credits?.elsewhere).toEqual(
        credits
          .map((c) => c.named[0])
          .filter((n) => !here.includes(n))
          .map((n) => `${REPO} ${n}`),
      );
    }
    expect(fitted.inputs.flatMap((p) => p.credited_commits)).toEqual(credits);
  });

  it("keeps the page number of a page split by credits in a proposal split per page", () => {
    const credits = Array.from({ length: 12 }, (_, i) => credited(i + 1));
    const pages = [
      page("repos/small.md", [1]),
      creditingPage("repos/widget.md", credits),
    ];
    const input = buildReviewInput(pages, context([commitSource(1)]), "x");
    input.credited_commits = structuredClone(credits);
    const fitted = fitReviewInput(
      input,
      size({ ...input, credited_commits: [] }) + 30_000,
    );
    expect(fitted.inputs[0]!.part).toEqual({ page: 1, of: 2 });
    expect(fitted.inputs[0]!.credited_commits).toEqual([]);
    const rest = fitted.inputs.slice(1);
    expect(rest.length).toBeGreaterThanOrEqual(2);
    expect(rest.every((p) => p.part?.page === 2 && p.part.of === 2)).toBe(true);
    expect(rest.flatMap((p) => p.credited_commits)).toEqual(credits);
  });
});

describe("merging second check verdicts", () => {
  const approve = (text: string) => ({
    verdict: "approve" as const,
    reasons: [{ text }],
  });
  it("approves when every review approved", () => {
    expect(mergeVerdicts([approve("a ok"), approve("b ok")])).toEqual({
      verdict: "approve",
      reasons: [{ text: "a ok" }, { text: "b ok" }],
    });
  });

  it("rejects with the rejecting reviews' reasons and one per page too big to review", () => {
    const merged = mergeVerdicts(
      [
        approve("a ok"),
        {
          verdict: "reject",
          reasons: [{ repo: ATLAS, path: "repos/b.md", text: "b unproven" }],
        },
      ],
      [{ repo: ATLAS, path: "repos/c.md" }],
    );
    expect(merged.verdict).toBe("reject");
    expect(merged.reasons.map((r) => r.path)).toEqual([
      "repos/b.md",
      "repos/c.md",
    ]);
  });

  it("returns a single verdict unchanged", () => {
    const v = approve("fine");
    expect(mergeVerdicts([v])).toBe(v);
  });
});

describe("reading a second check verdict", () => {
  it("ignores no text after the verdict", () => {
    const verdict = JSON.stringify({
      verdict: "approve",
      reasons: [{ text: "fine" }],
    });
    expect(parseVerdict(verdict)).toEqual({ verdict: JSON.parse(verdict) });
    expect(parseVerdict(`${verdict}\n  {"verdict": "reject"`)).toEqual({
      error: "the second check's answer has text after its JSON verdict",
    });
  });

  it("tells the second check how long a reason may be", () => {
    expect(reviewPrompt()).toContain(`at most\n${MAX_REASON_CHARS} characters`);
    expect(
      REVIEW_SCHEMA.properties.reasons.items.properties.text.maxLength,
    ).toBe(MAX_REASON_CHARS);
  });

  it("clips a reason that is only too long, with a mark, and keeps the verdict", () => {
    // Run 37984032795: an approval whose first reason ran to 707 characters.
    const long = `Every added line is shown by the cited commit diffs: ${"the change (abc1234), ".repeat(31)}and the fix.`;
    expect(long.length).toBeGreaterThan(MAX_REASON_CHARS);
    const got = parseVerdict(
      JSON.stringify({
        verdict: "approve",
        reasons: [
          { repo: "notes-co/public-docs", path: "a.mdx", text: long },
          { text: "Short." },
        ],
      }),
    );
    if (!("verdict" in got)) throw new Error(got.error);
    expect(got.verdict.verdict).toBe("approve");
    const [first, second] = got.verdict.reasons;
    expect(first!.text).toHaveLength(MAX_REASON_CHARS);
    expect(first!.text.endsWith(CLIPPED_MARK)).toBe(true);
    expect(first!.text.startsWith("Every added line is shown")).toBe(true);
    expect(first).toMatchObject({
      repo: "notes-co/public-docs",
      path: "a.mdx",
    });
    expect(second).toEqual({ text: "Short." });
  });

  it("reads the change a reason names, by its number on the page, and refuses a number that is not one", () => {
    const named = {
      verdict: "reject",
      reasons: [
        { repo: ATLAS, path: "a.md", change: 2, text: "Change 2 is unproven." },
        { repo: ATLAS, path: "a.md", text: "The page as a whole." },
      ],
    };
    expect(parseVerdict(JSON.stringify(named))).toEqual({ verdict: named });
    for (const change of [0, 1.5, "2", MAX_CHANGE_NUMBER + 1])
      expect(
        parseVerdict(
          JSON.stringify({
            verdict: "reject",
            reasons: [{ repo: ATLAS, path: "a.md", change, text: "x" }],
          }),
        ),
      ).toEqual({
        error: expect.stringMatching(
          /^the second check's answer does not match its schema: /,
        ),
      });
  });

  it("asks the second check to name each change it objects to by its page and number", () => {
    const prompt = reviewPrompt().replace(/\s+/g, " ");
    expect(prompt).toContain(
      "Give every change you object to a reason of its own, with its page and its `change` number",
    );
    expect(prompt).toContain("numbered from 1 on its page (`change`)");
    expect(prompt).toContain(
      "a rejection whose every reason names a change leaves out only those changes",
    );
  });

  it("still fails an answer that breaks its schema in another way too", () => {
    const long = "x".repeat(MAX_REASON_CHARS + 1);
    for (const answer of [
      { verdict: "maybe", reasons: [{ text: long }] },
      { verdict: "approve", reasons: [{ text: long, extra: 1 }] },
      { verdict: "approve", reasons: [] },
    ])
      expect(parseVerdict(JSON.stringify(answer))).toEqual({
        error: expect.stringMatching(
          /^the second check's answer does not match its schema: /,
        ),
      });
  });
});

describe("shortening a numbered file", () => {
  it("keeps the lines around a term, marking gaps", () => {
    const text = Array.from(
      { length: 100 },
      (_, i) => `${i + 1}: row ${i}${i === 50 ? " Credential" : ""}`,
    ).join("\n");
    const out = shrinkNumbered(text, ["Credential"], 10_000, 2);
    expect(out.split("\n")).toEqual([
      "...",
      "49: row 48",
      "50: row 49",
      "51: row 50 Credential",
      "52: row 51",
      "53: row 52",
      "...",
    ]);
  });
});

export type { ReviewInput };
