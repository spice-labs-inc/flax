import { describe, expect, it } from "vitest";
import {
  ago,
  buildText,
  sentence,
  statement,
  whenPhrase,
} from "../src/lib/now/copy.ts";
import type { EnvNow, Failing } from "../src/lib/now.ts";
import type { RunInfo, ScenarioDetail } from "../src/lib/scenarios.ts";

const ref = Date.parse("2026-10-13T23:50:00Z");

const run = (finishedAt: string): RunInfo => ({
  env: "prod",
  id: `prod-${finishedAt}`,
  startedAt: finishedAt,
  finishedAt,
  versions: [
    {
      service: "api",
      release: "ae8d1f0739541d9b",
      builtAt: "2026-10-13T18:37:21.032Z",
    },
  ],
});

const scenario = {
  id: "x",
  name: "A customer reads a report",
} as ScenarioDetail;

const failing = (
  since: string,
  runsFailing: number,
  lastPassAt?: string,
): Failing => ({
  env: "prod",
  scenario,
  at: since,
  versions: [],
  since,
  runsFailing,
  ...(lastPassAt ? { lastPassAt } : {}),
  step: "When they open it",
  failedAt: 0,
  message: "boom",
  more: "",
  kind: { kind: "once", text: "" },
  blocks: { items: [], atStep: false, stations: [], personas: [] },
});

const envNow = (over: Partial<EnvNow>): EnvNow => ({
  env: "prod",
  ran: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  other: 0,
  failing: [],
  unreachable: [],
  fixed: [],
  broke: [],
  notChecked: {
    total: 0,
    elsewhere: 0,
    fixture: 0,
    internalAdmin: 0,
    partial: 0,
    skipped: 0,
  },
  ageHours: 0,
  ...over,
});

describe("statement", () => {
  it("says an env has no run", () => {
    expect(statement(envNow({}), ref)).toBe("Prod has no run at this point.");
  });

  it("says everything was verified, with the time of day when today", () => {
    const e = envNow({
      run: run("2026-10-13T23:28:19Z"),
      ran: 57,
      passed: 45,
      other: 12,
    });
    expect(statement(e, ref)).toBe(
      "All 45 scenarios verified on Prod at 4:28 PM PDT.",
    );
  });

  it("names the day when the run was not today", () => {
    const e = envNow({
      run: run("2026-10-11T05:34:06Z"),
      ran: 57,
      passed: 45,
      other: 12,
    });
    expect(statement(e, ref)).toBe(
      "All 45 scenarios verified on Prod at 10:34 PM PDT on Oct 10.",
    );
  });

  it("counts failures and dates the oldest, newest first in the list", () => {
    const e = envNow({
      run: run("2026-10-13T23:28:19Z"),
      ran: 225,
      passed: 222,
      failed: 3,
      failing: [
        failing("2026-10-13T23:28:19Z", 1),
        failing("2026-10-13T20:00:00Z", 2),
        failing("2026-10-12T21:49:00Z", 5),
      ],
    });
    expect(statement(e, ref)).toBe(
      "3 of 225 scenarios failing on Prod, the oldest since Oct 12, 2:49 PM PDT.",
    );
  });

  it("says since for one failure", () => {
    const e = envNow({
      run: run("2026-10-13T23:28:19Z"),
      ran: 225,
      passed: 224,
      failed: 1,
      failing: [failing("2026-10-13T20:00:00Z", 2)],
    });
    expect(statement(e, ref)).toBe(
      "1 of 225 scenarios failing on Prod, since Oct 13, 1:00 PM PDT.",
    );
  });
});

describe("whenPhrase and ago", () => {
  it("rounds to minutes, hours and days", () => {
    expect(ago("2026-10-13T23:49:50Z", ref)).toBe("just now");
    expect(ago("2026-10-13T23:32:00Z", ref)).toBe("18 minutes ago");
    expect(ago("2026-10-13T22:40:00Z", ref)).toBe("1 hour ago");
    expect(ago("2026-10-13T20:50:00Z", ref)).toBe("3 hours ago");
    expect(ago("2026-10-10T23:50:00Z", ref)).toBe("3 days ago");
  });

  it("drops the day only on the same California day", () => {
    expect(whenPhrase("2026-10-13T07:05:00Z", ref)).toBe("at 12:05 AM PDT");
    expect(whenPhrase("2026-10-13T06:55:00Z", ref)).toBe(
      "at 11:55 PM PDT on Oct 12",
    );
  });
});

describe("sentence and buildText", () => {
  it("ends a scenario name with a period once", () => {
    expect(sentence("A customer reads a report")).toBe(
      "A customer reads a report.",
    );
    expect(sentence("Does it work?")).toBe("Does it work?");
  });

  it("names the service, a short release and its build time", () => {
    expect(buildText(run("2026-10-13T23:28:19Z").versions)).toBe(
      "api ae8d1f0, built Oct 13, 11:37 AM PDT",
    );
    expect(
      buildText([
        { service: "cli" },
        { service: "api", release: "abcdef0123" },
      ]),
    ).toBe("cli; api abcdef0");
  });
});
