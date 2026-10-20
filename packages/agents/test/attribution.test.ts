import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckContext, ProposedPage } from "../src/output-check/pr.ts";
import {
  attributionProblems,
  claimsOf,
  distinctiveTokens,
  isCodeIdentifier,
  isFilePath,
  namesIdentifier,
} from "../src/run-job/attribution.ts";
import { pacificDay } from "../src/run-job/review-commits.ts";

const ATLAS = "notes-co/atlas";
const ACTION = "notes-co/action-notes-survey";
const WIDGET = "notes-co/widget";

/** Run 37858085063's survey page and GitHub's real answers for what it credits. */
const SURVEY = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures/attribution/survey-pr30.json"),
    "utf8",
  ),
) as { page: ProposedPage; github: Record<string, unknown> };

type Fixture = { page: ProposedPage; github: Record<string, unknown> };
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "fixtures/attribution", name),
      "utf8",
    ),
  ) as Fixture;

/** Run 37871042176's cli-scan page, which credits #30 with what it changed and #29 with the `image` input. */
const CLI_SCAN = fixture("cli-scan-pr30.json");

/** Run 37869719952's GAPS page, which names a file fdd1b62 left unchanged next to the file it deleted. */
const GAPS = fixture("gaps-agents-md.json");

/** Run 37963865908's survey page, which credits the `docker://` argument form to 066f6c1, whose diff has no `docker://`. */
const SURVEY_E = fixture("survey-066f6c1.json");

const CONTEXT: CheckContext = {
  policy: { repos: [ATLAS], paths: ["repos/*.md"], maxChangedLines: 800 },
  pinned: [],
};

function github(answers: Record<string, unknown>) {
  const paths: string[] = [];
  return {
    paths,
    read: (path: string) => {
      paths.push(path);
      const answer = answers[path];
      return Promise.resolve(answer === null ? undefined : answer);
    },
  };
}

function page(
  added: string[],
  repo = WIDGET,
  removed: string[] = [],
): ProposedPage {
  return {
    repo: ATLAS,
    path: "repos/x.md",
    decision: "patch",
    reason: "r",
    changes: [{ removed, added, evidence: [{ repo, commit: "a".repeat(40) }] }],
  };
}

const MERGE = "1ee72d5547ab3994132b829e320cdd61375f9d13";
const FIRST = "f959849aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BRANCH = "7903f66aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const api = `/repos/${WIDGET}`;

/** Pull request #77 merged at that time, its merge commit's diff made of these files. */
function merged77(mergedAt: string, files: unknown[]) {
  const pull = {
    number: 77,
    merged_at: mergedAt,
    merge_commit_sha: MERGE,
    base: { ref: "main", repo: { default_branch: "main" } },
  };
  const commit = {
    sha: MERGE,
    commit: { committer: { date: mergedAt } },
    parents: [{ sha: FIRST }, { sha: BRANCH }],
    files: [],
  };
  return {
    [`${api}/pulls/77`]: pull,
    [`${api}/commits/${MERGE}`]: commit,
    [`${api}/commits/1ee72d5`]: commit,
    [`${api}/commits/${MERGE}/pulls`]: [pull],
    [`${api}/compare/${FIRST}...${MERGE}`]: { files },
  };
}

const publishYml = (patch: string) => ({
  filename: ".github/workflows/publish.yml",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch,
});

const PATCH = [
  "@@ -10,7 +10,6 @@",
  "           declare -A IMG=(",
  '             [widget]="ghcr.io/${OWNER}/widget"',
  '-            [enterprise]="ghcr.io/${OWNER}/widget/enterprise"',
  "+          ./promote --reextract-changed",
  "           )",
  "   HttpCredentialKind stays",
].join("\n");

async function problems(
  added: string[],
  answers: Record<string, unknown>,
  removed: string[] = [],
) {
  const got = await attributionProblems(
    [page(added, WIDGET, removed)],
    CONTEXT,
    github(answers).read,
  );
  return got.get(`${ATLAS}/repos/x.md`) ?? [];
}

