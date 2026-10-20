import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  coverageAfter,
  coverageFile,
  historyFile,
  type RunOnDisk,
} from "../scripts/data.ts";
import { envsForTags, leftOutBy } from "@flax/scenarios/run/tags";
import { scenariosFile } from "../scripts/scenarios.ts";
import { coverageModel, type BoardFile, type Item } from "../src/lib/data.ts";
import { scenariosModel } from "../src/lib/scenarios.ts";
import {
  gapWords,
  isStale,
  laterFailedText,
  usualGap,
  verdictLines,
  verdictModel,
  type Verdict,
} from "../src/lib/verdict.ts";
import type { SurfaceFile } from "@flax/scenarios/lib/types";
import type { ScenarioResult } from "@flax/scenarios/run/results";

const root = fileURLToPath(new URL("./fixtures/workspace/", import.meta.url));
const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-15T12:00:00Z");
const at = (h: number) => new Date(T0 + h * HOUR).toISOString();

const item = (id: string, needs?: string[]) => ({
  id: `api:${id}`,
  label: id,
  surface: "api" as const,
  area: "Things",
  envs: ["dev" as const, "staging" as const, "prod" as const],
  seen: [],
  ...(needs ? { details: { coverageNeeds: needs } } : {}),
});

const files: SurfaceFile[] = [
  {
    surface: "api",
    builtAt: at(0),
    sources: [],
    outOfScope: [],
    notes: [],
    items: [
      item("GET /a", ["success", "auth-refusal"]),
      item("GET /b"),
      item("GET /c"),
      item("GET /d"),
      item("GET /e"),
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

// s1 verifies b at its first step, then fails at its third, where it reaches a.
const s1 = scenario(
  "features/api/x.feature:3",
  ["@fixture"],
  "failed",
  [
    { item: "api:GET /b", step: 0 },
    { item: "api:GET /a", step: 2, need: "success" },
  ],
  { step: "Then it answers", message: "boom", at: 2 },
);
const s2 = scenario("features/api/x.feature:9", ["@fixture"], "passed", [
  { item: "api:GET /d", step: 0 },
]);
const s3 = scenario("features/api/y.feature:3", [], "passed", [
  { item: "api:GET /a", step: 0, need: "auth-refusal" },
]);
const s5 = scenario("features/api/z.feature:3", [], "passed", [
  { item: "api:GET /c", step: 0 },
]);

const runs: RunOnDisk[] = [
  run("dev", -4, [s5]),
  run("dev", -3, []),
  run("prod", -2, [s3]),
  run("dev", -2, []),
  run("dev", -1, []),
  run("dev", 0, [s1, s2]),
  run("staging", 0.5, [{ ...s2, status: "skipped", touches: [] }]),
  run("prod", 1, [s3]),
];

const map = coverageAfter(files, runs, at(1));
const coverage = coverageFile(map, files, [], runs);
const history = historyFile(root, files, runs, "c".repeat(40), at(1));
const byId = (id: string) => coverage.items.find((i) => i.id === `api:${id}`)!;

describe("the status codes history.json writes", () => {
  it("tells a later failure and the reasons something is not checked apart", () => {
    // Per item prod, staging, dev: a fails where its step failed, b was verified before s1 failed,
    // c rests on an old pass, d is skipped on staging, e has no scenario.
    expect(history.snapshots.at(-1)!.status).toBe(
      ["652", "554", "553", "573", "000"].join(""),
    );
  });

  it("never calls an item failing when its scenario could not reach the env", () => {
    const blip = scenario(
      "features/api/x.feature:3",
      [],
      "failed",
      [{ item: "api:GET /b", step: 0 }],
      {
        step: "Given a fixture person",
        message:
          "TypeError: fetch failed\nCaused by: Error: getaddrinfo ENOTFOUND api.dev.example.com",
        at: 0,
      },
    );
    const h = historyFile(
      root,
      files,
      [run("dev", 0, [blip])],
      "c".repeat(40),
      at(1),
    );
    expect(h.snapshots.at(-1)!.status.slice(3, 6)).toBe("558");
  });
});

describe("coverage.json", () => {
  it("names the scenario that failed after it verified an item", () => {
    expect(byId("GET /b").laterFailed).toEqual({
      dev: ["features/api/x.feature:3"],
    });
    expect(byId("GET /a").laterFailed).toBeUndefined();
  });

  it("says in a sentence why an item is not checked in an env", () => {
    expect(byId("GET /b").unchecked).toEqual({
      staging: "Its scenario has not run on staging yet.",
      prod: "Its scenario creates a fixture, which Prod runs never do.",
    });
    expect(byId("GET /a").unchecked?.prod).toBe(
      "Scenarios reach it on prod but verify only that it refuses a request without a token, not that it answers a valid request.",
    );
    expect(byId("GET /d").unchecked?.staging).toBe(
      "Its scenario was skipped in every staging run.",
    );
    expect(byId("GET /e").unchecked).toBeUndefined();
  });
});

describe("the runner's tag rules", () => {
  it("leave a scenario out of an env for one reason, and the envs it runs in follow", () => {
    expect(leftOutBy(["@fixture"], "prod", false)).toEqual({ kind: "fixture" });
    expect(leftOutBy(["@fixture"], "prod", true)).toBeUndefined();
    expect(leftOutBy(["@admin"], "prod", true)).toEqual({
      kind: "excluded",
      tag: "@admin",
    });
    expect(leftOutBy(["@env:dev"], "staging", false)).toEqual({
      kind: "pinned",
      envs: ["dev"],
    });
    expect(leftOutBy(["@env:dev"], "dev", false)).toBeUndefined();
    expect(envsForTags(["@fixture"], () => false)).toEqual(["staging", "dev"]);
    expect(envsForTags(["@env:prod", "@admin"], () => false)).toEqual([]);
  });
});

describe("the verdict model", () => {
  const board: BoardFile = {
    readAt: at(1),
    checkedAt: at(1),
    source: "",
    items: [],
    bugs: [],
  };
  const cov = coverageModel(coverage, history, board);
  const scen = scenariosModel(
    cov,
    scenariosFile(root, "/nonexistent", runs, history.scenarios).file,
    {},
  );
  const v = verdictModel(cov, scen);
  const it_ = (id: string): Item =>
    cov.items.find((i) => i.id === `api:${id}`)!;
  const latest = cov.LATEST;

  it("decodes not checked here as one code, with the reason beside it", () => {
    expect(cov.status[latest]![it_("GET /b").idx]).toEqual([-2, -2, 3]);
    expect(cov.cellNote(it_("GET /b"), latest, 2)).toBe("later-failed");
    expect(cov.cellNote(it_("GET /a"), latest, 0)).toBe("partial");
    expect(cov.cellNote(it_("GET /e"), latest, 0)).toBeUndefined();
    const t = cov.tally([it_("GET /b"), it_("GET /e")], latest, "all");
    expect(t).toMatchObject({ pass: 1, unchecked: 2, none: 3, slots: 6 });
  });

  it("reads verified here with the scenario that failed later", () => {
    const b = v.verdict(it_("GET /b"), "dev", latest);
    expect(b.state).toBe("verified");
    expect(b.laterFailed.map((f) => f.scenario.id)).toEqual([
      "features/api/x.feature:3",
    ]);
    expect(laterFailedText(b)).toBe(
      "Verified here; a later step of Scenario features/api/x.feature:3 failed.",
    );
    expect(b.asOf).toBe(at(0));
    expect(b.stale).toBe(false);
  });

  it("gives not checked here its reason and the env's newest run as its time", () => {
    const b = v.verdict(it_("GET /b"), "prod", latest);
    expect(b).toMatchObject({
      state: "unchecked",
      label: "Not checked here",
      reason: "Its scenario creates a fixture, which Prod runs never do.",
      asOf: at(1),
    });
  });

  it("fades proof older than twice the env's usual gap", () => {
    expect(v.runGaps.dev).toBe(HOUR);
    const c = v.verdict(it_("GET /c"), "dev", latest);
    expect(c).toMatchObject({ state: "verified", asOf: at(-4), stale: true });
    expect(v.staleCells(latest)[it_("GET /c").idx * 3 + 2]).toBe(1);
    expect(v.staleCells(latest)[it_("GET /b").idx * 3 + 2]).toBe(0);
  });

  it("calls an env overdue past twice its usual gap", () => {
    expect(v.runGaps.prod).toBe(3 * HOUR);
    expect(v.runAge("prod", latest, Date.parse(at(3)))?.overdue).toBe(false);
    expect(v.runAge("prod", latest, Date.parse(at(8)))).toEqual({
      last: at(1),
      gap: 3 * HOUR,
      overdue: true,
    });
  });
});

describe("verdict helpers", () => {
  it("takes the median gap between runs", () => {
    expect(usualGap([at(0), at(1), at(2), at(10)])).toBe(HOUR);
    expect(usualGap([at(0)])).toBeUndefined();
  });

  it("calls proof stale only past twice the gap", () => {
    expect(isStale(at(0), at(2), HOUR)).toBe(false);
    expect(isStale(at(0), at(2.5), HOUR)).toBe(true);
    expect(isStale(at(0), at(100), undefined)).toBe(false);
  });

  it("says a gap in words", () => {
    expect(gapWords(40 * 60_000)).toBe("40 minutes");
    expect(gapWords(HOUR)).toBe("hour");
    expect(gapWords(2.9 * HOUR)).toBe("3 hours");
    expect(gapWords(26 * HOUR)).toBe("day");
  });

  it("adds the age to a cell's lines when asked, and always when it is old", () => {
    const base: Verdict = {
      state: "verified",
      label: "Verified",
      laterFailed: [],
      asOf: "2026-10-15T16:01:00Z",
      stale: false,
    };
    expect(verdictLines(base, "prod", 3 * HOUR, false)).toEqual([]);
    expect(verdictLines(base, "prod", 3 * HOUR, true)).toEqual([
      "As of Oct 15, 9:01 AM PDT.",
    ]);
    expect(
      verdictLines({ ...base, stale: true }, "prod", 3 * HOUR, false),
    ).toEqual([
      "As of Oct 15, 9:01 AM PDT, which is old: Prod usually runs every 3 hours.",
    ]);
  });
});
