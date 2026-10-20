import { describe, expect, it } from "vitest";
import type { Item } from "../src/lib/data.ts";
import type { Feature, FeatureGroup } from "../src/lib/features.ts";
import {
  capped,
  countOf,
  groupBySurface,
  issueRef,
  neighbors,
  paragraphs,
  plannedNote,
} from "../src/lib/features/catalog.ts";

const feature = (surface: Feature["surface"], stem: string): Feature =>
  ({
    id: `features/${surface}/${stem}.feature`,
    stem,
    surface,
    name: stem,
    description: "",
    area: stem,
    scenarios: [],
    items: [],
    personas: [],
  }) as unknown as Feature;

const a = feature("api", "a");
const b = feature("api", "b");
const c = feature("dashboard", "c");
const groups: FeatureGroup[] = [
  { surface: "dashboard", title: "Dashboard", features: [c] },
  { surface: "api", title: "Public API", features: [a, b] },
];

describe("groupBySurface", () => {
  it("keeps the catalog's surface order and drops empty surfaces", () => {
    expect(groupBySurface(groups, [b]).map((g) => g.surface)).toEqual(["api"]);
    expect(groupBySurface(groups, [b, c]).map((g) => g.features)).toEqual([
      [c],
      [b],
    ]);
  });
});

describe("paragraphs", () => {
  it("joins wrapped lines and splits on blank lines", () => {
    expect(
      paragraphs("A portfolio groups\nsubjects.\n\nThe next survey\nshows."),
    ).toEqual(["A portfolio groups subjects.", "The next survey shows."]);
  });
  it("is empty for an empty description", () => {
    expect(paragraphs("")).toEqual([]);
  });
});

describe("issueRef", () => {
  it("names the issue as its repo does", () => {
    expect(issueRef("bug:dashboard#326")).toBe("dashboard#326");
    expect(issueRef("planned:internal-docs#540")).toBe("internal-docs#540");
  });
});

describe("plannedNote", () => {
  const item = {
    id: "scenario:features/email/welcome.feature:16",
    envs: ["dev", "staging"],
    planned: {
      kind: "scenario",
      scenarioId: "features/email/welcome.feature:16",
      feature: "Welcome emails",
      waitingOn: "Waiting on: a way to complete a Stripe checkout.",
      pIdx: 0,
    },
  } as unknown as Item;

  it("marks the envs the scenario would run in and says what it waits for", () => {
    const n = plannedNote("features/email/welcome.feature:16", [item]);
    expect(n.states).toEqual({
      dev: "planned",
      staging: "planned",
      prod: "never",
    });
    expect(n.label).toBe(
      "Written, waiting for a way to complete a Stripe checkout",
    );
  });

  it("falls back to every env and a plain note when the map has no entry", () => {
    const n = plannedNote("features/x.feature:1", []);
    expect(n.states).toEqual({
      dev: "planned",
      staging: "planned",
      prod: "planned",
    });
    expect(n.label).toBe("Written for a feature not released yet");
  });
});

describe("neighbors", () => {
  it("walks within the surface only", () => {
    expect(neighbors(groups, a)).toEqual({ next: b });
    expect(neighbors(groups, b)).toEqual({ prev: a });
    expect(neighbors(groups, c)).toEqual({});
  });
});

describe("capped", () => {
  it("folds the tail until opened", () => {
    const list = Array.from({ length: 45 }, (_, i) => i);
    expect(capped(list, false)).toEqual({
      shown: list.slice(0, 40),
      hidden: 5,
    });
    expect(capped(list, true)).toEqual({ shown: list, hidden: 0 });
    expect(capped([1, 2], false)).toEqual({ shown: [1, 2], hidden: 0 });
  });
});

describe("countOf", () => {
  it("pluralizes", () => {
    expect(countOf(1, "scenario")).toBe("1 scenario");
    expect(countOf(3, "feature")).toBe("3 features");
  });
});
