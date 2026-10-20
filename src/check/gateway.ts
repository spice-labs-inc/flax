import { jobFile } from "../lib/paths.ts";
import { problem, type Problem } from "../lib/problem.ts";
import { usesModel } from "../lib/job.ts";
import { validJobs } from "../lib/repo.ts";
import { worstCaseUsd } from "../run-job/budget.ts";
import { keyMinutes } from "../run-job/gateway.ts";
import type { Check } from "./types.ts";

/**
 * gateway.yml is well formed, its CA root is a valid CA certificate and
 * every job's run key fits under the gateway's key ceiling.
 */
export const gatewayCheck: Check = {
  id: "gateway",
  title: "gateway.yml is valid and pins a CA root every job fits under",
  run(repo) {
    const problems: Problem[] = [...repo.gatewayProblems];
    const gateway = repo.gateway;
    if (gateway === undefined) return problems;
    for (const { name, config } of validJobs(repo)) {
      if (!usesModel(config)) continue;
      const model = repo.allowlists.models.find((m) => m.id === config.model);
      if (model === undefined) continue;
      const file = jobFile(name, "job.yml");
      const usd = worstCaseUsd(config, model);
      if (usd > gateway.key_max_usd)
        problems.push(
          problem(
            file,
            `a run's worst case at ${model.id} is $${usd.toFixed(2)}, over the gateway's $${gateway.key_max_usd} ceiling for one key (key_max_usd in gateway.yml)`,
            "limits.tokens_per_run",
          ),
        );
      const minutes = keyMinutes(config);
      if (minutes > gateway.key_max_minutes)
        problems.push(
          problem(
            file,
            `a run key would need ${minutes} minutes, over the gateway's ${gateway.key_max_minutes}-minute ceiling (key_max_minutes in gateway.yml)`,
            "limits.turns",
          ),
        );
    }
    return problems;
  },
};
