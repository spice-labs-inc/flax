import { describe, expect, it } from "vitest";
import { dataValueProblems } from "../src/output-check/data-values.ts";
import { checkPatchSet, resultLines } from "../src/output-check/pr.ts";

const FILE = `scenario: "A person reads the portfolio"
id: portfolio
voice: "v-1"
# Said over the opening card.
intro:
  heading: "The portfolio"
  items:
    - { label: "Scores", icon: "chart" }
narration:
  - at: "When they open the portfolio"
    text: "The portfolio scores every subject."
hide: [1, 2]
publish:
  youtube:
    title: "The portfolio"
    tags:
      - "portfolio"
      - "scores"`.split("\n");

const KEYS = ["text", "heading", "label", "title", "tags"];

/** The file with one line's text replaced. */
function edit(from: string, to: string, lines = FILE): string[] {
  const i = lines.findIndex((l) => l.includes(from));
  if (i < 0) throw new Error(`no line with ${from}`);
  return lines.map((l, j) => (j === i ? l.replace(from, to) : l));
}

describe("dataValueProblems", () => {
  it("lets the values of data_keys change, in maps, flow maps and lists", () => {
    let after = edit("scores every subject", "ranks every subject");
    after = edit('label: "Scores"', 'label: "Ranks"', after);
    after = edit('- "scores"', '- "ranks"', after);
    after = edit('title: "The portfolio"', 'title: "Your portfolio"', after);
    expect(dataValueProblems(FILE, after, KEYS)).toEqual([]);
    expect(dataValueProblems(FILE, FILE, KEYS)).toEqual([]);
  });

  it("refuses a change to any other value, nested or in a list", () => {
    expect(
      dataValueProblems(FILE, edit('voice: "v-1"', 'voice: "v-2"'), KEYS),
    ).toEqual([
      "changes voice, which only a person changes; a patch may change only the values of text, heading, label, title, tags",
    ]);
    expect(
      dataValueProblems(
        FILE,
        edit('at: "When they open the portfolio"', 'at: "When they open it"'),
        KEYS,
      ),
    ).toEqual([
      "changes narration[0].at, which only a person changes; a patch may change only the values of text, heading, label, title, tags",
    ]);
    expect(dataValueProblems(FILE, edit("[1, 2]", "[1, 3]"), KEYS)).toEqual([
      "changes hide[1], which only a person changes; a patch may change only the values of text, heading, label, title, tags",
    ]);
    expect(
      dataValueProblems(FILE, edit('icon: "chart"', 'icon: "key"'), KEYS),
    ).toEqual([
      "changes intro.items[0].icon, which only a person changes; a patch may change only the values of text, heading, label, title, tags",
    ]);
  });

  it("refuses new, removed, renamed or moved keys and list items", () => {
    expect(
      dataValueProblems(FILE, edit("    text: ", "    words: "), KEYS)[0],
    ).toMatch(/^changes the keys of narration\[0\]/);
    expect(
      dataValueProblems(FILE, edit("[1, 2]", "[1, 2, 3]"), KEYS)[0],
    ).toMatch(/^changes the length of hide/);
    expect(
      dataValueProblems(FILE, [...FILE, '      - "trend"'], KEYS)[0],
    ).toMatch(/^changes the length of publish\.youtube\.tags/);
    expect(
      dataValueProblems(
        FILE,
        edit('text: "The portfolio scores every subject."', 'text: ["a", "b"]'),
        KEYS,
      )[0],
    ).toMatch(/^changes the shape of narration\[0\]\.text/);
  });

  it("refuses a changed comment, an unparsable result and another document", () => {
    expect(
      dataValueProblems(FILE, edit("# Said over", "# Spoken over"), KEYS),
    ).toEqual(["changes a comment, which only a person changes"]);
    expect(
      dataValueProblems(
        FILE,
        edit('text: "The', 'text: "The" broken'),
        KEYS,
      )[0],
    ).toMatch(/^the patched file cannot be read as YAML or JSON/);
    expect(
      dataValueProblems(FILE, [...FILE, "---", "id: other"], KEYS),
    ).toEqual([
      "changes how many documents the file holds; that is for a person",
    ]);
  });

  it("reads JSON the same way", () => {
    const json = JSON.stringify({ id: "a", text: "Old." }, null, 2).split("\n");
    expect(
      dataValueProblems(json, edit('"Old."', '"New."', json), KEYS),
    ).toEqual([]);
    expect(dataValueProblems(json, edit('"a"', '"b"', json), KEYS)[0]).toMatch(
      /^changes id, which only a person changes/,
    );
  });
});

describe("the PR checker with data_keys", () => {
  const page = "videos/portfolio.video.yml";
  const patch = (from: string, to: string) =>
    [
      `--- a/${page}`,
      `+++ b/${page}`,
      "@@ -11,1 +11,1 @@",
      `-${from}`,
      `+${to}`,
      "",
    ].join("\n");
  const check = (from: string, to: string, dataKeys?: string[]) =>
    checkPatchSet(
      {
        pages: [
          {
            repo: "notes-co/videos",
            path: page,
            decision: "patch",
            reason: "r",
            patch: patch(from, to),
            changes: [
              {
                removed: [from],
                added: [to],
                evidence: [{ repo: "notes-co/app", commit: "c".repeat(40) }],
                why: "w",
              },
            ],
          },
        ],
      },
      {
        policy: {
          repos: ["notes-co/videos"],
          paths: ["videos/*.video.yml"],
          maxChangedLines: 10,
          ...(dataKeys === undefined ? {} : { dataKeys }),
        },
        pinned: [
          {
            repo: "notes-co/videos",
            commit: "a".repeat(40),
            path: page,
            lines: FILE,
          },
        ],
        builtByCode: true,
      },
    );
  const text = '    text: "The portfolio scores every subject."';

  it("lets a data_keys value change and refuses the line that changes another", () => {
    expect(
      resultLines(
        check(text, '    text: "The portfolio ranks every subject."', KEYS),
      ),
    ).toEqual([]);
    expect(
      resultLines(
        check(text, '    tone: "The portfolio scores every subject."', KEYS),
      ).join("\n"),
    ).toMatch(/changes the keys of narration\[0\]/);
  });

  it("holds YAML files to nothing more when data_keys is not set", () => {
    expect(
      resultLines(
        check(text, '    tone: "The portfolio scores every subject."'),
      ),
    ).toEqual([]);
  });
});
