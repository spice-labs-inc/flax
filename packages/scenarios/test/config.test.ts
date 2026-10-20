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
    live: { hosts: { api: https://api.example }, excludeTags: ["@admin"], fixtures: never }
  surfaces:
    - { name: web, role: ui, linkHost: web }
explorer:
  title: Notes Scenarios
`;

  it("takes the environments from the shared list, in order, with the per-env detail from its own section", () => {
    const c = parseConfig(text, "/ws");
    expect(c.envs.map((e) => [e.name, e.label, e.fixtures])).toEqual([
      ["live", "Live", "never"],
      ["test", "test", "always"],
    ]);
    expect(c.envs[0]?.hosts).toEqual({ api: "https://api.example" });
    expect(c.envs[0]?.excludeTags).toEqual(["@admin"]);
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
