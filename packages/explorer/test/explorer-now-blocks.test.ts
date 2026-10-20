import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  coverageAfter,
  coverageFile,
  historyFile,
  type RunOnDisk,
} from "../scripts/data.ts";
import { scenariosFile } from "../scripts/scenarios.ts";
import { coverageModel, type BoardFile } from "../src/lib/data.ts";
import { nowModel } from "../src/lib/now.ts";
import {
  blocksText,
  cardBlocks,
  notCheckedText,
  statement,
} from "../src/lib/now/copy.ts";
import {
  personaDefsModel,
  type DatasetFile,
  type PersonaDef,
} from "../src/lib/personaDefs.ts";
import { personasModel } from "../src/lib/personas.ts";
import { scenariosModel } from "../src/lib/scenarios.ts";
import type { SurfaceFile } from "@flax/scenarios/lib/types";
import type { ScenarioResult } from "@flax/scenarios/run/results";

const root = fileURLToPath(new URL("./fixtures/workspace/", import.meta.url));
const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-15T12:00:00Z");
const at = (h: number) => new Date(T0 + h * HOUR).toISOString();

const item = (id: string) => ({
  id: `api:${id}`,
  label: id,
  surface: "api" as const,
  area: "Things",
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
    items: [item("GET /a"), item("GET /b"), item("GET /c"), item("GET /d")],
  },
];

const scenario = (
  id: string,
  status: ScenarioResult["status"],
  touches: ScenarioResult["touches"],
  failure?: ScenarioResult["failure"],
): ScenarioResult => ({
  id,
  name: `Scenario ${id}`,
  feature: "Things",
  tags: ["@fixture"],
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

// s1 reaches a at step 1 and b at step 2, and fails at step 2; s2 cannot reach the env; s3 fails at a step that touches nothing.
const s1 = (status: ScenarioResult["status"]) =>
  scenario(
    "features/api/x.feature:3",
    status,
    [
      { item: "api:GET /a", step: 0 },
      { item: "api:GET /b", step: 1 },
    ],
    status === "failed"
      ? { step: "Then it answers", message: "boom\nmore boom", at: 1 }
      : undefined,
  );
const s2 = (status: ScenarioResult["status"]) =>
  scenario(
    "features/api/x.feature:9",
    status,
    [{ item: "api:GET /c", step: 0 }],
    status === "failed"
      ? {
          step: "Given a project",
          message:
            "TypeError: fetch failed\nCaused by: Error: getaddrinfo ENOTFOUND api.dev.example",
          at: 0,
        }
      : undefined,
  );
const s3 = (status: ScenarioResult["status"]) =>
  scenario(
    "features/api/y.feature:3",
    status,
    [{ item: "api:GET /d", step: 0 }],
    status === "failed"
      ? { step: "Then the log is clean", message: "bang", at: 2 }
      : undefined,
  );

const runs: RunOnDisk[] = [
  run("dev", 0, [s1("passed"), s2("passed"), s3("passed")]),
  run("staging", 0.5, [s1("passed")]),
  run("dev", 1, [s1("failed"), s2("failed"), s3("failed")]),
  run("staging", 1.5, [s1("failed")]),
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

const dataset: DatasetFile = {
  commit: "",
  coverageMapBuiltAt: null,
  personas: [def("eva", "Evaluator"), def("ops", "Operator")],
  stations: [
    {
      key: "home",
      name: "Home",
      stage: "Start",
      kind: "surface",
      items: ["api:GET /a"],
    },
    {
      key: "signin",
      name: "Sign in",
      stage: "Start",
      kind: "surface",
      items: ["api:GET /b"],
    },
  ],
  journeys: [
    { persona: "eva", stations: ["home", "signin"] },
    { persona: "ops", stations: ["home"] },
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
const map = coverageAfter(files, runs, at(1.5));
const coverage = coverageFile(map, files, [], runs);
const history = historyFile(root, files, runs, "c".repeat(40), at(1.5));
const cov = coverageModel(coverage, history, board);
const file = scenariosFile(root, "/nonexistent", runs, history.scenarios).file;
// Without a messages file the build cannot place a failure, so the fixture takes the step from run.json.
for (const d of file.scenarios)
  for (const recs of Object.values(d.records))
    for (const r of recs) {
      const src = runs
        .find((x) => x.run.runId === file.runs[r.run]!.id)
        ?.run.scenarios.find((x) => x.id === d.id)?.failure;
      if (r.failure && src?.at !== undefined) r.failure.at = src.at;
    }
const scen = scenariosModel(cov, file, {});
const pers = personasModel(cov, personaDefsModel(dataset));
const now = nowModel(cov, scen, { featureOf: () => undefined }, pers);
const latest = cov.LATEST;
const ref = Date.parse(at(2));

describe("the Now view", () => {
  const view = now.nowView(latest, "all");
  const dev = view.envs.find((e) => e.env === "dev")!;

  it("keeps the failures that could not reach the env apart", () => {
    expect(dev.failing.map((f) => f.scenario.id)).toEqual([
      "features/api/x.feature:3",
      "features/api/y.feature:3",
    ]);
    expect(view.unreached.map((u) => [u.env, u.failing.length])).toEqual([
      ["dev", 1],
    ]);
    expect(statement(dev, ref)).toBe(
      "2 of 3 scenarios failing on Dev, the oldest since Oct 15, 6:00 AM PDT. 1 more could not reach it.",
    );
  });

  it("shows one card per scenario, listing its envs prod first", () => {
    const cards = view.groups.flatMap((g) => g.cards);
    expect(cards.map((c) => [c.scenario.id, c.envs.map((f) => f.env)])).toEqual(
      [
        ["features/api/x.feature:3", ["staging", "dev"]],
        ["features/api/y.feature:3", ["dev"]],
      ],
    );
  });

  it("blocks only what the failing step touched, and the stations and personas holding it", () => {
    const f = dev.failing[0]!;
    expect(f.blocks.items.map((it) => it.id)).toEqual(["api:GET /b"]);
    expect(f.blocks.stations.map((s) => s.name)).toEqual(["Sign in"]);
    expect(f.blocks.personas.map((p) => p.name)).toEqual(["Evaluator"]);
    expect(blocksText(f)).toBe(
      "It blocks Sign in for 1 persona: Evaluator. Step 2 touches GET /b.",
    );
    const card = view.groups[0]!.cards[0]!;
    expect(cardBlocks(card.envs)).toEqual([blocksText(f)]);
  });

  it("says when a failure blocks no customer journey", () => {
    const f = dev.failing[1]!;
    expect(f.blocks.items).toEqual([]);
    expect(blocksText(f)).toBe(
      "It fails at step 3, which touches nothing on the map, so it blocks no customer journey.",
    );
  });

  it("lights what the failures block, and nothing a run that could not reach the env touched", () => {
    const id = (idx: number) => cov.items[idx]!.id;
    expect([...view.from].map(id)).toEqual(["api:GET /b"]);
    expect([...view.lit].map(id)).toEqual(["api:GET /b"]);
  });

  it("splits the first line of the error from the rest", () => {
    const f = dev.failing[0]!;
    expect([f.message, f.more]).toEqual(["boom", "more boom"]);
  });

  it("says what an env's runs leave unchecked on the map", () => {
    const prod = view.envs.find((e) => e.env === "prod")!;
    expect(prod.notChecked.total).toBe(4);
    expect(notCheckedText(prod)).toBe(
      "They leave 4 items on the map not checked on Prod: for 4, every scenario that reaches them creates a fixture, which Prod runs never do.",
    );
  });
});
