import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  coverageAfter,
  coverageFile,
  historyFile,
  type RunOnDisk,
} from "../scripts/data.ts";
import { scenariosFile } from "../scripts/scenarios.ts";
import {
  countByEnv,
  countStations,
  gapSentences,
  pipelineSentences,
  shortCount,
  stationParts,
  stationsSentence,
  stationsText,
  verifiedText,
} from "../src/lib/counts.ts";
import { coverageModel, type BoardFile } from "../src/lib/data.ts";
import { featuresModel } from "../src/lib/features.ts";
import {
  personaDefsModel,
  type DatasetFile,
  type PersonaDef,
} from "../src/lib/personaDefs.ts";
import { personasModel } from "../src/lib/personas.ts";
import { planningModel } from "../src/lib/planning.ts";
import { scenariosModel } from "../src/lib/scenarios.ts";
import type { SurfaceFile } from "@flax/scenarios/lib/types";
import type { ScenarioResult } from "@flax/scenarios/run/results";

const root = fileURLToPath(new URL("./fixtures/workspace/", import.meta.url));
const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-15T12:00:00Z");
const at = (h: number) => new Date(T0 + h * HOUR).toISOString();

const item = (id: string, area: string) => ({
  id: `api:${id}`,
  label: id,
  surface: "api" as const,
  area,
  envs: ["dev" as const, "staging" as const, "prod" as const],
  seen: [],
});

const files: SurfaceFile[] = [
  {
    surface: "api",
    builtAt: at(0),
    sources: [],
    outOfScope: [],
    notes: [],
    items: [
      item("GET /a", "Things"),
      item("GET /b", "Things"),
      item("GET /c", "Things"),
      item("GET /d", "Teams"),
      item("GET /e", "Teams"),
      item("GET /f", "Teams"),
    ],
  },
];

const scenario = (
  id: string,
  tags: string[],
  status: ScenarioResult["status"],
  touches: ScenarioResult["touches"],
  failure?: ScenarioResult["failure"],
): ScenarioResult => ({
  id,
  name: `Scenario ${id}`,
  feature: "Things",
  tags,
  status,
  durationMs: 1000,
  touches,
  ...(failure ? { failure } : {}),
});

const run = (
  env: RunOnDisk["env"],
  h: number,
  scenarios: ScenarioResult[],
): RunOnDisk => ({
  env,
  id: `${env}-${h}`,
  planned: [],
  run: {
    env,
    runId: `${env}-${h}`,
    startedAt: at(h - 0.1),
    finishedAt: at(h),
    versions: {},
    scenarios,
  },
});

// s1 runs everywhere and verifies a and b; s2 needs a fixture organization, so it verifies c and d everywhere but prod;
// s3 needs one too and fails on dev at the step that reaches e. Nothing reaches f.
const s1 = scenario("features/api/x.feature:3", [], "passed", [
  { item: "api:GET /a", step: 0 },
  { item: "api:GET /b", step: 1 },
]);
const s2 = scenario("features/api/x.feature:9", ["@fixture"], "passed", [
  { item: "api:GET /c", step: 0 },
  { item: "api:GET /d", step: 0 },
]);
const s3 = scenario(
  "features/api/y.feature:3",
  ["@fixture"],
  "failed",
  [{ item: "api:GET /e", step: 0 }],
  { step: "Then it answers", message: "boom", at: 0 },
);

const runs: RunOnDisk[] = [
  run("dev", 0, [s1, s2, s3]),
  run("staging", 0.5, [s1, s2]),
  run("prod", 1, [s1]),
];

const def = (id: string, name: string): PersonaDef => ({
  id,
  name,
  type: "primary",
  summary: "",
  who: "",
  titles: [],
  goals: [],
  needs: [],
  consumes: "",
  prize: { test: "" },
  journey: { name: "", steps: [] },
  friction: [],
  antiGoals: [],
  surfaces: [],
  neverTouches: [],
  editions: [],
  fixtureRole: "",
  tensions: [],
  evidence: [],
  sources: [],
});

const station = (key: string, name: string, items: string[]) => ({
  key,
  name,
  stage: "Start" as const,
  kind: "surface" as const,
  items: items.map((i) => `api:${i}`),
});

const dataset: DatasetFile = {
  commit: "",
  coverageMapBuiltAt: null,
  personas: [def("ops", "Operator"), def("eva", "Evaluator")],
  stations: [
    station("home", "Home", ["GET /a"]),
    station("signin", "Sign in", ["GET /b"]),
    station("setup", "Set up", ["GET /c", "GET /d"]),
    station("pay", "Pay", ["GET /f"]),
  ],
  journeys: [
    { persona: "ops", stations: ["home", "setup"] },
    { persona: "eva", stations: ["home", "signin", "setup", "pay"] },
  ],
  orphans: [],
  broken: [],
  deadMatchers: [],
};

