import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  matches,
  resolveJourneys,
  type CoverageInput,
} from "../src/dataset/journeys.ts";
import { loadDatasetFiles, parseDatasetFile } from "../src/dataset/load.ts";
import {
  checkText,
  matcherProblem,
  validateDataset,
  type DatasetFile,
  type DatasetFiles,
} from "../src/dataset/schema.ts";

const FIXTURE = "test/fixtures/dataset/valid";
let valid: DatasetFiles;

beforeAll(async () => {
  valid = await loadDatasetFiles(FIXTURE);
});

/** The valid fixture with one file's text edited and reparsed. */
function edit(path: string, from: string | RegExp, to: string): DatasetFiles {
  const change = (f: DatasetFile): DatasetFile => {
    if (f.path !== path) return f;
    const text = f.text.replace(from, to);
    if (text === f.text) throw new Error(`${path}: "${from}" not found`);
    return parseDatasetFile(f.path, text);
  };
  return {
    personas: valid.personas.map(change),
    stations: valid.stations && change(valid.stations),
    journeys: valid.journeys.map(change),
  };
}

function errorsOf(files: DatasetFiles): string[] {
  return validateDataset(files).errors;
}

describe("validateDataset", () => {
  it("accepts the valid fixture", () => {
    const res = validateDataset(valid);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.dataset.personas.map((p) => p.id)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(res.dataset.stations).toHaveLength(4);
    expect(res.dataset.journeys.map((j) => j.persona)).toEqual([
      "alpha",
      "gamma",
    ]);
  });

  const cases: [string, string, string | RegExp, string, string][] = [
    [
      "a missing field",
      "personas/alpha.yml",
      "summary: A primary fixture persona.\n",
      "",
      "personas/alpha.yml.summary: missing",
    ],
    [
      "an empty required list on a designed-for persona",
      "personas/alpha.yml",
      "goals:\n  - A complete inventory\n",
      "goals: []\n",
      "personas/alpha.yml.goals: empty",
    ],
    [
      "an unknown persona type",
      "personas/alpha.yml",
      "type: primary",
      "type: tertiary",
      '"tertiary" is not one of',
    ],
    [
      "a retired edition name",
      "personas/alpha.yml",
      "  - cli\n",
      "  - lite\n",
      'editions[0]: "lite" is not one of',
    ],
    [
      "fields out of order",
      "personas/alpha.yml",
      "id: alpha\nname: Alpha\n",
      "name: Alpha\nid: alpha\n",
      "fields out of order",
    ],
    [
      "a malformed date",
      "personas/alpha.yml",
      "    date: 2026-10-07\n    assumption: true",
      "    date: October 2026\n    assumption: true",
      "evidence[0].date",
    ],
    [
      "an impossible date",
      "personas/alpha.yml",
      "    date: 2026-10-07\n    assumption: true",
      "    date: 2026-02-30\n    assumption: true",
      "is not a real date",
    ],
    [
      "a non-boolean assumption",
      "personas/alpha.yml",
      "assumption: true",
      "assumption: maybe",
      "assumption: expected true or false",
    ],
    [
      "a file name that differs from the id",
      "personas/alpha.yml",
      "id: alpha",
      "id: alpha-two",
      "file name must be alpha-two.yml",
    ],
    [
      "a tension with an unknown persona",
      "personas/alpha.yml",
      "with: gamma",
      "with: delta",
      'unknown persona "delta"',
    ],
    [
      "a tension with itself",
      "personas/alpha.yml",
      "with: gamma",
      "with: alpha",
      "a tension with itself",
    ],
    [
      "an em-dash",
      "personas/alpha.yml",
      "Runs surveys for a fixture org.",
      "Runs surveys \u2014 for a fixture org.",
      "personas/alpha.yml:7: em-dash",
    ],
    [
      'the word "mint"',
      "personas/alpha.yml",
      "Runs surveys for a fixture org.",
      "Mints tokens for a fixture org.",
      'the word "mint"',
    ],
    [
      '"mint" in a comment',
      "personas/alpha.yml",
      "# Fixture persona.",
      "# Fixture persona that can mint.",
      "personas/alpha.yml:1: the word",
    ],
    [
      '"political capital"',
      "personas/alpha.yml",
      "Slow onboarding",
      "Spends political capital",
      '"political capital"',
    ],
    [
      '"minefield"',
      "personas/alpha.yml",
      "Slow onboarding",
      "A political minefield",
      '"minefield"',
    ],
    [
      "a YAML syntax error",
      "personas/alpha.yml",
      "name: Alpha",
      "name: [Alpha",
      "personas/alpha.yml: ",
    ],
    [
      "an unknown stage",
      "journeys/stations.yml",
      "stage: Discover",
      "stage: Explore",
      '"Explore" is not one of',
    ],
    [
      "an unknown station kind",
      "journeys/stations.yml",
      "kind: elsewhere",
      "kind: someday",
      '"someday" is not one of',
    ],
    [
      "a surface station with no matchers",
      "journeys/stations.yml",
      "kind: elsewhere",
      "kind: surface",
      "a surface station needs at least one matcher",
    ],
    [
      "a matcher without a surface",
      "journeys/stations.yml",
      "websites:www.example.test/",
      "www.example.test/",
      "does not start with a surface name",
    ],
    [
      "a wildcard in the middle",
      "journeys/stations.yml",
      "install:installer:*",
      "install:*:bash",
      "allowed only at the end",
    ],
    [
      "a duplicate station key",
      "journeys/stations.yml",
      "key: teams",
      "key: install",
      'station "install" defined twice',
    ],
    [
      "a journey for an unknown persona",
      "journeys/gamma.yml",
      "persona: gamma",
      "persona: delta",
      'journeys/gamma.yml: unknown persona "delta"',
    ],
    [
      "a journey for a negative persona",
      "journeys/gamma.yml",
      "persona: gamma",
      "persona: beta",
      "is a negative persona",
    ],
    [
      "an unknown station key",
      "journeys/alpha.yml",
      "  - teams",
      "  - tems",
      'unknown station "tems"',
    ],
    [
      "a station listed twice",
      "journeys/alpha.yml",
      "  - teams",
      "  - install",
      'station "install" listed twice',
    ],
  ];

  it.each(cases)("catches %s", (_name, path, from, to, expected) => {
    const errors = errorsOf(edit(path, from, to));
    expect(errors.some((e) => e.includes(expected))).toBe(true);
  });

  it("allows a field the schema does not name, so a workspace can extend a persona", () => {
    expect(
      errorsOf(
        edit(
          "personas/alpha.yml",
          "fixtureRole: org Admin",
          "fixtureRole: org Admin\nmood: calm",
        ),
      ),
    ).toEqual([]);
  });

  it("allows an empty journey and lists on a negative persona", () => {
    const res = validateDataset(valid);
    expect(res.dataset.personas.find((p) => p.id === "beta")?.goals).toEqual(
      [],
    );
  });

  it("warns about unused stations and personas without a journey", () => {
    const files = edit("journeys/gamma.yml", "  - home", "  - install");
    const res = validateDataset({
      ...files,
      journeys: files.journeys.filter((j) => j.path !== "journeys/alpha.yml"),
    });
    expect(res.errors).toEqual([]);
    expect(res.warnings).toContain(
      'journeys/stations.yml: station "home" is on no journey',
    );
    expect(res.warnings).toContain("personas/alpha.yml: no journey yet");
  });

  it("needs stations.yml when journeys exist", () => {
    expect(errorsOf({ ...valid, stations: null })).toContain(
      "journeys/stations.yml: missing; journeys reference its stations",
    );
  });
});