describe("the attribution check on run 37858085063's #30 line", () => {
  it("leaves out the survey page: #30 did not add the `image` input, which its diff has only as unchanged lines, and merged on 2026-10-06 Pacific", async () => {
    const got = await attributionProblems(
      [SURVEY.page],
      CONTEXT,
      github(SURVEY.github).read,
    );
    const found = got.get(`${ATLAS}/${SURVEY.page.path}`) ?? [];
    expect(found).toEqual([
      `"- 2026-10-07: image mode corrected to run \`notes survey inventory [subject] d...": dates ${ACTION}#30, ${ACTION}@89cdcdd, ${ACTION}@b455512 2026-10-07, but they landed on 2026-10-06 in America/Los_Angeles (merged 2026-10-07T00:47:05Z)`,
      `"- 2026-10-07: image mode corrected to run \`notes survey inventory [subject] d...": credits ${ACTION}#30, ${ACTION}@89cdcdd, ${ACTION}@b455512 with \`image\`, which no added or removed line of their diffs names (unchanged lines do not count)`,
    ]);
  });

  it("passes the page's #29 line, which credits the pull request that added `image`, dated by its merge", async () => {
    const line = SURVEY.page.changes!.find((c) =>
      c.added[0]!.includes("PR #29"),
    )!;
    const got = await attributionProblems(
      [{ ...SURVEY.page, changes: [line] }],
      CONTEXT,
      github(SURVEY.github).read,
    );
    expect(got.size).toBe(0);
  });

  it("finds `subject` and `input`, which #30 does change, on its changed lines", async () => {
    const page30 = {
      ...SURVEY.page,
      changes: [
        {
          removed: [],
          added: [
            "- 2026-10-06: PR #30 (merge 89cdcdd) made `subject` optional for images and ignores `input`.",
          ],
          evidence: [{ repo: ACTION, commit: "89cdcdd" }],
        },
      ],
    };
    const got = await attributionProblems(
      [page30],
      CONTEXT,
      github(SURVEY.github).read,
    );
    expect(got.size).toBe(0);
  });
});

describe("the attribution check on run 37871042176's cli-scan page", () => {
  const CLI = "notes-co/action-notes-cli-scan";
  const withLine = (line: string) => ({
    ...CLI_SCAN.page,
    changes: [
      {
        removed: [],
        added: [line],
        evidence: [{ repo: CLI, commit: "89cdcdd" }],
      },
    ],
  });
  const check = async (p: ProposedPage) =>
    (await attributionProblems([p], CONTEXT, github(CLI_SCAN.github).read)).get(
      `${ATLAS}/${p.path}`,
    ) ?? [];

  it("passes the page: #30 changed what the `image` input does, inside its block in action.yml, and #29 added it", async () => {
    expect(await check(CLI_SCAN.page)).toEqual([]);
  });

  it("still fails the same #30 line once it says #30 added the input", async () => {
    expect(
      await check(
        withLine(
          "- 2026-10-06: PR #30 (merge 89cdcdd) added the `image` input.",
        ),
      ),
    ).toEqual([
      `"- 2026-10-06: PR #30 (merge 89cdcdd) added the \`image\` input.": credits ${CLI}#30, ${CLI}@89cdcdd with \`image\`, which no added or removed line of their diffs names (unchanged lines do not count)`,
    ]);
  });

  it("fails a key whose block #30 left unchanged", async () => {
    expect(
      await check(
        withLine(
          "- 2026-10-06: PR #30 (merge 89cdcdd) `notes_pass` is read from a secret.",
        ),
      ),
    ).toHaveLength(1);
  });
});

describe("the attribution check on run 37963865908's survey page", () => {
  const withLine = (line: string, commit = "89cdcdd") => ({
    ...SURVEY_E.page,
    changes: [
      {
        removed: [],
        added: [line],
        evidence: [{ repo: ACTION, commit }],
      },
    ],
  });
  const check = async (p: ProposedPage) =>
    (
      await attributionProblems([p], CONTEXT, github(SURVEY_E.github).read)
    ).get(`${ATLAS}/${p.path}`) ?? [];

  it("leaves out the page: 066f6c1 changed no line with `docker://`, the image-mode argument form's one literal", async () => {
    expect(await check(SURVEY_E.page)).toEqual([
      `"- \`notes survey inventory\` arg order is \`<subject> <input>\`, or \`[subject] do...": credits ${ACTION}@066f6c1 with \`[subject] docker://<image>\`, but no added or removed line of its diff names its literal \`docker://\` (unchanged lines do not count)`,
    ]);
  });

  it("passes the same argument form credited to #30, which added `docker://`", async () => {
    expect(
      await check(
        withLine(
          "- 2026-10-06: PR #30 (merge 89cdcdd) image mode runs `notes survey inventory [subject] docker://<image>`.",
        ),
      ),
    ).toEqual([]);
  });

  it("skips a form with no literal only code could have written", async () => {
    expect(
      await check(
        withLine(
          "Arg order is `<subject> <input>` (commit 066f6c1).",
          "066f6c1",
        ),
      ),
    ).toEqual([]);
  });
});

