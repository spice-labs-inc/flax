import type { Envelope } from "@cucumber/messages";
import { envsForTags } from "@flax/scenarios/run/tags";
import { describe, expect, it } from "vitest";
import {
  attemptsFrom,
  tidyMessage,
  versionsOf,
  withinBudget,
} from "../scripts/scenarios.ts";

const t = (seconds: number) => ({ seconds, nanos: 0 });
const d = (ms: number) => ({
  seconds: Math.floor(ms / 1000),
  nanos: (ms % 1000) * 1e6,
});

/** The messages cucumber writes for one feature with a Background and one scenario run twice, the first attempt retried. */
function stream(lastStepStatus: "PASSED" | "FAILED"): Envelope[] {
  const doc = {
    uri: "features/x/demo.feature",
    feature: {
      name: "Demo",
      children: [
        {
          background: {
            steps: [{ id: "g0", keyword: "Given ", text: "a fixture person" }],
          },
        },
        {
          scenario: {
            id: "sc",
            description: "  Waiting on: nothing.  ",
            steps: [
              { id: "g1", keyword: "When ", text: 'they choose "UTC"' },
              { id: "g2", keyword: "Then ", text: "it is saved" },
            ],
          },
        },
      ],
    },
  };
  const pickle = {
    id: "p",
    uri: "features/x/demo.feature",
    location: { line: 6, column: 3 },
    astNodeIds: ["sc"],
    name: "A person picks UTC",
    tags: [{ name: "@fixture" }],
    steps: [
      { id: "s0", text: "a fixture person", astNodeIds: ["g0"] },
      { id: "s1", text: 'they choose "UTC"', astNodeIds: ["g1"] },
      {
        id: "s2",
        text: "it is saved",
        astNodeIds: ["g2"],
        argument: {
          dataTable: {
            rows: [{ cells: [{ value: "zone" }, { value: "UTC" }] }],
          },
        },
      },
    ],
  };
  const testCase = {
    id: "tc",
    pickleId: "p",
    testSteps: [
      { id: "h0", hookId: "before" },
      { id: "t0", pickleStepId: "s0" },
      { id: "t1", pickleStepId: "s1" },
      { id: "t2", pickleStepId: "s2" },
      { id: "h1", hookId: "after" },
    ],
  };
  const ok = (ms: number) => ({ status: "PASSED", duration: d(ms) });
  const step = (attempt: string, id: string, result: object) => ({
    testStepFinished: {
      testCaseStartedId: attempt,
      testStepId: id,
      testStepResult: result,
    },
  });
  return [
    { gherkinDocument: doc },
    { pickle },
    { testCase },
    { testCaseStarted: { id: "a1", testCaseId: "tc", timestamp: t(100) } },
    step("a1", "t0", { status: "FAILED", duration: d(5), message: "flaky" }),
    {
      testCaseFinished: {
        testCaseStartedId: "a1",
        timestamp: t(101),
        willBeRetried: true,
      },
    },
    { testCaseStarted: { id: "a2", testCaseId: "tc", timestamp: t(200) } },
    step("a2", "h0", ok(10)),
    step("a2", "t0", ok(1500)),
    {
      attachment: {
        testCaseStartedId: "a2",
        testStepId: "t1",
        mediaType: "text/x.cucumber.log+plain",
        contentEncoding: "IDENTITY",
        body: "picked UTC",
      },
    },
    step("a2", "t1", ok(250)),
    step(
      "a2",
      "t2",
      lastStepStatus === "PASSED"
        ? ok(40)
        : {
            status: "FAILED",
            duration: d(60_000),
            message:
              "Error: not saved\n    at x (/opt/runner/_work/a/b/acme-scenarios/src/steps/demo.ts:9:3)",
          },
    ),
    {
      attachment: {
        testCaseStartedId: "a2",
        testStepId: "h1",
        mediaType: "image/png",
        contentEncoding: "BASE64",
        body: "iVBORw0KGgo=",
      },
    },
    step("a2", "h1", ok(5)),
    {
      testCaseFinished: {
        testCaseStartedId: "a2",
        timestamp: t(262),
        willBeRetried: false,
      },
    },
  ] as unknown as Envelope[];
}

describe("attemptsFrom", () => {
  it("reads the final attempt step by step with keywords, Background and arguments", () => {
    const [a, ...rest] = attemptsFrom(stream("PASSED"));
    expect(rest).toEqual([]);
    expect(a).toMatchObject({
      scenarioId: "features/x/demo.feature:6",
      name: "A person picks UTC",
      feature: "Demo",
      tags: ["@fixture"],
      description: "Waiting on: nothing.",
      status: "p",
      durationMs: 62_000,
      codes: "ppp",
      stepMs: [1500, 250, 40],
      logs: { 1: "picked UTC" },
    });
    expect(a!.steps).toEqual([
      { k: "Given", t: "a fixture person", bg: true },
      { k: "When", t: 'they choose "UTC"' },
      { k: "Then", t: "it is saved", table: [["zone", "UTC"]] },
    ]);
    expect(a!.failure).toBeUndefined();
    expect(a!.shot).toBeUndefined();
  });

  it("places a failure on its step and keeps the screenshot of a failed attempt", () => {
    const [a] = attemptsFrom(stream("FAILED"));
    expect(a!.status).toBe("f");
    expect(a!.codes).toBe("ppf");
    expect(a!.failure).toEqual({
      at: 2,
      message: "Error: not saved\n    at x (src/steps/demo.ts:9:3)",
    });
    expect(a!.shot).toEqual({ mediaType: "image/png", base64: "iVBORw0KGgo=" });
  });
});

describe("tidyMessage", () => {
  it("keeps at most 20 lines", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    expect(tidyMessage(long).split("\n")).toHaveLength(20);
  });
});

describe("envsForTags", () => {
  it("follows the runner's tag rules", () => {
    const never = () => false;
    const always = () => true;
    expect(envsForTags([], never)).toEqual(["prod", "staging", "dev"]);
    expect(envsForTags(["@fixture"], never)).toEqual(["staging", "dev"]);
    expect(envsForTags(["@fixture"], always)).toEqual([
      "prod",
      "staging",
      "dev",
    ]);
    expect(envsForTags(["@admin"], always)).toEqual(["staging", "dev"]);
    expect(envsForTags(["@env:dev"], always)).toEqual(["dev"]);
  });
});

describe("versionsOf", () => {
  it("flattens whatever shape each service answered in", () => {
    expect(
      versionsOf({
        api: {
          release: "abc",
          commit: "abc",
          built_at: "2026-10-08T21:46:23Z",
        },
        cli: "1.8.5",
        odd: { nothing: true },
      }),
    ).toEqual([
      { service: "api", release: "abc", builtAt: "2026-10-08T21:46:23Z" },
      { service: "cli", release: "1.8.5" },
      { service: "odd" },
    ]);
  });
});

describe("withinBudget", () => {
  it("keeps the newest screenshots that fit", () => {
    const shot = (key: string, at: string, size: number) => ({
      key,
      at,
      base64: "x".repeat(size),
    });
    const { kept, dropped } = withinBudget(
      [
        shot("old", "2026-10-01", 60),
        shot("new", "2026-10-09", 60),
        shot("mid", "2026-10-05", 30),
      ],
      100,
    );
    expect(kept.map((s) => s.key)).toEqual(["new", "mid"]);
    expect([...dropped]).toEqual(["old"]);
  });
});
