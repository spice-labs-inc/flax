import { describe, expect, it } from "vitest";
import type { Station } from "../src/lib/personas.ts";
import {
  cellTitle,
  countWord,
  editionName,
  groupByStage,
  hexLabel,
  isHttp,
  plural,
} from "../src/lib/personas/copy.ts";

const station = (key: string, stage: Station["stage"]): Station => ({
  key,
  name: key,
  stage,
  kind: "surface",
  items: [],
  slot: 0,
});

describe("personas door copy", () => {
  it("writes small counts as words and larger ones as digits", () => {
    expect(countWord(11)).toBe("Eleven");
    expect(countWord(0)).toBe("No");
    expect(countWord(42)).toBe("42");
  });

  it("pluralizes", () => {
    expect(plural(1, "station")).toBe("1 station");
    expect(plural(3, "station")).toBe("3 stations");
    expect(plural(2, "feature not built", "features not built")).toBe(
      "2 features not built",
    );
  });

  it("names editions in product words", () => {
    expect(editionName("itpro")).toBe("Product IT Pro");
    expect(editionName("hosted")).toBe("Hosted");
    expect(editionName("unknown")).toBe("unknown");
  });

  it("titles a matrix cell with its stations and their states", () => {
    expect(
      cellTitle("Consumer", "Understand", [
        { station: station("posture", "Understand"), state: "pass" },
        { station: station("trend", "Understand"), state: "partial" },
      ]),
    ).toBe(
      "Understand for Consumer: posture (verified); trend (partly verified)",
    );
    expect(cellTitle("Consumer", "Discover", [])).toBe(
      "Discover for Consumer: no station at this stage",
    );
  });

  it("reads a hex out prod first", () => {
    expect(
      hexLabel("Sign in", { dev: "pass", staging: "fail", prod: "never" }),
    ).toBe(
      "Sign in: Prod never run in this environment, Staging failing, Dev verified",
    );
  });

  it("groups stations under each run of a stage in journey order", () => {
    const groups = groupByStage([
      { station: station("a", "Start") },
      { station: station("b", "Start") },
      { station: station("c", "Understand") },
      { station: station("d", "Prove") },
    ]);
    expect(groups.map((g) => [g.stage, g.start, g.stations.length])).toEqual([
      ["Start", 1, 2],
      ["Understand", 3, 1],
      ["Prove", 4, 1],
    ]);
  });

  it("tells links from plain source names", () => {
    expect(isHttp("https://docs.example.com/docs/product/editions/")).toBe(
      true,
    );
    expect(isHttp("internal planning notes")).toBe(false);
  });
});