describe("the attribution check on run 37869719952's GAPS page", () => {
  it("passes it: `README_llm.md` is a file the line points at, not something fdd1b62 is credited with", async () => {
    const got = await attributionProblems(
      [GAPS.page],
      CONTEXT,
      github(GAPS.github).read,
    );
    expect(got.size).toBe(0);
  });
});

describe("the attribution check", () => {
  it("passes a credit whose diff changes every identifier the line quotes, on the day it merged", async () => {
    expect(
      await problems(
        [
          "- 2026-10-06: PR #77 (merge 1ee72d5) dropped the `enterprise` entry and added `--reextract-changed` to `publish.yml`.",
        ],
        merged77("2026-10-06T17:43:41Z", [publishYml(PATCH)]),
      ),
    ).toEqual([]);
  });

  it("fails a date that is not the day the pull request merged", async () => {
    const got = await problems(
      ["- 2026-10-05: PR #77 (merge 1ee72d5) dropped the `enterprise` entry."],
      merged77("2026-10-06T17:43:41Z", [publishYml(PATCH)]),
    );
    expect(got).toEqual([
      `"- 2026-10-05: PR #77 (merge 1ee72d5) dropped the \`enterprise\` entry.": dates ${WIDGET}#77, ${WIDGET}@1ee72d5 2026-10-05, but they landed on 2026-10-06 in America/Los_Angeles (merged 2026-10-06T17:43:41Z)`,
    ]);
  });

  it("dates an evening merge in the Pacific by the Pacific day, not the next UTC day", async () => {
    const answers = merged77("2026-10-07T01:30:00Z", [publishYml(PATCH)]);
    expect(
      await problems(
        ["- 2026-10-06: PR #77 (merge 1ee72d5) dropped `enterprise`."],
        answers,
      ),
    ).toEqual([]);
    expect(
      (
        await problems(
          ["- 2026-10-07: PR #77 (merge 1ee72d5) dropped `enterprise`."],
          answers,
        )
      )[0],
    ).toContain("but they landed on 2026-10-06 in America/Los_Angeles");
  });

  it("holds a date next to a credit to that credit only", async () => {
    const answers = merged77("2026-10-06T17:43:41Z", [publishYml(PATCH)]);
    expect(
      await problems(
        [
          "Image promotion was reworked (PR #77, merged 2026-10-06), as planned on 2026-09-01.",
        ],
        answers,
      ),
    ).toEqual([]);
    expect(
      (
        await problems(
          ["Image promotion was reworked (PR #77, merged 2026-10-08)."],
          answers,
        )
      )[0],
    ).toContain("dates notes-co/widget#77 2026-10-08");
  });

  it("fails an identifier the credited diff has only on unchanged lines", async () => {
    const got = await problems(
      ["- 2026-10-06: PR #77 (merge 1ee72d5) added `HttpCredentialKind`."],
      merged77("2026-10-06T17:43:41Z", [publishYml(PATCH)]),
    );
    expect(got).toEqual([
      `"- 2026-10-06: PR #77 (merge 1ee72d5) added \`HttpCredentialKind\`.": credits ${WIDGET}#77, ${WIDGET}@1ee72d5 with \`HttpCredentialKind\`, which no added or removed line of their diffs names (unchanged lines do not count)`,
    ]);
    // `IMG` is the map the removed entry sat in, but no changed line names it.
    expect(
      await problems(
        ["- 2026-10-06: PR #77 (merge 1ee72d5) shrank the `IMG` map."],
        merged77("2026-10-06T17:43:41Z", [publishYml(PATCH)]),
      ),
    ).toHaveLength(1);
  });

  it("fails an identifier missing from a diff GitHub cut short, as unverifiable", async () => {
    const got = await problems(
      ["- 2026-10-06: PR #77 (merge 1ee72d5) added `HttpCredentialKind`."],
      merged77("2026-10-06T17:43:41Z", [
        publishYml(PATCH),
        {
          filename: "src/core/Credential.scala",
          status: "modified",
          additions: 4000,
          deletions: 12,
        },
      ]),
    );
    expect(got).toEqual([
      `"- 2026-10-06: PR #77 (merge 1ee72d5) added \`HttpCredentialKind\`.": credits ${WIDGET}#77, ${WIDGET}@1ee72d5 with \`HttpCredentialKind\`, which no added or removed line shown names, and the diff of ${WIDGET}#77 (no diff shown for src/core/Credential.scala), ${WIDGET}@1ee72d5 (no diff shown for src/core/Credential.scala) is not whole, so the credit is unverifiable`,
    ]);
  });

  it("fails a pull request that is not merged, or merged into another branch", async () => {
    const answers = merged77("2026-10-06T17:43:41Z", []);
    expect(
      await problems(["- 2026-10-06: PR #77 dropped it."], {
        ...answers,
        [`${api}/pulls/77`]: { number: 77, merged_at: null, base: {} },
      }),
    ).toEqual([
      `"- 2026-10-06: PR #77 dropped it.": credits ${WIDGET}#77, which is not merged`,
    ]);
    expect(
      await problems(["- 2026-10-06: PR #77 dropped it."], {
        ...answers,
        [`${api}/pulls/77`]: {
          ...(answers[`${api}/pulls/77`] as object),
          base: { ref: "jon/branch", repo: { default_branch: "main" } },
        },
      }),
    ).toEqual([
      `"- 2026-10-06: PR #77 dropped it.": credits ${WIDGET}#77, which merged into jon/branch, not the default branch main`,
    ]);
  });

  it("fails a merge commit that is not the pull request's, and a pull request GitHub does not have", async () => {
    const answers = merged77("2026-10-06T17:43:41Z", []);
    const wrongMerge = await problems(
      ["- 2026-10-06: PR #77 (merge cab3460) dropped it."],
      answers,
    );
    expect(wrongMerge).toContain(
      `"- 2026-10-06: PR #77 (merge cab3460) dropped it.": names merge cab3460 for ${WIDGET}#77, whose merge commit is 1ee72d5`,
    );
    expect(
      await problems(["- 2026-10-06: PR #78 dropped it."], answers),
    ).toEqual([
      `"- 2026-10-06: PR #78 dropped it.": credits #78, which ${WIDGET} does not have`,
    ]);
  });

  it("dates a commit by the pull request that brought it to the default branch, and fails one never on it", async () => {
    const answers = {
      ...merged77("2026-10-06T17:43:41Z", []),
      [`${api}/commits/7903f66`]: {
        sha: BRANCH,
        commit: { committer: { date: "2026-10-02T09:00:00Z" } },
        parents: [{ sha: FIRST }],
        files: [publishYml(PATCH)],
      },
      [`${api}/commits/${BRANCH}/pulls`]: [
        {
          number: 77,
          merged_at: "2026-10-06T17:43:41Z",
          merge_commit_sha: MERGE,
          base: { ref: "main", repo: { default_branch: "main" } },
        },
      ],
    };
    expect(
      await problems(
        ["- 2026-10-06: `enterprise` dropped (commit 7903f66)."],
        answers,
      ),
    ).toEqual([]);
    expect(
      (
        await problems(
          ["- 2026-10-02: `enterprise` dropped (commit 7903f66)."],
          answers,
        )
      )[0],
    ).toContain("but it landed on 2026-10-06");
    const unmerged = {
      ...answers,
      [`${api}/commits/${BRANCH}/pulls`]: [],
      [api]: { default_branch: "main" },
      [`${api}/compare/main...${BRANCH}`]: { status: "diverged" },
    };
    expect(
      await problems(
        ["- 2026-10-02: `enterprise` dropped (commit 7903f66)."],
        unmerged,
      ),
    ).toEqual([
      `"- 2026-10-02: \`enterprise\` dropped (commit 7903f66).": credits ${WIDGET}@7903f66, which is not on the default branch main`,
    ]);
    expect(
      await problems(["- 2026-10-02: `enterprise` dropped (commit 7903f66)."], {
        ...unmerged,
        [`${api}/compare/main...${BRANCH}`]: { status: "behind" },
      }),
    ).toEqual([]);
  });

  it("skips a claim the page's removed lines already make, word for word", async () => {
    const line = "- 2026-10-05: PR #77 (merge 1ee72d5) dropped `IMG`.";
    expect(
      await problems(
        [`Intro rewritten. ${line.slice(2)}`],
        merged77("2026-10-06T17:43:41Z", [publishYml(PATCH)]),
        [`Intro. ${line.slice(2)}`],
      ),
    ).toEqual([]);
  });

  it("fails a credit it cannot read from GitHub", async () => {
    const got = await attributionProblems(
      [page(["- 2026-10-06: PR #77 dropped it."])],
      CONTEXT,
      () => Promise.reject(new Error("GitHub answered 502")),
    );
    expect(got.get(`${ATLAS}/repos/x.md`)).toEqual([
      `"- 2026-10-06: PR #77 dropped it.": could not read ${WIDGET}#77 from GitHub to check the credit (GitHub answered 502)`,
    ]);
  });
});

