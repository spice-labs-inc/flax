import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { featuresCatalog } from "../scripts/features.ts";
import {
  unlistedScenarios,
  type FeatureScenario,
} from "../src/lib/features.ts";
import {
  outlineName,
  rowLabel,
  scenarioBlocks,
} from "../src/lib/features/catalog.ts";
import type {
  FeatureEntry,
  ScenarioDetail,
  ScenarioRecord,
} from "../src/lib/scenarios.ts";

const root = fileURLToPath(new URL("./fixtures/workspace/", import.meta.url));

describe("featuresCatalog", () => {
  const catalog = featuresCatalog(root);

  it("lists a Scenario Outline once per Examples row, keyed by the row's line as runs key it", () => {
    const f = catalog.find(
      (e) => e.id === "features/api/member-limits.feature",
    );
    const rows = f?.scenarios.filter((s) => s.example?.outline === 9) ?? [];
    expect(rows.map((s) => s.id)).toEqual(
      Array.from(
        { length: 11 },
        (_, i) => `features/api/member-limits.feature:${19 + i}`,
      ),
    );
    expect(rows[0]?.example?.cells).toEqual([
      "rename the organization",
      "org:manage_org",
    ]);
    expect(f?.scenarios.some((s) => s.id.endsWith(":9"))).toBe(false);
  });

  it("fills an outline's placeholders in each row's name, as the runs name it", () => {
    const f = catalog.find((e) => e.id === "features/api/roles.feature");
    const row = f?.scenarios.find((s) => s.example?.name.includes("<attempt>"));
    expect(row?.name).toBe("A Access Pass cannot create a role");
  });
});

const detail = (id: string, runs: number[]): ScenarioDetail => ({
  id,
  name: id,
  feature: "Roles",
  tags: [],
  description: "",
  steps: [],
  applies: ["dev"],
  records: {
    dev: runs.map((run): ScenarioRecord => ({
      run,
      status: "p",
      ms: 1,
      codes: "",
      stepMs: [],
    })),
    staging: [],
    prod: [],
  },
});

describe("unlistedScenarios", () => {
  const entry: FeatureEntry = {
    id: "features/api/roles.feature",
    name: "Roles",
    description: "",
    tags: [],
    surface: "api",
    area: "roles",
    scenarios: [
      {
        id: "features/api/roles.feature:5",
        name: "a",
        description: "",
        tags: [],
      },
    ],
  };
  const runs = [{ env: "dev" as const }, { env: "dev" as const }];

  it("keeps a scenario the catalog does not know while the newest full run ran it", () => {
    const listed = detail("features/api/roles.feature:5", [0, 1]);
    const fresh = detail("features/api/roles.feature:40", [1]);
    const gone = detail("features/api/roles.feature:7", [0]);
    const out = unlistedScenarios([entry], [listed, fresh, gone], runs);
    expect([...out.entries()]).toEqual([
      ["features/api/roles.feature", [fresh]],
    ]);
  });

  it("judges by the newest full run, not by a small run after it", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      detail(`features/api/roles.feature:${100 + i}`, [0]),
    );
    const listed = detail("features/api/roles.feature:5", [0, 1]);
    const out = unlistedScenarios([entry], [listed, ...many], runs);
    expect(out.get("features/api/roles.feature")).toHaveLength(10);
  });
});

describe("scenarioBlocks", () => {
  const one = (id: string, outline?: number): FeatureScenario => ({
    id,
    name: "A Access Pass cannot <attempt>",
    description: "",
    tags: [],
    planned: false,
    local: false,
    ...(outline
      ? {
          example: {
            outline,
            name: "A Access Pass cannot <attempt>",
            cells: [`row ${id}`],
          },
        }
      : {}),
  });

  it("puts each outline's rows under it, in file order", () => {
    const blocks = scenarioBlocks([
      one("a"),
      one("b", 9),
      one("c", 9),
      one("d", 20),
    ]);
    expect(
      blocks.map((b) => (b.kind === "one" ? b.kind : b.rows.length)),
    ).toEqual(["one", 2, 1]);
    expect(blocks[1]).toMatchObject({
      kind: "outline",
      line: 9,
      name: "A Access Pass cannot …",
    });
  });

  it("labels a row by its cells", () => {
    expect(rowLabel(one("b", 9))).toBe("row b");
    expect(outlineName("<client> on <platform>")).toBe("… on …");
  });
});
