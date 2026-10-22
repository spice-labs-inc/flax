import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";

describe("the scenarios configuration from flax.yml", () => {
  const text = `
org: notes-co
github: notes-co
environments:
  - { id: live, label: Live }
  - test
scenarios:
  envs:
    live: { hosts: { api: https://api.example }, excludeTags: ["@admin"], allowTags: ["@admin:live"], fixtures: never }
  surfaces:
    - { name: web, role: ui, linkHost: web }
explorer:
  title: Notes Scenarios
  glossary:
    - { term: Notebook, text: A customer's collection of notes, section: Product }
    - { term: Pin, text: A note kept at the top of its notebook. }
    - { term: Nowhere, text: Skipped, section: Not a heading }
    - { text: No term }
`;

  it("takes the environments from the shared list, in order, with the per-env detail from its own section", () => {
    const c = parseConfig(text, "/ws");
    expect(c.envs.map((e) => [e.name, e.label, e.fixtures])).toEqual([
      ["live", "Live", "never"],
      ["test", "test", "always"],
    ]);
    expect(c.envs[0]?.hosts).toEqual({ api: "https://api.example" });
    expect(c.envs[0]?.excludeTags).toEqual(["@admin"]);
    expect(c.envs[0]?.allowTags).toEqual(["@admin:live"]);
    expect(c.envs[1]?.allowTags).toEqual([]);
  });

  it("reads the project's glossary entries from the explorer section, in order, each with a term and a text", () => {
    const c = parseConfig(text, "/ws");
    expect(c.glossary).toEqual([
      {
        term: "Notebook",
        text: "A customer's collection of notes",
        section: "Product",
      },
      { term: "Pin", text: "A note kept at the top of its notebook." },
      { term: "Nowhere", text: "Skipped", section: "Not a heading" },
    ]);
  });

  it("keeps the usage view off unless the explorer section turns it on, with the reference environment and plain labels by default", () => {
    expect(parseConfig(text, "/ws").usage).toBeNull();
    const on = (usage: string) =>
      parseConfig(`${text}  usage: ${usage}\n`, "/ws").usage;
    expect(on("true")).toEqual({
      env: "live",
      labels: {
        outside: "from outside",
        internal: "our team",
        runs: "our runs",
      },
      org: { one: "organization", many: "organizations" },
      requestSurfaces: [],
    });
    expect(
      on(
        "{ env: test, labels: { internal: staff }, org: { one: team }, requestSurfaces: [cli], history: usage.json }",
      ),
    ).toEqual({
      env: "test",
      labels: { outside: "from outside", internal: "staff", runs: "our runs" },
      org: { one: "team", many: "teams" },
      requestSurfaces: ["cli"],
      history: "usage.json",
    });
    expect(() => on("{ env: prod }")).toThrow(/explorer.usage.env names prod/);
    expect(() => on("[live]")).toThrow(/true or a mapping/);
  });

  it("fills the defaults from the shared keys and the explorer section", () => {
    const c = parseConfig(text, "/ws");
    expect(c.org).toBe("notes-co");
    expect(c.repo).toEqual({
      owner: "notes-co",
      workspace: "notes-co/notes-co-scenarios",
    });
    expect(c.http.userAgent).toBe("notes-co-scenarios");
    expect(c.branding.title).toBe("Notes Scenarios");
    expect(c.cucumber).toEqual({
      imports: ["support/**/*.ts", "steps/**/*.ts"],
      features: "features",
      stripTypes: true,
      loaders: [],
    });
    expect(c.surfaces[0]).toMatchObject({
      name: "web",
      title: "web",
      role: "ui",
      linkHost: "web",
      envs: [],
    });
  });

  it("refuses a workspace that names no surface", () => {
    expect(() => parseConfig("org: x\nenvironments: [a]\n", "/ws")).toThrow(
      /surfaces/,
    );
  });
});

describe("cadences in flax.yml", () => {
  const ws = (cadences: string) => `
org: notes-co
environments: [live, test]
scenarios:
  cadences:
${cadences}
  surfaces:
    - { name: web }
`;

  it("reads each cadence with its tag, @<name> by default, and its envs, every env by default", () => {
    expect(
      parseConfig(ws(`    daily:\n    weekly: { tag: "@slow", envs: [test] }`))
        .cadences,
    ).toEqual([
      { name: "daily", tag: "@daily", envs: [] },
      { name: "weekly", tag: "@slow", envs: ["test"] },
    ]);
    expect(
      parseConfig(
        "org: x\nenvironments: [a]\nscenarios:\n  surfaces: [{ name: web }]\n",
      ).cadences,
    ).toEqual([]);
  });

  it("refuses two cadences with one tag", () => {
    expect(() =>
      parseConfig(
        ws(`    daily: { tag: "@heavy" }\n    weekly: { tag: "@heavy" }`),
      ),
    ).toThrow(
      "flax.yml: scenarios.cadences daily and weekly both use the tag @heavy",
    );
  });

  it("refuses a tag the runner already uses, a tag without @, and an env the workspace does not list", () => {
    expect(() => parseConfig(ws(`    daily: { tag: "@fixture" }`))).toThrow(
      "scenarios.cadences.daily.tag @fixture already means something to the runner",
    );
    expect(() => parseConfig(ws(`    daily: { tag: "@env:live" }`))).toThrow(
      /already means something/,
    );
    expect(() => parseConfig(ws(`    daily: { tag: daily }`))).toThrow(
      "scenarios.cadences.daily.tag must be one tag starting with @",
    );
    expect(() => parseConfig(ws(`    daily: { envs: [stage] }`))).toThrow(
      "scenarios.cadences.daily.envs names stage, which environments does not list",
    );
    expect(() => parseConfig(ws(`    - daily`))).toThrow(
      "scenarios.cadences must map each cadence name to its settings",
    );
  });
});