describe("what a line claims", () => {
  const cited = [WIDGET];

  it("reads a `## recent`-style line whole, with its leading date, merges, credits and identifiers", () => {
    const [claim] = claimsOf(
      "- 2026-10-07: image mode corrected; `image` added (PR #30, merge 89cdcdd; commit b455512).",
      cited,
      "notes-co",
      [ATLAS],
    );
    expect(claim!.days).toEqual({ list: ["2026-10-07"] });
    expect(claim!.credits.map((c) => c.ref)).toEqual([
      "#30",
      "89cdcdd",
      "b455512",
    ]);
    expect(claim!.merges).toEqual([{ credit: 0, sha: "89cdcdd" }]);
    expect(claim!.identifiers).toEqual(["image"]);
  });

  it("splits other lines into sentences and clauses, skips commit ranges and commits named as a state, and expands pull request ranges", () => {
    const claims = claimsOf(
      "Arg order is `<subject> <input>` (commit 066f6c1); with `image` set `input` is ignored. Built from git log 1bbd0eb..ce43469 at cab3460, PRs #17-#20.",
      cited,
      "notes-co",
      [ATLAS],
    );
    expect(claims.map((c) => c.credits.map((x) => x.ref))).toEqual([
      ["066f6c1"],
      ["#17", "#18", "#19", "#20"],
    ]);
    expect(claims[0]!.identifiers).toEqual([]);
  });

  it("holds a clause's leading date list or range to its credits, and looks a hyphenated name before a number up as a repository", () => {
    const [claim] = claimsOf(
      "Same history; 2026-09-15/2026-10-07 added image mode (#29, #30), see notes-cli #293.",
      cited,
      "notes-co",
      [ATLAS],
    );
    expect(claim!.days).toEqual({ list: ["2026-09-15", "2026-10-07"] });
    expect(claim!.credits.at(-1)!.repos).toEqual([
      "notes-co/notes-cli",
      WIDGET,
    ]);
    expect(
      claimsOf("- 2026-07-20..2026-07-21: moved (#5).", cited, "o", [ATLAS])[0]!
        .days,
    ).toEqual({ from: "2026-07-20", to: "2026-07-21" });
    expect(
      claimsOf("- 2026-07-20/21: moved (#5).", cited, "o", [ATLAS])[0]!.days,
    ).toEqual({ list: ["2026-07-20", "2026-07-21"] });
  });

  it("does not hold a date several words from a credit to it", () => {
    const [claim] = claimsOf(
      "Gap (found 2026-10-07 while refreshing action-notes-survey, PR #30).",
      cited,
      "notes-co",
      [ATLAS],
    );
    expect(claim!.near).toEqual([]);
  });
});

