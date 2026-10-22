import { monthlyBudgetUsd } from "../lib/job.ts";
import { workspace } from "../lib/workspace.ts";
import { JOBS_DIR } from "../lib/paths.ts";
import { problem, type Problem } from "../lib/problem.ts";
import { validJobs } from "../lib/repo.ts";
import type { Check } from "./types.ts";

export function monthlyBudgetUsdCap(): number {
  return workspace().budgetUsdPerMonth;
}

export function budgetProblems(
  jobs: readonly { name: string; usd: number }[],
): Problem[] {
  const total = jobs.reduce((sum, j) => sum + j.usd, 0);
  if (total <= monthlyBudgetUsdCap()) return [];
  const biggest = [...jobs]
    .sort((a, b) => b.usd - a.usd || (a.name < b.name ? -1 : 1))
    .slice(0, 5)
    .map((j) => `${j.name} $${j.usd}`)
    .join(", ");
  return [
    problem(
      `${JOBS_DIR}/*/job.yml`,
      `jobs add up to $${total} a month, over the $${monthlyBudgetUsdCap()} cap (largest: ${biggest})`,
      "limits.usd_per_month",
    ),
  ];
}

/** The sum of every job's monthly budget (limits.usd_per_month, or media.model.usd_per_month for a job with model: none) stays within the shared monthly cap. */
export const budgetCheck: Check = {
  id: "budget",
  title: `monthly budgets add up to at most $${monthlyBudgetUsdCap()}`,
  run: (repo) =>
    budgetProblems(
      validJobs(repo).map(({ name, config }) => ({
        name,
        usd: monthlyBudgetUsd(config),
      })),
    ),
};
