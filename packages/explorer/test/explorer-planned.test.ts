import { describe, expect, it } from "vitest";
import { ENV_ORDER, type Item } from "../src/lib/data.ts";
import type { Feature } from "../src/lib/features.ts";
import {
  boardWords,
  byReadiness,
  featureFor,
  groupByPersona,
  groupBySurface,
  headline,
  repoRef,
  sourceSentence,
  waitsOn,
} from "../src/lib/planned/planned.ts";
import type { PlannedIssue } from "../src/lib/planning.ts";

function issue(
  label: string,
  surface: Item["surface"],
  board: string,
  area: string,
  personas: string[],
  n = 1,
): PlannedIssue {
  const item: Item = {
    idx: n,
    id: `issue:${n}`,
    label,
    surface,
    island: surface,
    kind: "Open issue",
    area: "Open issues",
    envs: [...ENV_ORDER],
    status: {},
  };
  return {
    item,
    url: `https://github.com/acme/notes-web/issues/${n}`,
    board,
    area,
    personas,
  };
}

describe("planned page words", () => {
  it("names an issue the way people say it", () => {
    expect(repoRef("https://github.com/acme/notes-web/issues/199")).toBe(
      "notes-web#199",
    );
    expect(repoRef("https://github.com/acme/saffron/pull/7")).toBe("saffron#7");
    expect(repoRef("https://example.com/x")).toBe("example.com/x");
  });

  it("says the board column in words", () => {
    expect(boardWords("Backlog")).toBe("In the backlog");
    expect(boardWords("Ready")).toBe("Ready to build");
    expect(boardWords("Not on board")).toBe("Not on the board yet");
    expect(boardWords("Blocked")).toBe("Blocked");
  });

  it("reads what a scenario waits on as a sentence", () => {
    expect(waitsOn("")).toBe("Waits for the feature it describes to be built.");
    expect(
      waitsOn("Waiting on: A staff role that may change the license."),
    ).toBe("Waits on a staff role that may change the license.");
  });

  it("opens with the counts", () => {
    expect(headline(24, 8)).toBe(
      "24 planned features on the Engineering Board, 8 scenarios written and waiting.",
    );
    expect(headline(1, 1)).toBe(
      "1 planned feature on the Engineering Board, 1 scenario written and waiting.",
    );
    expect(headline(0, 0)).toBe("Nothing is planned.");
  });

  it("says where the board came from without the link", () => {
    const s = sourceSentence({
      readAt: "2026-10-08T00:28:25Z",
      checkedAt: "2026-10-09T15:57:48.864Z",
      source:
        "Acme Engineering Board (https://github.com/orgs/acme/projects/3) plus open issues in acme",
    });
    expect(s).toBe(
      "From the Acme Engineering Board plus open issues in acme, read Oct 7, 5:28 PM PDT; each issue was checked open on GitHub Oct 9, 8:57 AM PDT.",
    );
    expect(sourceSentence({ checkedAt: "2026-10-14T00:17:26.431Z" })).toBe(
      "From the Engineering Board as explorer/board.json keeps it; each issue was checked open on GitHub Oct 13, 5:17 PM PDT.",
    );
  });
});

describe("planned page grouping", () => {
  const a = issue(
    "Resume an upload",
    "cli",
    "Not on board",
    "survey",
    ["operator"],
    1,
  );
  const b = issue("ETag headers", "api", "Ready", "Version", [], 2);
  const c = issue(
    "Reach by kind",
    "dashboard",
    "Backlog",
    "portfolio",
    ["consumer"],
    3,
  );
  const d = issue(
    "A summary",
    "cli",
    "Backlog",
    "survey",
    ["operator", "evaluator"],
    4,
  );

  it("puts the nearest-to-built first", () => {
    expect(byReadiness([a, c, d, b]).map((i) => i.item.label)).toEqual([
      "ETag headers",
      "A summary",
      "Reach by kind",
      "Resume an upload",
    ]);
  });

  it("groups by surface in catalog order and drops empty surfaces", () => {
    const groups = groupBySurface(
      [a, b, c, d],
      [
        {
          label: "An owner deletes the organization",
          surface: "api",
          scenarioId: "features/api/organizations.feature:28",
          feature: "Managing the organization",
          waitingOn: "",
        },
      ],
    );
    expect(groups.map((g) => g.title)).toEqual([
      "Dashboard",
      "Public API",
      "Product CLI",
    ]);
    expect(groups[1]!.scenarios).toHaveLength(1);
    expect(groups[2]!.issues.map((i) => i.item.label)).toEqual([
      "A summary",
      "Resume an upload",
    ]);
  });

  it("groups by persona and keeps the ones nobody plans for", () => {
    const personas = [
      { id: "operator" },
      { id: "consumer" },
      { id: "evaluator" },
      { id: "partner" },
    ];
    const r = groupByPersona(personas, [a, b, c, d]);
    expect(r.groups.map((g) => [g.persona.id, g.issues.length])).toEqual([
      ["operator", 2],
      ["consumer", 1],
      ["evaluator", 1],
    ]);
    expect(r.nobody).toEqual([b]);
    expect(r.idle.map((p) => p.id)).toEqual(["partner"]);
  });

  it("finds the feature an issue extends by area or file name on its surface", () => {
    const f = (surface: Feature["surface"], stem: string, area: string) =>
      ({ surface, stem, area, name: stem }) as Feature;
    const features = [
      f("cli", "survey", "Surveying"),
      f("dashboard", "portfolios", "portfolio"),
      f("api", "portfolios", "portfolio"),
    ];
    expect(featureFor(features, a)?.stem).toBe("survey");
    expect(featureFor(features, c)?.surface).toBe("dashboard");
    expect(featureFor(features, b)).toBeUndefined();
  });
});