describe("file paths in a claim", () => {
  it("are files and folders, never code or image references", () => {
    expect(
      [
        "README_llm.md",
        "AGENTS.md",
        "publish.yml",
        "src/core/Credential.scala",
        ".github/workflows/",
        "Dockerfile.version",
      ].map(isFilePath),
    ).toEqual([true, true, true, true, true, true]);
    expect(
      [
        "image",
        "ConfigurationGroups.All",
        "inputs.image",
        "io.notesco:notes-plugin-api",
        "docker://",
        "ghcr.io/org/app:v1",
      ].map(isFilePath),
    ).toEqual([false, false, false, false, false, false]);
  });
});

describe("the literals of a quoted command line or argument form", () => {
  it("are schemes, flags, paths and punctuated names, never placeholders, brackets, plain words or file paths", () => {
    expect(distinctiveTokens("[subject] docker://<image>")).toEqual([
      "docker://",
    ]);
    expect(
      distinctiveTokens(
        '~/.local/bin/notes survey inventory "<subject>" "<input>" --log-level=...',
      ),
    ).toEqual(["~/.local/bin/notes", "--log-level"]);
    expect(
      distinctiveTokens("notes survey image <image> --subject <subject>"),
    ).toEqual(["--subject"]);
    expect(distinctiveTokens("NOTES_PASS=<pass> run inputs.image")).toEqual([
      "NOTES_PASS",
      "inputs.image",
    ]);
    expect(distinctiveTokens("<subject> <input>")).toEqual([]);
    expect(distinctiveTokens("notes survey inventory")).toEqual([]);
    expect(distinctiveTokens("read-only image-mode survey")).toEqual([]);
    expect(distinctiveTokens("cat action.yml")).toEqual([]);
  });

  it("are a claim's forms only for backtick text with a space or a placeholder", () => {
    const [claim] = claimsOf(
      "Image mode runs `notes survey inventory [subject] docker://<image>` with `docker://` and `${SUBJECT:+x}` (#30).",
      [ACTION],
      "notes-co",
      [ATLAS],
    );
    expect(claim!.identifiers).toEqual(["docker://"]);
    expect(claim!.forms).toEqual([
      {
        text: "notes survey inventory [subject] docker://<image>",
        tokens: ["docker://"],
      },
    ]);
  });
});

