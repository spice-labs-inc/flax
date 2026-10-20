import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  budgetCheck,
  budgetProblems,
  monthlyBudgetUsdCap,
} from "../src/check/budget.ts";
import { anotherReviewProblem } from "../src/run-job/budget.ts";
import { jobFiles, makeRepo, run } from "./helpers.ts";

function limits(usd: number) {
  return { limits: { turns: 1, tokens_per_run: 1, usd_per_month: usd } };
}

describe("monthly budget", () => {
  it("accepts jobs that add up to exactly the cap", async () => {
    const root = makeRepo({
      jobs: { aa: jobFiles("aa", limits(100)), bb: jobFiles("bb", limits(50)) },
    });
    expect(await run(budgetCheck, root)).toEqual([]);
  });

  it("rejects jobs that add up to more than the cap", async () => {
    const root = makeRepo({
      jobs: { aa: jobFiles("aa", limits(100)), bb: jobFiles("bb", limits(76)) },
    });
    expect(await run(budgetCheck, root)).toEqual([
      "jobs/*/job.yml: limits.usd_per_month: jobs add up to $176 a month, over the $175 cap (largest: aa $100, bb $76)",
    ]);
  });

  it("fails exactly when the sum is over the cap", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 175 }), { maxLength: 40 }),
        (amounts) => {
          const jobs = amounts.map((usd, i) => ({ name: `job-${i}`, usd }));
          const total = amounts.reduce((a, b) => a + b, 0);
          const problems = budgetProblems(jobs);
          expect(problems).toHaveLength(total > monthlyBudgetUsdCap() ? 1 : 0);
          if (problems[0])
            expect(problems[0].message).toContain(`$${total} a month`);
        },
      ),
    );
  });
});

describe("another second check", () => {
  it("runs while the run's key has at least as much left as the run has spent", () => {
    expect(anotherReviewProblem(0.0507, 0.3)).toBeUndefined();
    expect(anotherReviewProblem(0.15, 0.3)).toBeUndefined();
    expect(anotherReviewProblem(0.1501, 0.3)).toBe(
      "the run has spent $0.1501 of its $0.30, too little for another second check",
    );
  });
});
