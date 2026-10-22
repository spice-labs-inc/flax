import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  coverageAfter,
  coverageFile,
  historyFile,
  type RunOnDisk,
} from "../scripts/data.ts";
import {
  currentByEnv,
  fixturesRun,
  scenariosFile,
} from "../scripts/scenarios.ts";
import { explorerConfig } from "../server/config.ts";
import { prune } from "../server/store.ts";
import { coverageModel, type BoardFile, type Item } from "../src/lib/data.ts";
import { unlistedScenarios } from "../src/lib/features.ts";
import { nowModel } from "../src/lib/now.ts";
import { personaDefsModel } from "../src/lib/personaDefs.ts";
import { personasModel } from "../src/lib/personas.ts";
import { scenariosModel, type ScenarioDetail } from "../src/lib/scenarios.ts";
import { asOfText, verdictModel } from "../src/lib/verdict.ts";
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
    items: [item("GET /quick"), item("GET /heavy")],
  },
];

const scenario = (
  id: string,
  tags: string[],
  status: ScenarioResult["status"],
  touched: string,
): ScenarioResult => ({
  id,
  name: `Scenario ${id}`,
  feature: "Things",
  tags,
  status,
  durationMs: 1000,
  touches: [{ item: `api:${touched}`, step: 0 }],
  ...(status === "failed"
    ? { failure: { step: "Then it answers", message: "boom", at: 0 } }
    : {}),
});

const run = (
  h: number,
  scenarios: ScenarioResult[],
  cadence?: string,
  planned: string[] = [],
): RunOnDisk => ({
  env: "dev",
  id: `dev-${String(h + 100).padStart(3, "0")}`,
  planned: planned.map((id) => ({ id, name: id, feature: "Things", tags: [] })),
  run: {
    env: "dev",
    runId: `dev-${String(h + 100).padStart(3, "0")}`,
    startedAt: at(h - 0.1),
    finishedAt: at(h),
    versions: {},
    ...(cadence ? { cadence } : {}),
    scenarios,
  },
});

const quick = scenario("features/api/q.feature:3", [], "passed", "GET /quick");
const heavy = scenario(
  "features/api/h.feature:3",
  ["@daily"],
  "failed",
  "GET /heavy",
);

// Hourly ordinary runs on dev and a daily run between them, eleven hours before the last ordinary run.
const runs: RunOnDisk[] = [
  run(
    -34,
    [{ ...heavy, status: "passed", failure: undefined } as ScenarioResult],
    "daily",
    ["features/api/old.feature:1"],
  ),
  run(-12, [quick], undefined, ["features/api/gone.feature:1"]),
  run(-11, [quick]),
  run(-10, [heavy], "daily", ["features/api/daily.feature:1"]),
  run(-2, [quick]),
  run(-1, [quick]),
  run(0, [quick], undefined, ["features/api/now.feature:1"]),
];

describe("the current runs of an env", () => {
  it("are its newest ordinary run and its newest run of each cadence", () => {
    expect(
      currentByEnv(runs)
        .get("dev")!
        .map((r) => r.id),
    ).toEqual(["dev-090", "dev-100"]);
    expect(currentByEnv(runs).get("prod")).toEqual([]);
  });

  it("say whether fixtures run there, whichever of them ran one", () => {
    const fixture = scenario(
      "features/api/f.feature:3",
      ["@fixture"],
      "passed",
      "GET /quick",
    );
    expect(fixturesRun(runs)("dev")).toBe(false);
    expect(
      fixturesRun([
        ...runs.slice(0, 3),
        run(-10, [fixture], "daily"),
        run(0, [quick]),
      ])("dev"),
    ).toBe(true);
    expect(
      fixturesRun([run(-10, [fixture]), run(0, [quick], "daily")])("dev"),
    ).toBe(true);
    expect(fixturesRun([run(-10, [fixture]), run(0, [quick])])("dev")).toBe(
      false,
    );
  });
});