describe("code identifiers on a diff line", () => {
  it("are one token with a letter, never a placeholder, glob, phrase or sha", () => {
    expect(
      ["image", "HttpCredentialKind", "--reextract-changed", "publish.yml"].map(
        isCodeIdentifier,
      ),
    ).toEqual([true, true, true, true]);
    expect(
      [
        "notes survey image",
        "docker://<image>",
        "repos/*.md",
        "1ee72d5",
        ".",
      ].map(isCodeIdentifier),
    ).toEqual([false, false, false, false, false]);
  });

  it("count a lowercase word only where the line uses it as code, never as prose or Markdown backticks", () => {
    expect(namesIdentifier("  image:", "image")).toBe(true);
    expect(namesIdentifier('IMG="${{ inputs.image }}"', "image")).toBe(true);
    expect(namesIdentifier("  --image <ref>", "image")).toBe(true);
    expect(namesIdentifier("let image = pull(ref)", "image")).toBe(true);
    expect(namesIdentifier('notes survey image "$IMG"', "image")).toBe(false);
    expect(namesIdentifier("When `image` is set, the image", "image")).toBe(
      false,
    );
    expect(namesIdentifier("  imagename: x", "image")).toBe(false);
  });

  it("count any other identifier wherever it stands as a whole token", () => {
    expect(
      namesIdentifier("enum HttpCredentialKind {", "HttpCredentialKind"),
    ).toBe(true);
    expect(namesIdentifier("HttpCredentialKinds", "HttpCredentialKind")).toBe(
      false,
    );
    expect(
      namesIdentifier("  run --reextract-changed", "--reextract-changed"),
    ).toBe(true);
  });
});

describe("the Pacific day", () => {
  it("is the day in America/Los_Angeles, across daylight saving time", () => {
    expect(pacificDay("2026-10-07T00:47:05Z")).toBe("2026-10-06");
    expect(pacificDay("2026-09-15T14:54:32Z")).toBe("2026-09-15");
    expect(pacificDay("2026-12-01T07:59:00Z")).toBe("2026-11-30");
    expect(pacificDay("2026-12-01T08:00:00Z")).toBe("2026-12-01");
    expect(pacificDay("not a time")).toBeUndefined();
  });
});
