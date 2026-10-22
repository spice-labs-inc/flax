import { describe, expect, it } from "vitest";
import { currentRuns, type RunResult } from "@flax/contract";
import {
  buildCoverage,
  mergeRuns,
  pacific,
  renderGaps,
} from "../src/coverage/map.ts";
import type { SurfaceFile, SurfaceItem } from "../src/lib/types.ts";

const readAt = "2026-10-07T00:00:00.000Z";
const seen = [
  { source: { kind: "url" as const, url: "https://example.test" }, readAt },
];

function item(
  id: string,
  area: string,
  envs: SurfaceItem["envs"],
  surface: SurfaceItem["surface"] = "api",
): SurfaceItem {
  return {
    id,
    label: id.split(":").slice(1).join(":"),
    surface,
    area,
    envs,
    seen,
  };
}

const files: SurfaceFile[] = [
  {
    surface: "api",
    builtAt: readAt,
    sources: seen,
    items: [
      item("api:GET /a", "projects", ["dev", "staging", "prod"]),
      item("api:POST /b", "tokens", ["dev"]),
    ],
    outOfScope: [],
    notes: ["Read from the published reference."],
  },
  {
    surface: "admin",
    builtAt: readAt,
    sources: seen,
    items: [item("admin:route:/orgs", "orgs", ["dev", "staging"], "admin")],
    outOfScope: [
      { label: "license issuing for real orgs", reason: "never exercised" },
    ],
    notes: [],
  },
];

describe("buildCoverage", () => {
  const map = buildCoverage(files, readAt);

  it("marks every item uncovered in exactly the envs it applies to", () => {
    expect(map.items.find((i) => i.id === "api:POST /b")?.status).toEqual({
      dev: "uncovered",
    });
    expect(map.items.find((i) => i.id === "admin:route:/orgs")?.status).toEqual(
      { dev: "uncovered", staging: "uncovered" },
    );
  });

  it("summarizes every surface, including ones with no file", () => {
    expect(map.surfaces).toHaveLength(9);
    const api = map.surfaces.find((s) => s.surface === "api");
    expect(api).toMatchObject({
      items: 2,
      areas: 2,
      perEnv: { dev: 2, staging: 1, prod: 1 },
    });
    expect(map.surfaces.find((s) => s.surface === "email")).toMatchObject({
      items: 0,
      builtAt: null,
    });
  });
});

describe("renderGaps", () => {
  const text = renderGaps(buildCoverage(files, readAt));

  it("lists every gap by name under its surface and area", () => {
    expect(text).toContain("## Public API (2)");
    expect(text).toContain("### tokens (1)");
    expect(text).toContain("- POST /b (dev): `api:POST /b`");
    expect(text).toContain("- route:/orgs (dev, staging): `admin:route:/orgs`");
  });

  it("shows out-of-scope entries and totals", () => {
    expect(text).toContain("- license issuing for real orgs: never exercised");
    expect(text).toContain("| **Total** | 3 | 3 |");
  });
});

describe("renderGaps escaping", () => {
  const text = renderGaps(
    buildCoverage(
      [
        {
          surface: "dashboard",
          builtAt: readAt,
          sources: seen,
          items: [
            {
              ...item("dashboard:testid:a`b", "x", ["prod"], "dashboard"),
              label: "Test id <a> *b*",
            },
            item("dashboard:testid:`edge", "x", ["prod"], "dashboard"),
          ],
          outOfScope: [
            {
              label: "Harness <Picker>",
              reason: "Only in *Harness.svelte, never a <route> | pipe",
            },
          ],
          notes: ["Read <script> blocks and `data-testid` [attrs] with _x_."],
        },
      ],
      readAt,
    ),
  );

  it("escapes notes and out-of-scope labels and reasons like labels", () => {
    expect(text).toContain(
      "- Read \\<script\\> blocks and \\`data-testid\\` \\[attrs\\] with \\_x\\_.",
    );
    expect(text).toContain(
      "- Harness \\<Picker\\>: Only in \\*Harness.svelte, never a \\<route\\> \\| pipe",
    );
    expect(text).toContain("- Test id \\<a\\> \\*b\\* (prod):");
  });

  it("prints ids exactly, with a double-backtick span when an id has a backtick", () => {
    expect(text).toContain(": `` dashboard:testid:a`b ``");
    expect(text).toContain(": `` dashboard:testid:`edge ``");
    expect(text).not.toContain("dashboard:testid:a'b");
  });
});

describe("pacific", () => {
  it("shows California time with the zone named", () => {
    expect(pacific("2026-10-08T00:43:26.061Z")).toBe(
      "Oct 7, 2026, 5:43 PM PDT",
    );
    expect(pacific("2026-12-01T20:00:00.000Z")).toBe(
      "Dec 1, 2026, 12:00 PM PST",
    );
  });
});

describe("runs of one env with a cadence among them", () => {
  const result = (id: string, status: "passed" | "failed") => ({
    id,
    name: id,
    feature: "f",
    tags: [],
    status,
    durationMs: 1,
    touches: [],
  });
  const run = (
    runId: string,
    scenarios: RunResult["scenarios"],
    cadence?: string,
  ): RunResult => ({
    env: "dev",
    runId,
    startedAt: readAt,
    finishedAt: readAt,
    versions: {},
    ...(cadence ? { cadence } : {}),
    scenarios,
  });
  const runs = [
    run("dev-1", [result("quick", "failed")]),
    run("dev-2", [result("heavy", "failed")], "daily"),
    run("dev-3", [result("quick", "passed")]),
    run("dev-4", [result("heavy", "passed")], "daily"),
    run("dev-5", [result("quick", "passed")]),
  ];

  it("speak through the newest ordinary run and the newest run of each cadence", () => {
    expect(currentRuns(runs, (r) => r.cadence).map((r) => r.runId)).toEqual([
      "dev-4",
      "dev-5",
    ]);
    expect(
      currentRuns([...runs, run("dev-6", [], "weekly")], (r) => r.cadence).map(
        (r) => r.runId,
      ),
    ).toEqual(["dev-4", "dev-5", "dev-6"]);
  });

  it("merge into one run that keeps each scenario's newest result and names no cadence", () => {
    const merged = mergeRuns([...runs, run("dev-6", [], "daily")])!;
    expect(merged.runId).toBe("dev-6");
    expect(merged.cadence).toBeUndefined();
    expect(merged.scenarios.map((s) => [s.id, s.status])).toEqual([
      ["heavy", "passed"],
      ["quick", "passed"],
    ]);
  });
});
