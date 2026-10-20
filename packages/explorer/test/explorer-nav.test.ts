import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { featuresCatalog } from "../scripts/features.ts";
import { featureKey } from "../src/lib/features.ts";
import {
  doorRoute,
  format,
  parse,
  type RouteData,
} from "../src/lib/location.ts";

const m = {
  snapshots: [{ runId: "staging-a" }, { runId: "prod-b" }, { runId: "dev-c" }],
  LATEST: 2,
} satisfies RouteData;

describe("explorer locations", () => {
  it("reads every kind of path the explorer links to and writes it back the same", () => {
    for (const loc of [
      "/map",
      "/map/api",
      "/map/dashboard/Data%20health",
      "/map/item/api:GET%20/api/v1/org/{orgId}",
      "/map/item/api:GET%20/api/v1/version/scenario/features/api/version.feature:7?step=2",
      "/scenarios/features/install/images.feature:7",
      "/map/in/dashboard:route:/app/credentials",
      "/map/in/dashboard:route:/app/credentials/area/Credential%20list",
      "/map/in/dashboard:route:/app/credentials/item/dashboard:testid:create-token",
      "/map/in/websites:docs.example.com/docs/videos/item/websites:docs.example.com/docs/videos/board-ready-posture",
      "/personas",
      "/personas/airgapped/offline",
      "/personas/gaps",
      "/personas/no-persona",
      "/personas/lines",
      "/personas/lines/airgapped",
      "/personas/lines/airgapped/offline",
      "/map?env=prod&at=prod-b&view=orphans",
      "/map?view=orphans",
      "/now",
      "/now?env=staging",
      "/features",
      "/features/api",
      "/features/api/portfolios",
      "/features/cli/local/edition-gates",
      "/features?q=access+pass",
      "/planned",
      "/planned?by=persona",
    ])
      expect(format(parse(loc, m), m)).toBe(loc);
  });

  it("names every feature in the catalog by an address that reads back to it", () => {
    const root = fileURLToPath(
      new URL("./fixtures/workspace/", import.meta.url),
    );
    const catalog = featuresCatalog(root);
    expect(catalog.some((e) => e.id.startsWith("features/cli/local/"))).toBe(
      true,
    );
    for (const e of catalog) {
      const feature = featureKey({
        surface: e.surface,
        stem: e.id.replace(/^features\/[^/]+\//, "").replace(/\.feature$/, ""),
      });
      const r = parse(
        format(
          {
            view: "features",
            feature,
            env: "all",
            snap: 2,
            lens: "all",
          },
          m,
        ),
        m,
      );
      expect(r.feature).toBe(feature);
      expect(`features/${r.feature}.feature`).toBe(e.id);
    }
  });

  it("opens personas on prod and the other doors on every env", () => {
    expect(parse("/personas", m).env).toBe("prod");
    expect(parse("/personas?env=all", m).env).toBe("all");
    expect(parse("/now", m).env).toBe("all");
    expect(format(parse("/personas?env=all", m), m)).toBe("/personas?env=all");
    expect(format(parse("/now?env=prod", m), m)).toBe("/now?env=prod");
    expect(doorRoute(parse("/personas", m), "now").env).toBe("all");
    expect(doorRoute(parse("/now", m), "personas").env).toBe("prod");
    expect(doorRoute(parse("/now?env=staging", m), "personas").env).toBe(
      "staging",
    );
  });

  it("takes the old links that put the path pieces unencoded", () => {
    const r = parse("/scenarios/features/install/images.feature:7", m);
    expect(r.scenario).toBe("features/install/images.feature:7");
    expect(parse("/map/item/api:GET /api/v1/version", m).itemId).toBe(
      "api:GET /api/v1/version",
    );
  });

  it("falls back to the latest point, all envs and all items for anything it does not know", () => {
    const r = parse("/map?env=nowhere&at=gone&view=nothing&staff=include", m);
    expect(r).toMatchObject({ env: "all", snap: 2, lens: "all" });
    expect(format(parse("/map?view=usage&staff=include", m), m)).toBe("/map");
    expect(format(r, m)).toBe("/map");
    expect(parse("/", m).view).toBe("now");
    expect(format(parse("/features?view=usage&by=persona", m), m)).toBe(
      "/features",
    );
  });

  it("keeps a timeline point by its run, so new data moves only the latest", () => {
    expect(parse("/map?at=staging-a", m).snap).toBe(0);
    const more = {
      ...m,
      snapshots: [{ runId: "x" }, ...m.snapshots],
      LATEST: 3,
    };
    expect(parse("/map?at=staging-a", more).snap).toBe(1);
  });
});