describe("checkText", () => {
  it("leaves words that only contain mint alone", () => {
    expect(checkText("x.yml", "peppermint and mintage, terminate")).toEqual([]);
  });

  it("finds a phrase split across lines", () => {
    expect(checkText("x.yml", "a\nspends political\n  capital")).toEqual([
      'x.yml:2: "political capital"; say friction',
    ]);
  });
});

describe("matcherProblem", () => {
  it("accepts the three matcher forms", () => {
    expect(matcherProblem("api:GET /api/v1/user/project")).toBeNull();
    expect(matcherProblem("install:installer:*")).toBeNull();
    expect(matcherProblem("api:* /api/v1/org/{orgId}/team*")).toBeNull();
    expect(matcherProblem("api:* /api/v1/org/{orgId}")).toBeNull();
  });

  it("rejects a whole-surface wildcard and a bad any-method form", () => {
    expect(matcherProblem("mcp:*")).toContain("whole surface");
    expect(matcherProblem("api:* api/v1")).toContain('"api:* /path"');
  });
});

describe("matches", () => {
  it("matches exact ids only exactly", () => {
    expect(matches("api:GET /a", "api:GET /a")).toBe(true);
    expect(matches("api:GET /a/b", "api:GET /a")).toBe(false);
  });

  it("matches prefixes ending in *", () => {
    expect(matches("install:installer:bash", "install:installer:*")).toBe(true);
    expect(matches("install:release:cli", "install:installer:*")).toBe(false);
  });

  it("matches any method with api:*", () => {
    expect(
      matches("api:GET /org/{orgId}/team", "api:* /org/{orgId}/team*"),
    ).toBe(true);
    expect(
      matches(
        "api:DELETE /org/{orgId}/team/{teamId}",
        "api:* /org/{orgId}/team*",
      ),
    ).toBe(true);
    expect(
      matches("api:GET /org/{orgId}/role", "api:* /org/{orgId}/team*"),
    ).toBe(false);
    expect(matches("api:PUT /org/{orgId}", "api:* /org/{orgId}")).toBe(true);
    expect(matches("api:PUT /org/{orgId}/team", "api:* /org/{orgId}")).toBe(
      false,
    );
    expect(matches("mcp:tool:x /org", "api:* /org*")).toBe(false);
  });
});

