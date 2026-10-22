import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import {
  cadenceProblem,
  envsForTags,
  leftOutBy,
  tagExpression,
} from "../src/run/tags.ts";

const workspace = (cadences = "") => `
org: notes-co
environments: [live, test, dev]
scenarios:
  envs:
    live: { excludeTags: ["@admin"], fixtures: never }
${cadences}
  surfaces:
    - { name: web }
`;

const plain = parseConfig(workspace());
const withCadences = parseConfig(
  workspace(`  cadences:
    daily: { envs: [test, dev] }
    weekly: { tag: "@slow" }`),
);
const ENV_TAGS =
  "((not @env:live and not @env:test and not @env:dev) or @env:test)";

describe("the tag expression", () => {
  it("is unchanged by cadences when the workspace configures none", () => {
    expect(
      tagExpression("live", undefined, false, false, undefined, plain),
    ).toBe(
      "not @planned and not @local and ((not @env:live and not @env:test and not @env:dev) or @env:live) and not @admin and not @fixture and not @dispatch",
    );
    expect(tagExpression("test", "@smoke", true, true, undefined, plain)).toBe(
      `not @planned and not @local and ${ENV_TAGS} and (@smoke)`,
    );
  });

  it("leaves every cadence's scenarios out of an ordinary run", () => {
    expect(
      tagExpression("test", undefined, false, false, undefined, withCadences),
    ).toBe(
      `not @planned and not @local and ${ENV_TAGS} and not @daily and not @slow and not @fixture and not @dispatch`,
    );
  });

  it("takes only the cadence's scenarios in a run for it, still under the env policy", () => {
    expect(
      tagExpression("test", "@web", false, false, "daily", withCadences),
    ).toBe(
      `not @planned and not @local and ${ENV_TAGS} and @daily and not @fixture and not @dispatch and (@web)`,
    );
    expect(
      tagExpression("live", undefined, false, false, "weekly", withCadences),
    ).toBe(
      "not @planned and not @local and ((not @env:live and not @env:test and not @env:dev) or @env:live) and not @admin and @slow and not @fixture and not @dispatch",
    );
  });

  it("refuses a cadence flax.yml does not name, and an env the cadence does not run in", () => {
    expect(() =>
      tagExpression("test", undefined, false, false, "hourly", withCadences),
    ).toThrow("unknown cadence hourly: flax.yml names daily, weekly");
    expect(cadenceProblem("hourly", "test", plain)).toBe(
      "--cadence: unknown cadence hourly: flax.yml names no cadences (scenarios.cadences)",
    );
    expect(cadenceProblem("daily", "live", withCadences)).toBe(
      "--cadence daily runs only on test, dev",
    );
    expect(cadenceProblem("daily", "test", withCadences)).toBeUndefined();
    expect(cadenceProblem("weekly", "live", withCadences)).toBeUndefined();
  });
});

describe("a cadence scenario left out of ordinary runs", () => {
  const always = () => true;

  it("is left for its cadence where that cadence runs, and pinned to those envs elsewhere", () => {
    expect(leftOutBy(["@daily"], "test", true, withCadences)).toEqual({
      kind: "cadence",
      cadence: "daily",
    });
    expect(leftOutBy(["@daily"], "live", true, withCadences)).toEqual({
      kind: "pinned",
      envs: ["test", "dev"],
    });
    expect(leftOutBy(["@slow"], "live", true, withCadences)).toEqual({
      kind: "cadence",
      cadence: "weekly",
    });
    expect(leftOutBy(["@daily"], "test", true, plain)).toBeUndefined();
  });

  it("gives the env policy's reasons first", () => {
    expect(leftOutBy(["@slow", "@admin"], "live", true, withCadences)).toEqual({
      kind: "excluded",
      tag: "@admin",
    });
    expect(
      leftOutBy(["@slow", "@fixture"], "live", true, withCadences),
    ).toEqual({ kind: "fixture" });
    expect(
      leftOutBy(["@daily", "@env:live"], "dev", true, withCadences),
    ).toEqual({ kind: "pinned", envs: ["live"] });
  });

  it("still runs in the envs its cadence runs in", () => {
    expect(envsForTags(["@daily"], always, withCadences)).toEqual([
      "test",
      "dev",
    ]);
    expect(envsForTags(["@slow"], always, withCadences)).toEqual([
      "live",
      "test",
      "dev",
    ]);
    expect(envsForTags(["@daily", "@slow"], always, withCadences)).toEqual([
      "live",
      "test",
      "dev",
    ]);
    expect(envsForTags(["@slow", "@admin"], always, withCadences)).toEqual([
      "test",
      "dev",
    ]);
  });
});
