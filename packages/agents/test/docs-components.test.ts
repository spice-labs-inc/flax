import { existsSync, readFileSync } from "node:fs";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { workspace } from "../src/lib/workspace.ts";

/** The docs repository and lint patterns the fixture workspace's flax.yml agents.docsLint names. */
const DOCS_LINT = workspace().docsLint!;
const MANUAL_REPO = DOCS_LINT.repo;
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { matchesAnyGlob } from "../src/output-check/glob.ts";
import {
  componentProblem,
  manualWordingProblems,
} from "../src/output-check/docs-components.ts";
import {
  checkPatchSet,
  resultLines,
  type CheckContext,
} from "../src/output-check/pr.ts";

const PAGE = "src/content/docs/survey/inventory-surveys.mdx";
const LINES = [
  "---",
  'title: "Inventory surveys"',
  'category: "Survey"',
  "traits: [online]",
  "---",
  "",
  'import Cast from "@/components/content/Cast.astro";',
  'import Edition from "@/components/content/Edition.astro";',
  "",
  "Survey a build folder.",
  "",
  '<Cast scenario="inventory-no-upload">',
  '  <Step at="1">Run the survey without uploading.</Step>',
  '  <Step at="2">The results are in the output folder.</Step>',
  "</Cast>",
  "",
  '<Only traits="airgapped">A Notes License is required.</Only>',
  "",
  "<Only site>",
  "Every edition can run it.",
  "</Only>",
  "",
  "```sh",
  "notes survey inventory my-app ./build # works in every edition",
  "```",
];

/** A unified diff that replaces `removed` at 0-based `at` with `added`. */
function patch(
  lines: readonly string[],
  at: number,
  removed: number,
  added: readonly string[],
): string {
  const before = lines.slice(Math.max(0, at - 2), at);
  const after = lines.slice(at + removed, at + removed + 2);
  const start = at - before.length + 1;
  return [
    `--- a/${PAGE}`,
    `+++ b/${PAGE}`,
    `@@ -${start},${before.length + removed + after.length} +${start},${before.length + added.length + after.length} @@`,
    ...before.map((l) => ` ${l}`),
    ...lines.slice(at, at + removed).map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...after.map((l) => ` ${l}`),
  ].join("\n");
}

function context(): CheckContext {
  return {
    policy: {
      repos: [MANUAL_REPO],
      paths: ["src/content/docs/**/*.md", "src/content/docs/**/*.mdx"],
      maxChangedLines: 20,
    },
    pinned: [
      { repo: MANUAL_REPO, commit: "a".repeat(40), path: PAGE, lines: LINES },
    ],
  };
}

function check(at: number, removed: number, added: string[]) {
  const before = LINES.slice(at, at + removed);
  return resultLines(
    checkPatchSet(
      {
        pages: [
          {
            repo: MANUAL_REPO,
            path: PAGE,
            decision: "patch",
            reason: "A fact.",
            patch: patch(LINES, at, removed, added),
            changes: [
              {
                removed: before,
                added,
                evidence: [
                  {
                    repo: "notes-co/notes-cli",
                    commit: "b".repeat(40),
                  },
                ],
              },
            ],
          },
        ],
      },
      context(),
    ),
  );
}

const withLine = (i: number, text: string) =>
  LINES.map((l, j) => (j === i ? text : l));

describe("component tags on docs pages", () => {
  it("allows changing the words inside a step or between gates", () => {
    expect(
      componentProblem(
        LINES,
        withLine(
          12,
          '  <Step at="1">Run the survey and keep the results local.</Step>',
        ),
      ),
    ).toBeUndefined();
    expect(
      componentProblem(LINES, withLine(9, "Survey a build folder or a jar.")),
    ).toBeUndefined();
  });

  it("refuses adding, removing or reordering a step", () => {
    const added = [
      ...LINES.slice(0, 14),
      '  <Step at="3">And more.</Step>',
      ...LINES.slice(14),
    ];
    expect(componentProblem(LINES, added)).toMatch(/component tags/);
    const removed = LINES.filter((_, i) => i !== 13);
    expect(componentProblem(LINES, removed)).toMatch(/component tags/);
    const reordered = [...LINES];
    [reordered[12], reordered[13]] = [reordered[13]!, reordered[12]!];
    expect(componentProblem(LINES, reordered)).toMatch(/component tags/);
  });

  it("refuses changing a gate's editions or removing a gate", () => {
    expect(
      componentProblem(
        LINES,
        withLine(
          16,
          '<Only traits="online">A Notes License is required.</Only>',
        ),
      ),
    ).toMatch(/<Only traits="airgapped"> becomes <Only traits="online">/);
    expect(
      componentProblem(LINES, withLine(16, "A Notes License is required.")),
    ).toMatch(/component tags/);
  });

  it("covers edition badges too", () => {
    const page = ["Text.", '<EditionBadges command="survey image" />'];
    expect(
      componentProblem(page, [
        "Text.",
        '<EditionBadges command="survey runtime" />',
      ]),
    ).toMatch(/component tags/);
  });
});

