import { describe, expect, it } from "vitest";
import { alignHistory } from "../src/lib/model.ts";
import { historyPoints } from "../scripts/data.ts";

const run = (finishedAt: string) => ({ run: { finishedAt } });

describe("historyPoints", () => {
  it("keeps every run of the last week", () => {
    const runs = [
      run("2026-10-08T01:00:00Z"),
      run("2026-10-08T02:00:00Z"),
      run("2026-10-09T01:00:00Z"),
    ];
    expect(historyPoints(runs)).toEqual(runs);
  });

  it("keeps only the last run of each California day before that", () => {
    const runs = [
      run("2026-09-20T16:00:00Z"),
      // Still September 20 in California.
      run("2026-09-21T05:00:00Z"),
      run("2026-09-21T08:00:00Z"),
      run("2026-10-09T01:00:00Z"),
    ];
    expect(historyPoints(runs).map((r) => r.run.finishedAt)).toEqual([
      "2026-09-21T05:00:00Z",
      "2026-09-21T08:00:00Z",
      "2026-10-09T01:00:00Z",
    ]);
  });

  it("has no points without runs", () => {
    expect(historyPoints([])).toEqual([]);
  });
});

describe("alignHistory", () => {
  const base = {
    builtAt: "2026-10-15T00:00:00Z",
    scenariosCommit: null,
    itemCount: 2,
    scenarios: [],
    itemScenarios: {},
    itemSteps: {},
    itemNeeds: {},
    planned: [],
  };
  const snapshot = {
    at: "2026-10-15T00:00:00Z",
    env: "prod",
    runId: "prod-1",
    ran: { scenarios: 1, passed: 1, failed: 0 },
    runs: {},
  };

  it("permutes each snapshot's per-env strings from the file's order into the page's", () => {
    const file = {
      ...base,
      envs: ["dev", "staging", "prod"],
      snapshots: [
        { ...snapshot, status: "123456", scen: "abc", planned: "xyz" },
      ],
    };
    const aligned = alignHistory(file, ["prod", "staging", "dev"]);
    expect(aligned.envs).toEqual(["prod", "staging", "dev"]);
    expect(aligned.snapshots[0]).toMatchObject({
      status: "321654",
      scen: "cba",
      planned: "zyx",
    });
  });

  it("fills an env the file never knew with no-scenario and drops one the page does not show", () => {
    const file = {
      ...base,
      envs: ["dev", "prod"],
      snapshots: [{ ...snapshot, status: "1234", scen: "ab", planned: "" }],
    };
    expect(alignHistory(file, ["prod", "staging"]).snapshots[0]).toMatchObject({
      status: "2040",
      scen: "b0",
    });
  });

  it("leaves a file already in order, or one that names no envs, as it is", () => {
    const file = {
      ...base,
      envs: ["prod"],
      snapshots: [{ ...snapshot, status: "12", scen: "", planned: "" }],
    };
    expect(alignHistory(file, ["prod"])).toBe(file);
  });
});
