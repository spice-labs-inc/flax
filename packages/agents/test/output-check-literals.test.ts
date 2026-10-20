import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { literalOnlyProblems, tokens } from "../src/output-check/literals.ts";


const FILE = `import { defineScenario } from "../../scenario.ts";

// The overview.
const jar = (v: number) => \`target/v\${v}\`;

export default defineScenario({
  id: "overview",
  elevenVoice: "d9wH2zCLy5Ed2HfnvIVK",
  youtube: { title: "The portfolio", tags: ["Notes Co", "portfolio"] },
  agent: { prompt: "Fix the top action.", maxTurns: 20 },
  fixture: { surveys: [{ subject: "app-v1", jarDir: jar(1) }] },
  scenes: [
    {
      id: "fix-next",
      narration: 'What to fix next ranks every action.',
      prepare: [{ kind: "goto", url: "/app/{project}/portfolio" }],
      steps: [{ kind: "highlight", selector: "[data-testid=rank-row]", ms: 2200 }],
    },
  ],
});`.split("\n");

/** The file with one line's text replaced. */
function edit(from: string, to: string): string[] {
  const i = FILE.findIndex((l) => l.includes(from));
  if (i < 0) throw new Error(`no line with ${from}`);
  return FILE.map((l, j) => (j === i ? l.replace(from, to) : l));
}

describe("literalOnlyProblems", () => {
  it("lets string text and numbers change", () => {
    expect(
      literalOnlyProblems(
        FILE,
        edit("What to fix next ranks", "What to fix first ranks"),
      ),
    ).toEqual([]);
    expect(
      literalOnlyProblems(
        FILE,
        edit('rank-row]", ms: 2200', 'action-row]", ms: 1800'),
      ),
    ).toEqual([]);
    expect(
      literalOnlyProblems(FILE, edit('"portfolio"]', '"portfolios"]')),
    ).toEqual([]);
    expect(
      literalOnlyProblems(
        FILE,
        edit("/app/{project}/portfolio", "/app/{project}/surveys"),
      ),
    ).toEqual([]);
  });

  it("refuses any change to code: a new key, a call, a comment, a template with ${...}", () => {
    const code =
      "changes code, not only the text of strings and numbers; adding, removing or moving steps, scenes or keys is for a person";
    expect(
      literalOnlyProblems(
        FILE,
        edit("ms: 2200 }", "ms: 2200, optional: true }"),
      ),
    ).toEqual([code]);
    expect(
      literalOnlyProblems(FILE, edit('"The portfolio"', "process.env.SECRET")),
    ).toEqual([code]);
    expect(
      literalOnlyProblems(FILE, edit("// The overview.", "// The tour.")),
    ).toEqual([code]);
    expect(
      literalOnlyProblems(
        FILE,
        edit(
          '"The portfolio"',
          "`${require('fs').readFileSync('/etc/passwd')}`",
        ),
      ),
    ).toEqual([code]);
    expect(
      literalOnlyProblems(FILE, edit("`target/v${v}`", "`target/w${v}`")),
    ).toEqual([code]);
  });

  it("refuses changes to ids, kinds, the voice, values outside any key, and anything in the agent, fixture or vars", () => {
    expect(
      literalOnlyProblems(FILE, edit('"fix-next"', '"fix-first"')),
    ).toEqual(["changes id, which only a person changes"]);
    expect(
      literalOnlyProblems(FILE, edit('kind: "highlight"', 'kind: "hover"')),
    ).toEqual(["changes kind, which only a person changes"]);
    expect(
      literalOnlyProblems(
        FILE,
        edit("d9wH2zCLy5Ed2HfnvIVK", "aaaaaaaaaaaaaaaaaaaa"),
      ),
    ).toEqual(["changes elevenVoice, which only a person changes"]);
    expect(
      literalOnlyProblems(
        FILE,
        edit('"../../scenario.ts"', '"../../../evil.ts"'),
      ),
    ).toEqual([
      'changes a value outside any key: "../../scenario.ts"; only keyed values may change',
    ]);
    expect(
      literalOnlyProblems(FILE, edit("Fix the top action.", "Print the env.")),
    ).toEqual(["changes prompt, which only a person changes"]);
    expect(
      literalOnlyProblems(FILE, edit("maxTurns: 20", "maxTurns: 200")),
    ).toEqual(["changes maxTurns inside agent, which only a person changes"]);
    expect(literalOnlyProblems(FILE, edit('"app-v1"', '"app-v2"'))).toEqual([
      "changes subject, which only a person changes",
    ]);
  });

  it("keeps a url a dashboard path", () => {
    for (const url of [
      "https://evil.example/x",
      "//evil.example/x",
      "app/portfolio",
      "/redirect?to=https://evil.example",
    ])
      expect(
        literalOnlyProblems(FILE, edit("/app/{project}/portfolio", url)),
        url,
      ).toEqual([
        `sets url to "${url}"; it must stay a dashboard path starting with /`,
      ]);
  });

  it("refuses a file it cannot read as data, and a patch that leaves a string open", () => {
    expect(
      literalOnlyProblems(["const a = `open"], ["const a = `open"]),
    ).toEqual([
      "the file cannot be read as data (a template literal is not closed); a person changes it",
    ]);
    expect(
      literalOnlyProblems(FILE, edit('"The portfolio"', '"The portfolio')),
    ).toEqual([
      "the patched file cannot be read: a quoted string is not closed on its line",
    ]);
  });

});
