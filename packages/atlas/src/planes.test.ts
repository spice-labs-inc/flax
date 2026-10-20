import assert from "node:assert/strict";
import { test } from "node:test";
import { indexPlanes, planeById, planeIds, setConfig } from "./config.ts";
import { PLANES } from "./atlas/index-tables.ts";
import { planeFor } from "./stages/components.ts";

const FOUR = [
  {
    id: "app",
    label: "App",
    index: true,
    heading: "## App plane",
    map: true,
    anchor: [-900, 0, 0],
  },
  {
    id: "delivery",
    label: "Delivery",
    index: true,
    heading: "## Delivery plane",
    map: true,
  },
  {
    id: "ci-action",
    label: "Actions",
    index: true,
    heading: "## Actions",
    map: false,
  },
  { id: "infra", label: "Environments", map: true },
  { id: "external", label: "Third party", map: true },
];

test("one plane list serves the INDEX, the map and the lookups", () => {
  setConfig({ planes: FOUR });
  assert.deepEqual(planeIds(), [
    "app",
    "delivery",
    "ci-action",
    "infra",
    "external",
  ]);
  assert.deepEqual(
    indexPlanes().map((p) => p.id),
    ["app", "delivery", "ci-action"],
  );
  assert.deepEqual(PLANES(), [
    { id: "app", heading: "## App plane" },
    { id: "delivery", heading: "## Delivery plane" },
    { id: "ci-action", heading: "## Actions" },
  ]);
  assert.equal(planeById("infra")?.label, "Environments");
  assert.equal(planeById("nowhere"), undefined);
});

test("the map assigns planes by repo list, then by type, then by infra language, then the fallback", () => {
  setConfig({
    planes: FOUR,
    map: {
      planeRules: {
        byRepo: { app: ["notes-api"] },
        byType: { "gh-action": "ci-action", docs: "delivery" },
        fallback: "external",
      },
    },
  });
  const doc = (name: string, type: string, language: string) => ({
    name,
    fm: { type, language },
  });
  assert.equal(planeFor(doc("notes-api", "service", "Go")), "app");
  assert.equal(
    planeFor(doc("action-build", "gh-action", "TypeScript")),
    "ci-action",
  );
  assert.equal(planeFor(doc("terraform-bits", "infra", "HCL")), "delivery");
  assert.equal(planeFor(doc("cluster-tools", "infra", "Go")), "infra");
  assert.equal(planeFor(doc("something", "service", "Rust")), "external");
});
