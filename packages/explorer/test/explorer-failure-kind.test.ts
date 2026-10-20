import { describe, expect, it } from "vitest";
import {
  failureKind,
  isUnreachable,
  reachClause,
  stepPlace,
} from "../src/lib/failureKind.ts";
import type { RunInfo, ScenarioRecord } from "../src/lib/scenarios.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-13T16:00:00Z");

/** One staging run per hour, each against the api build its letter names. */
const runsOn = (builds: string): RunInfo[] =>
  [...builds].map((b, i) => ({
    env: "staging",
    id: `staging-${i}`,
    startedAt: new Date(T0 + i * HOUR - 60_000).toISOString(),
    finishedAt: new Date(T0 + i * HOUR).toISOString(),
    versions: [{ service: "api", release: `${b.repeat(7)}0123` }],
  }));

/** Records from a string of results, one per run: p passed, f failed at step 5, d could not reach the env. */
const recordsOf = (results: string): ScenarioRecord[] =>
  [...results].map((c, run) => ({
    run,
    status: c === "p" ? "p" : "f",
    ms: 1000,
    codes: "",
    stepMs: [],
    ...(c === "f"
      ? {
          failure: {
            at: 4,
            message: "locator.waitFor: Timeout 60000ms exceeded.",
          },
        }
      : c === "d"
        ? {
            failure: {
              at: 0,
              message:
                "TypeError: fetch failed\nCaused by: Error: getaddrinfo ENOTFOUND api.dev.example",
            },
          }
        : {}),
  }));

const read = (
  results: string,
  builds = "a".repeat(results.length),
  whole = true,
) => failureKind(recordsOf(results), runsOn(builds), "staging", whole);

describe("failure kinds", () => {
  it("reads a network error as could not reach the env", () => {
    expect(read("pppd")).toEqual({
      kind: "unreachable",
      text: "It could not reach Staging at step 1: the address api.dev.example did not resolve.",
    });
  });

  it("reads failures that come and go as intermittent, with the rate and the step", () => {
    expect(read("ppppfppppfppppf")).toEqual({
      kind: "intermittent",
      text: "It failed 3 of its last 15 runs on Staging, about 1 run in 5, always at step 5.",
    });
  });

  it("leaves runs that could not reach the env out of the rate", () => {
    expect(read("ppppfdddpppppf").text).toBe(
      "It failed 2 of its last 11 runs on Staging, about 1 run in 6, always at step 5.",
    );
  });

  it("reads a lasting failure after a new api build as a build change", () => {
    expect(read("pppfff", "aaabbb")).toEqual({
      kind: "build",
      text: "It was last verified on api build aaaaaaa at Oct 13, 11:00 AM PDT and broke on build bbbbbbb at Oct 13, 12:00 PM PDT, at step 5.",
    });
  });

  it("reads a scenario that never passed and has its whole history here as new", () => {
    expect(read("ff")).toEqual({
      kind: "new",
      text: "It has never been verified on Staging: it failed in both of its runs there since Oct 13, 9:00 AM PDT, at step 5.",
    });
  });

  it("calls a never-passing scenario steady when its first run is older than the records", () => {
    expect(read("ff", "aa", false)).toEqual({
      kind: "steady",
      text: "It has not been verified on Staging in the 2 runs on record, since Oct 13, 9:00 AM PDT; it fails at step 5.",
    });
  });

  it("names the other steps an intermittent failure stopped at", () => {
    const recs = recordsOf("pppfppppf");
    recs[3]!.failure = { at: 2, message: "boom" };
    expect(failureKind(recs, runsOn("a".repeat(9)), "staging", true).text).toBe(
      "It failed 2 of its last 9 runs on Staging, about 1 run in 5, at step 5 this time and at step 3 before.",
    );
  });

  it("reads a first failure with nothing changed as once", () => {
    expect(read("ppppf")).toEqual({
      kind: "once",
      text: "It failed for the first time in its last 5 runs on Staging, at step 5, on api build aaaaaaa, the same build it was last verified on, at Oct 13, 12:00 PM PDT.",
    });
  });

  it("reads a long run of failures on the same build as steady", () => {
    expect(read("ppffff")).toEqual({
      kind: "steady",
      text: "It has failed in each of its last 4 runs on Staging since Oct 13, 11:00 AM PDT, at step 5, on api build aaaaaaa, the same build it was last verified on, at Oct 13, 10:00 AM PDT.",
    });
  });
});

describe("failure kind helpers", () => {
  it("knows network errors from product errors", () => {
    expect(
      isUnreachable("page.goto: net::ERR_NAME_NOT_RESOLVED at https://x"),
    ).toBe(true);
    expect(isUnreachable("TypeError: fetch failed")).toBe(true);
    expect(isUnreachable("Error: creating a project answered HTTP 500")).toBe(
      false,
    );
    expect(isUnreachable("AssertionError: the log has DEBUG lines:")).toBe(
      false,
    );
  });

  it("says what went wrong on the network", () => {
    expect(
      reachClause(
        "page.goto: net::ERR_NAME_NOT_RESOLVED at https://admin.dev.example/app",
      ),
    ).toBe("the address admin.dev.example did not resolve");
    expect(reachClause("connect ECONNREFUSED 10.0.0.1:443")).toBe(
      "the connection was refused",
    );
  });

  it("places a failure in the scenario", () => {
    expect(stepPlace(4)).toBe("at step 5");
    expect(stepPlace(-1)).toBe("while setting up, before the first step");
    expect(stepPlace(-2)).toBe("while cleaning up, after the last step");
  });
});
