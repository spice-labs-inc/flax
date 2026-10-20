import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkspace } from "@flax/core";
import {
  configOf,
  DEFAULTS,
  setConfig,
  validate,
  viewerConfig,
} from "./config.ts";

const SHARED = `org: notes-co
github: notes-co
environments:
  - { id: test, label: Test }
  - live
`;

const PLANES = `  planes:
    - { id: app, label: App, index: true, heading: '## App' }
    - { id: delivery, label: Delivery }
    - { id: infra, label: Infra }
    - { id: external, label: Third party }
`;

const parse = (atlas: string) =>
  configOf(parseWorkspace(`${SHARED}atlas:\n${atlas}`, "/ws"));

test("a minimal atlas section gets the method defaults and the shared keys", () => {
  const c = parse(PLANES);
  assert.equal(c.org.github, "notes-co");
  assert.equal(c.site.title, "notes-co atlas");
  assert.deepEqual(c.docs.sections, DEFAULTS.docs.sections);
  assert.equal(c.docs.budgets.doc, 32 * 1024);
  assert.equal(c.map.resolve.minGraph.nodes, 100);
  assert.equal(c.llm.modelEnv, "ATLAS_WIRING_MODEL");
  assert.equal(c.root, ".");
  assert.equal(c.viz, "viz");
  assert.equal(c.checks.gitopsPaths.enabled, false);
});

test("environment nodes come from the workspace list, in order, with the roles the atlas section gives them", () => {
  const c = parse(
    `${PLANES}  map:\n    environments:\n      live: The customer-facing cluster.\n`,
  );
  assert.deepEqual(c.map.environments, [
    { id: "env:test", label: "Test", role: "" },
    { id: "env:live", label: "live", role: "The customer-facing cluster." },
  ]);
  assert.deepEqual(c.map.resolve.envTokens, ["test", "live"]);
  assert.throws(
    () => parse(`${PLANES}  map:\n    environments:\n      prod: nowhere\n`),
    /prod is not a workspace environment/,
  );
});

test("nested keys merge and arrays replace", () => {
  const c = parse(
    `${PLANES}  docs:\n    budgets:\n      tldr: 400\n    mainOnly: [tldr]\n`,
  );
  assert.equal(c.docs.budgets.tldr, 400);
  assert.equal(c.docs.budgets.doc, 32 * 1024);
  assert.deepEqual(c.docs.mainOnly, ["tldr"]);
});

test("an unknown plane anywhere is refused", () => {
  assert.throws(
    () => parse(`${PLANES}  map:\n    planeFix:\n      x: nowhere\n`),
    /unknown plane nowhere/,
  );
  assert.throws(
    () =>
      parse(
        `${PLANES}  map:\n    views:\n      - { id: v, label: V, hint: h, layers: [network], planes: [pqc] }\n`,
      ),
    /unknown plane pqc/,
  );
  assert.throws(
    () => parse("  planes:\n    - { id: app, label: App }\n"),
    /referenced but not in planes/,
  );
});

test("an index plane needs a heading and tenancy cannot list a shared node as single-tenant", () => {
  const c = parse(PLANES);
  c.planes[1].index = true;
  assert.match(validate(c).join("\n"), /needs a heading/);
  c.planes[1].index = false;
  c.map.tenancy = {
    plane: "app",
    from: "app",
    inNamespace: ["a"],
    perProjectData: [],
    sharedDespite: ["a"],
    customerSide: [],
  };
  assert.match(validate(c).join("\n"), /a is shared/);
});

test("an inventory needs its four keys and the gitops path check needs a repo and prefixes", () => {
  assert.throws(
    () => parse(`${PLANES}  inventories:\n    - { id: jobs, doc: agents }\n`),
    /inventories\[0\]: repo is required/,
  );
  assert.throws(
    () => parse(`${PLANES}  checks:\n    gitopsPaths:\n      enabled: true\n`),
    /map.gitops.repo must name/,
  );
  const c = parse(
    `${PLANES}  map:\n    gitops: { repo: notes-gitops }\n  checks:\n    gitopsPaths:\n      enabled: true\n      prefixes: ['apps/(test|live)']\n`,
  );
  assert.equal(c.checks.gitopsPaths.enabled, true);
  assert.deepEqual(c.checks.gitopsPaths.skipSections, ["recent"]);
});

test("the viewer config carries only map planes with their slug and color", () => {
  const c = setConfig({
    org: { github: "acme" },
    site: { title: "T" },
    planes: [
      { id: "app", label: "App", color: "#fff", map: true },
      { id: "delivery", label: "Delivery", map: false },
      { id: "infra", label: "Infra", slug: "i" },
      { id: "external", label: "X" },
    ],
  });
  const v = viewerConfig(c);
  assert.equal(v.site.title, "T");
  assert.deepEqual(
    v.planes.map((p) => p.id),
    ["app", "infra", "external"],
  );
  assert.deepEqual(
    v.planes.map((p) => p.slug),
    ["app", "i", "external"],
  );
  assert.equal(v.planes[0].color, "#fff");
});