describe("resolveJourneys", () => {
  const coverage = JSON.parse(
    readFileSync("test/fixtures/dataset/coverage-map.json", "utf8"),
  ) as CoverageInput;

  it("resolves stations to item ids and lists orphans", () => {
    const res = resolveJourneys(validateDataset(valid).dataset, coverage);
    const byKey = new Map(res.stations.map((s) => [s.key, s]));
    expect(res.coverageMapBuiltAt).toBe("2026-10-07T00:00:00.000Z");
    expect(byKey.get("home")?.items).toEqual(["websites:www.example.test/"]);
    expect(byKey.get("home")?.personas).toEqual(["gamma"]);
    expect(byKey.get("install")?.items).toEqual([
      "install:installer:bash",
      "install:installer:powershell",
    ]);
    expect(byKey.get("teams")?.items).toEqual([
      "api:GET /org/{orgId}/team",
      "api:POST /org/{orgId}/team/{teamId}/user",
    ]);
    expect(byKey.get("offline")?.items).toEqual([]);
    expect(res.orphans).toEqual([
      "websites:www.example.test/pricing",
      "install:release:cli",
      "api:GET /org/{orgId}/role",
      "cli:cli:survey inventory",
    ]);
    expect(res.broken).toEqual([]);
    expect(res.deadMatchers).toEqual([]);
  });

  it("does not count stations on no journey toward coverage", () => {
    const { dataset } = validateDataset(valid);
    const res = resolveJourneys(
      {
        stations: dataset.stations,
        journeys: dataset.journeys.filter((j) => j.persona !== "gamma"),
      },
      coverage,
    );
    expect(res.orphans).toContain("websites:www.example.test/");
  });

  it("reports a surface station that matches nothing as broken", () => {
    const { dataset } = validateDataset(
      edit(
        "journeys/stations.yml",
        "websites:www.example.test/",
        "websites:gone/",
      ),
    );
    const res = resolveJourneys(dataset, coverage);
    expect(res.broken).toEqual([
      { station: "home", matchers: ["websites:gone/"] },
    ]);
    expect(res.orphans).toContain("websites:www.example.test/");
  });

  it("reports a dead matcher in a station that matches other items", () => {
    const { dataset } = validateDataset(
      edit(
        "journeys/stations.yml",
        "      - install:installer:*",
        "      - install:installer:*\n      - install:image:none",
      ),
    );
    const res = resolveJourneys(dataset, coverage);
    expect(res.broken).toEqual([]);
    expect(res.deadMatchers).toEqual([
      { station: "install", matcher: "install:image:none" },
    ]);
  });

  it("never reports planned or elsewhere stations as broken", () => {
    const { dataset } = validateDataset(
      edit(
        "journeys/stations.yml",
        "    match: []",
        "    match:\n      - cli:gone",
      ),
    );
    expect(resolveJourneys(dataset, coverage).broken).toEqual([]);
  });
});

describe("the fixture dataset read from disk", () => {
  it("validates", async () => {
    const res = validateDataset(await loadDatasetFiles(FIXTURE));
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.dataset.personas.length).toBeGreaterThan(0);
    expect(res.dataset.journeys.length).toBeGreaterThan(0);
  });
});