describe("a cadence run beside ordinary runs", () => {
  const map = coverageAfter(files, runs, at(0));
  const coverage = coverageFile(map, files, [], runs);
  const history = historyFile(root, files, runs, "c".repeat(40), at(0));
  const board: BoardFile = {
    readAt: at(0),
    checkedAt: at(0),
    source: "",
    items: [],
    bugs: [],
  };
  const cov = coverageModel(coverage, history, board);
  const file = scenariosFile(
    root,
    "/nonexistent",
    runs,
    history.scenarios,
  ).file;
  const scen = scenariosModel(cov, file, {});
  const v = verdictModel(cov, scen);
  const it_ = (id: string): Item =>
    cov.items.find((i) => i.id === `api:${id}`)!;

  it("records each run's cadence for the page", () => {
    expect(file.runs.map((r) => r.cadence)).toEqual([
      "daily",
      undefined,
      undefined,
      "daily",
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("keeps the cadence scenario's result through the ordinary runs after it", () => {
    expect(history.snapshots.at(-1)!.scen).toBe(
      history.scenarios
        .map((s) => (s.id === heavy.id ? "--f" : "--p"))
        .join(""),
    );
  });

  it("lists the planned scenarios of the current runs only", () => {
    expect(history.planned.map((p) => p.id)).toEqual([
      "features/api/daily.feature:1",
      "features/api/now.feature:1",
    ]);
  });

  it("measures the age of a cadence's proof against that cadence's own gap", () => {
    expect(v.runGaps.dev).toBe(HOUR);
    const heavyCell = v.verdict(it_("GET /heavy"), "dev", cov.LATEST);
    expect(heavyCell).toMatchObject({
      state: "failing",
      asOf: at(-10),
      stale: false,
      cadence: "daily",
    });
    expect(v.verdict(it_("GET /quick"), "dev", cov.LATEST)).toMatchObject({
      state: "verified",
      asOf: at(0),
      stale: false,
    });
  });

  it("says a stale cadence proof is old by that cadence's gap", () => {
    expect(
      asOfText(
        {
          state: "verified",
          label: "",
          laterFailed: [],
          asOf: at(-60),
          stale: true,
          cadence: "daily",
          gap: 24 * HOUR,
        },
        "dev",
        HOUR,
      ),
    ).toMatch(/usually runs its daily scenarios every day\.$/);
    expect(
      asOfText(
        {
          state: "verified",
          label: "",
          laterFailed: [],
          asOf: at(-6),
          stale: true,
        },
        "dev",
        HOUR,
      ),
    ).toMatch(/usually runs every hour\.$/);
  });

  it("shows the newest ordinary run on the Now door with the cadence run's failures beside its own", () => {
    const pers = personasModel(
      cov,
      personaDefsModel({
        commit: "",
        coverageMapBuiltAt: null,
        personas: [],
        stations: [],
        journeys: [],
        orphans: [],
        broken: [],
        deadMatchers: [],
      }),
    );
    const now = nowModel(cov, scen, { featureOf: () => undefined }, pers);
    const dev = now
      .nowView(cov.LATEST, "all")
      .envs.find((e) => e.env === "dev")!;
    expect(dev.run?.id).toBe("dev-100");
    expect(dev).toMatchObject({ ran: 2, passed: 1, failed: 1 });
    expect(dev.failing.map((f) => f.scenario.id)).toEqual([heavy.id]);
  });
});

describe("unlisted scenarios with cadence runs", () => {
  const detail = (id: string, recs: number[]): ScenarioDetail =>
    ({
      id,
      name: id,
      feature: "Roles",
      tags: [],
      steps: [],
      applies: ["dev"],
      records: {
        dev: recs.map((run) => ({ run, status: "p", durationMs: 1 })),
        staging: [],
        prod: [],
      },
    }) as unknown as ScenarioDetail;

  it("keeps one the newest run of its cadence still ran", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      detail(`features/api/roles.feature:${100 + i}`, [0, 2]),
    );
    const daily = detail("features/api/roles.feature:40", [1]);
    const out = unlistedScenarios(
      [],
      [...many, daily],
      [{ env: "dev" }, { env: "dev", cadence: "daily" }, { env: "dev" }],
    );
    expect(out.get("features/api/roles.feature")).toContain(daily);
  });
});

describe("the results directory and the artifact source", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("prunes each cadence's runs apart from the ordinary ones", () => {
    dir = mkdtempSync(join(tmpdir(), "explorer-cadence-"));
    const put = (id: string, cadence?: string) => {
      mkdirSync(join(dir, "dev", id), { recursive: true });
      writeFileSync(
        join(dir, "dev", id, "run.json"),
        JSON.stringify({
          env: "dev",
          runId: id,
          ...(cadence ? { cadence } : {}),
          scenarios: [],
        }),
      );
    };
    put("dev-01", "daily");
    put("dev-02");
    put("dev-03");
    put("dev-04", "daily");
    put("dev-05");
    put("dev-06");
    put("dev-07", "daily");
    expect(prune(dir, 2).sort()).toEqual([
      "dev/dev-01",
      "dev/dev-02",
      "dev/dev-03",
    ]);
    expect(readdirSync(join(dir, "dev")).sort()).toEqual([
      "dev-04",
      "dev-05",
      "dev-06",
      "dev-07",
    ]);
  });

  it("reads more jobs whose artifacts carry results", () => {
    dir = mkdtempSync(join(tmpdir(), "explorer-cadence-"));
    writeFileSync(
      join(dir, "flax.yml"),
      "org: acme\nenvironments: [dev]\nexplorer:\n  results:\n    repo: acme/checks\n    extraJobs: [checks-daily]\n",
    );
    expect(explorerConfig(dir).results).toEqual({
      repo: "acme/checks",
      workflow: "scenario-checks.yml",
      job: "scenario-checks",
      extraJobs: ["checks-daily"],
    });
    writeFileSync(
      join(dir, "flax.yml"),
      "org: acme\nenvironments: [dev]\nexplorer:\n  results: { repo: checks }\n",
    );
    expect(explorerConfig(dir).results?.extraJobs).toEqual([]);
  });
});