describe("the manual wording check on added lines", () => {
  const added = (line: number, text: string) => [{ line, text }];
  const after = (i: number, text: string) => withLine(i - 1, text);

  it("refuses the word edition in ungated prose of a manual chapter", () => {
    const page = after(10, "Survey a build folder in any edition.");
    expect(
      manualWordingProblems(MANUAL_REPO, page, added(10, page[9]!)),
    ).toEqual([
      'line 10 says "edition", which an edition\'s manual may not say; gate it with <Only> or <Credential />, or word it without naming editions',
    ]);
  });

  it("leaves site-only text, code blocks, inline code, tags and imports alone", () => {
    const site = after(20, "Every edition and every other product.");
    expect(
      manualWordingProblems(MANUAL_REPO, site, added(20, site[19]!)),
    ).toEqual([]);
    const code = after(24, "notes survey inventory app ./build # any edition");
    expect(
      manualWordingProblems(MANUAL_REPO, code, added(24, code[23]!)),
    ).toEqual([]);
    const inline = after(10, "Run `notes docs edition` to read it.");
    expect(
      manualWordingProblems(MANUAL_REPO, inline, added(10, inline[9]!)),
    ).toEqual([]);
    const tag = after(10, "You are running <Edition />.");
    expect(manualWordingProblems(MANUAL_REPO, tag, added(10, tag[9]!))).toEqual(
      [],
    );
    expect(
      manualWordingProblems(MANUAL_REPO, LINES, added(8, LINES[7]!)),
    ).toEqual([]);
  });

  it("checks credential words by the page's traits, outside gates", () => {
    const online = after(10, "Set NOTES_LICENSE first.");
    expect(
      manualWordingProblems(MANUAL_REPO, online, added(10, online[9]!)),
    ).toEqual([expect.stringContaining('"NOTES_LICENSE"')]);
    const gated = after(
      17,
      '<Only traits="airgapped">A Notes License is needed.</Only>',
    );
    expect(
      manualWordingProblems(MANUAL_REPO, gated, added(17, gated[16]!)),
    ).toEqual([]);
    const credential = after(10, "Set <Credential var /> first.");
    expect(
      manualWordingProblems(MANUAL_REPO, credential, added(10, credential[9]!)),
    ).toEqual([]);
  });

  it("only checks manual chapters of the public docs", () => {
    const page = after(10, "Any edition works.");
    expect(
      manualWordingProblems(
        "notes-co/internal-docs",
        page,
        added(10, page[9]!),
      ),
    ).toEqual([]);
    const mapper = page.map((l) =>
      l === 'category: "Survey"' ? 'category: "Mapper"' : l,
    );
    expect(
      manualWordingProblems(MANUAL_REPO, mapper, added(10, page[9]!)),
    ).toEqual([]);
    const notInManuals = [
      ...page.slice(0, 4),
      "manual: false",
      ...page.slice(4),
    ];
    expect(
      manualWordingProblems(MANUAL_REPO, notInManuals, added(11, page[9]!)),
    ).toEqual([]);
  });

  it("uses the same patterns as the public docs build", () => {
    expect(MANUAL_REPO).toBe("notes-co/public-docs");
    expect(DOCS_LINT.always).toEqual([
      "\\bedition",
      "depending on (your|the) (version|licen[cs]e|plan)",
      "other (versions|products)",
    ]);
    expect(DOCS_LINT.byTrait).toEqual({
      online: ["Notes Licen[cs]e", "NOTES_LICENSE"],
      airgapped: ["Notes Pass\\b", "NOTES_PASS"],
    });
    // With a public-docs checkout at hand, compare with its lint directly.
    const lint = join(
      process.env.PUBLIC_DOCS_DIR ?? "",
      "src/lib/manual-build/lint.ts",
    );
    if (process.env.PUBLIC_DOCS_DIR && existsSync(lint)) {
      const source = readFileSync(lint, "utf8");
      for (const pattern of [...DOCS_LINT.always, ...Object.values(DOCS_LINT.byTrait).flat()])
        expect(source).toContain(pattern);
    }
  });
});

describe("the PR checker on a public docs Survey page", () => {
  it("accepts a word change inside a step", () => {
    expect(
      check(12, 1, [
        '  <Step at="1">Run the survey and keep the results local.</Step>',
      ]),
    ).toEqual([]);
  });

  it("refuses a new step and edition wording", () => {
    expect(check(13, 1, [LINES[13]!, '  <Step at="3">More.</Step>'])).toEqual([
      expect.stringContaining("component tags"),
    ]);
    expect(check(9, 1, ["Survey a build folder in any edition."])).toEqual([
      expect.stringContaining('says "edition"'),
    ]);
  });

});
