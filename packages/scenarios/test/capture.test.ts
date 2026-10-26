import { describe, expect, it } from "vitest";
import type { Envelope } from "@cucumber/messages";
import {
  CAPTURE_MEDIA_TYPE,
  wantedCaptures,
  type CaptureEntry,
} from "../src/capture/capture.ts";
import {
  captureEntries,
  captureManifest,
  type CaptureScenario,
} from "../src/capture/manifest.ts";
import { parseConfig } from "../src/config.ts";
import type { ScenarioResult } from "../src/run/results.ts";

const base =
  "org: x\nenvironments: [{ id: prod }]\nscenarios:\n  surfaces: [{ name: web }]\n";

describe("the capture settings", () => {
  it("default to @capture, 1440 by 900 at scale 2, light, en-US and the machine's time zone", () => {
    expect(parseConfig(base).capture).toEqual({
      tag: "@capture",
      viewport: { width: 1440, height: 900 },
      scale: 2,
      colorScheme: "light",
      locale: "en-US",
      timezone: "",
    });
  });

  it("take each value flax.yml gives, a bad one falling back, and refuse a tag that is not one tag", () => {
    expect(
      parseConfig(
        `${base}  capture:\n    tag: "@docs"\n    viewport: { width: 1280, height: 10 }\n    scale: 9\n    colorScheme: dark\n    locale: de-DE\n    timezone: Europe/Berlin\n`,
      ).capture,
    ).toEqual({
      tag: "@docs",
      viewport: { width: 1280, height: 900 },
      scale: 2,
      colorScheme: "dark",
      locale: "de-DE",
      timezone: "Europe/Berlin",
    });
    expect(() =>
      parseConfig(`${base}  capture:\n    tag: "@docs and @web"\n`),
    ).toThrow("scenarios.capture.tag must be one tag");
  });
});

describe("wantedCaptures", () => {
  it("takes every capture for the tag, only the named ones for <tag>:<name>, and none without either", () => {
    expect(wantedCaptures(["@web", "@capture"], "@capture")).toEqual({
      all: true,
      names: [],
    });
    expect(
      wantedCaptures(["@capture:list", "@capture:form"], "@capture"),
    ).toEqual({ all: false, names: ["list", "form"] });
    expect(wantedCaptures(["@captured", "@web"], "@capture")).toBeUndefined();
  });
});

const entry = (
  name: string,
  feature: string,
  line: number,
  at: string,
): CaptureEntry => ({
  name,
  file: `${name}.png`,
  text: [{ heading: "", lines: [name] }],
  scenario: `scenario at ${line}`,
  feature,
  line,
  step: { index: 2, keyword: "Then", text: "the list shows it" },
  url: "http://127.0.0.1/",
  target: "viewport",
  viewport: { width: 800, height: 600 },
  deviceScaleFactor: 2,
  width: 1600,
  height: 1200,
  capturedAt: at,
});

const result = (
  id: string,
  status: ScenarioResult["status"],
): ScenarioResult => ({
  id,
  name: `scenario at ${id.split(":")[1]}`,
  feature: "Notes",
  tags: [],
  status,
  durationMs: 1,
  touches: [],
});

const scenario = (
  line: number,
  all: boolean,
  names: string[] = [],
): CaptureScenario => ({
  uri: "features/notes.feature",
  line,
  name: `scenario at ${line}`,
  all,
  names,
});

const RUN = {
  env: "local",
  runId: "local-1",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:01:00.000Z",
};
const F = "features/notes.feature";

describe("captureManifest", () => {
  it("reads the entries from the run's attachments", () => {
    const e = entry("list", F, 3, "2026-01-01T00:00:10.000Z");
    const envelopes: Envelope[] = [
      { attachment: { body: "[]", mediaType: "application/json" } },
      {
        attachment: { body: JSON.stringify(e), mediaType: CAPTURE_MEDIA_TYPE },
      },
    ] as Envelope[];
    expect(captureEntries(envelopes)).toEqual([e]);
  });

  it("passes when every selected scenario passed and took what it names, sorted by name with each one's status", () => {
    const m = captureManifest(
      [
        entry("list", F, 3, "2026-01-01T00:00:20.000Z"),
        entry("form", F, 3, "2026-01-01T00:00:10.000Z"),
        entry("heading", F, 9, "2026-01-01T00:00:30.000Z"),
      ],
      [result(`${F}:3`, "passed"), result(`${F}:9`, "passed")],
      [scenario(3, false, ["list", "form"]), scenario(9, true)],
      RUN,
    );
    expect(m.status).toBe("passed");
    expect(m.problems).toEqual([]);
    expect(m.captures.map((c) => [c.name, c.status])).toEqual([
      ["form", "passed"],
      ["heading", "passed"],
      ["list", "passed"],
    ]);
    expect(m).toMatchObject(RUN);
  });

  it("fails on a name taken twice, a named capture never taken, a failed scenario and one that never ran", () => {
    const m = captureManifest(
      [
        entry("list", F, 3, "2026-01-01T00:00:20.000Z"),
        entry("list", F, 9, "2026-01-01T00:00:30.000Z"),
        entry("half", F, 12, "2026-01-01T00:00:40.000Z"),
      ],
      [
        result(`${F}:3`, "passed"),
        result(`${F}:9`, "passed"),
        result(`${F}:12`, "failed"),
      ],
      [
        scenario(3, false, ["list", "form"]),
        scenario(9, true),
        scenario(12, false, ["half", "rest"]),
        scenario(20, true),
      ],
      RUN,
    );
    expect(m.status).toBe("failed");
    expect(m.captures.map((c) => [c.name, c.line, c.status])).toEqual([
      ["half", 12, "failed"],
      ["list", 9, "passed"],
    ]);
    expect(m.problems).toEqual([
      'list was taken by "scenario at 3" and again by "scenario at 9"; the file is the later one; give each its own name, or name the one each scenario takes in a <tag>:<name> tag',
      '"scenario at 3" passed without taking form: no step of it captures that name',
      '"scenario at 12" failed; its captures are marked so and are not to be used',
      '"scenario at 12" stopped before taking rest',
      '"scenario at 20" (features/notes.feature:20) did not run: the tag policy or --tags left it out',
    ]);
  });
});