const board: BoardFile = {
  readAt: at(1),
  checkedAt: at(1),
  source: "",
  items: [],
  bugs: [],
};

const map = coverageAfter(files, runs, at(1));
const coverage = coverageFile(map, files, [], runs);
const history = historyFile(root, files, runs, "c".repeat(40), at(1));
const cov = coverageModel(coverage, history, board);
const file = scenariosFile(root, "/nonexistent", runs, history.scenarios).file;
const scen = scenariosModel(cov, file, {});
const defs = personaDefsModel(dataset);
const pers = personasModel(cov, defs);
const feats = featuresModel(cov, scen, pers, file.features);
const plan = planningModel(cov, scen, pers, defs, feats);
const latest = cov.LATEST;
const island = cov.mapItems.filter((it) => !it.planned);
const things = island.filter((it) => it.area === "Things");
const teams = island.filter((it) => it.area === "Teams");

describe("one count for items", () => {
  it("leads the island label, the surface row and the headline with prod", () => {
    expect(shortCount(cov, island, latest, "all")).toBe(
      "2 of 6 verified on prod, 3 not checked there",
    );
    const by = countByEnv(cov, island, latest);
    expect(verifiedText(by.prod)).toBe("2 of 6 items verified on prod");
    expect(gapSentences(cov, island, latest, by.prod)).toEqual([
      { text: "3 are not checked on prod:" },
      {
        text: "3 have only scenarios that create a fixture, which prod runs never do.",
        under: true,
      },
      { text: "1 has no scenario yet." },
    ]);
    expect(pipelineSentences(by, "prod")).toEqual([
      "Staging: 4 of 6 verified.",
      "Dev: 4 of 6 verified, 1 failing.",
    ]);
  });

  it("says the chosen env and its failures when one is chosen", () => {
    expect(shortCount(cov, island, latest, "dev")).toBe(
      "4 of 6 verified on dev, 1 failing",
    );
    expect(shortCount(cov, island, latest, "staging")).toBe(
      "4 of 6 verified on staging, 1 not checked there",
    );
  });

  it("adds up: the areas of an island count to the island", () => {
    expect(shortCount(cov, things, latest, "all")).toBe(
      "2 of 3 verified on prod, 1 not checked there",
    );
    expect(shortCount(cov, teams, latest, "all")).toBe(
      "0 of 3 verified on prod, 2 not checked there",
    );
    for (const env of ["dev", "staging", "prod"] as const) {
      const whole = countByEnv(cov, island, latest)[env];
      const a = countByEnv(cov, things, latest)[env];
      const b = countByEnv(cov, teams, latest)[env];
      expect(whole.verified).toBe(a.verified + b.verified);
      expect(whole.total).toBe(a.total + b.total);
    }
  });
});

describe("one count for stations", () => {
  const eva = pers.personas.find((p) => p.id === "eva")!;

  it("reads the same on the lines, in search and in the briefs", () => {
    const lines = countStations(
      eva.stations.map((s) => pers.stationState(s, latest, "prod")),
      "prod",
    );
    const brief = plan.personaCoverage(eva, latest, "all");
    expect(brief.lead).toBe("prod");
    expect(brief.count).toEqual(lines);
    expect(stationsText(lines)).toBe("2 of 4 stations verified on prod");
    expect(stationsText(lines, false)).toBe("2 of 4 stations verified");
    expect(stationParts(brief.count)).toEqual([
      "2 of 4 stations verified on prod",
      "1 not checked there",
      "1 with no scenario yet",
    ]);
    expect(stationsSentence(brief.count, 0)).toBe(
      "2 of 4 stations verified on prod, 1 not checked there, 1 with no scenario yet; nothing planned on the board.",
    );
  });

  it("ranks personas worst served first, each with what blocks it", () => {
    const served = plan.worstServed(latest, "prod");
    expect(served.map((s) => s.coverage.persona.id)).toEqual(["eva", "ops"]);
    expect(served[0]!.block).toMatchObject({
      state: "none",
      reason:
        "No scenario checks it yet, and nothing on the board is planned for it.",
    });
    expect(served[0]!.block?.station.key).toBe("pay");
    expect(served[0]!.block?.personas.map((p) => p.id)).toEqual(["eva"]);
    expect(served[1]!.block).toMatchObject({
      state: "unchecked",
      reason: "Its scenarios create a fixture, which prod runs never do.",
    });
    expect(served[1]!.block?.personas.map((p) => p.id)).toEqual(["ops", "eva"]);
  });

  it("names what proves a station: the fewest scenarios that reach the most of it", () => {
    const setup = pers.personas[0]!.stations[1]!;
    const proof = plan.stationProof(setup, latest, "all");
    expect(proof?.env).toBe("staging");
    expect(proof?.rows.map((r) => r.scenario.id)).toEqual([
      "features/api/x.feature:9",
    ]);
  });
});
