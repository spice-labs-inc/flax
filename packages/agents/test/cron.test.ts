import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CRON_FIELDS, cronProblem, isValidCron } from "../src/lib/cron.ts";

describe("cron", () => {
  it.each([
    "0 13 * * *",
    "*/15 * * * *",
    "0 9-17/2 * * MON-FRI",
    "30 4 1,15 JAN,jul *",
    "0 0 31 12 6",
  ])("accepts %s", (expr) => {
    expect(cronProblem(expr)).toBeUndefined();
  });

  it.each([
    ["60 * * * *", "minute 60 is out of range 0-59"],
    ["* * 0 * *", "day of month 0 is out of range 1-31"],
    ["* * * 13 *", "month 13 is out of range 1-12"],
    ["* * * * 7", "day of week 7 is out of range 0-6"],
    ["* * * * FUN", 'day of week "FUN" is not a number or name'],
    ["5-1 * * * *", "minute range 5-1 runs backwards"],
    ["*/0 * * * *", "minute step 0 must be between 1 and 59"],
    ["* * * *", "has 4 fields; cron needs exactly 5"],
    ["? * * * *", 'minute "?" is not a value, range, list or step'],
  ])("rejects %s", (expr, reason) => {
    expect(cronProblem(expr)).toBe(reason);
  });

  const inRange = (i: number) =>
    fc.integer({ min: CRON_FIELDS[i]!.min, max: CRON_FIELDS[i]!.max });
  const item = (i: number) =>
    fc.oneof(
      fc.constant("*"),
      inRange(i).map(String),
      fc
        .tuple(inRange(i), inRange(i))
        .map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`),
      fc.integer({ min: 1, max: CRON_FIELDS[i]!.max }).map((s) => `*/${s}`),
    );
  const field = (i: number) =>
    fc.array(item(i), { minLength: 1, maxLength: 3 }).map((xs) => xs.join(","));

  it("accepts every expression built from in-range fields", () => {
    fc.assert(
      fc.property(
        fc.tuple(field(0), field(1), field(2), field(3), field(4)),
        (parts) => isValidCron(parts.join(" ")),
      ),
    );
  });

  it("rejects any expression with one value out of range", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 1, max: 1000 }),
        (index, excess) => {
          const parts = ["*", "*", "*", "*", "*"];
          parts[index] = String(CRON_FIELDS[index]!.max + excess);
          return !isValidCron(parts.join(" "));
        },
      ),
    );
  });
});
