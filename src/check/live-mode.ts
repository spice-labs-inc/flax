import { workspace } from "../lib/workspace.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jobFile } from "../lib/paths.ts";
import { problem, type Problem } from "../lib/problem.ts";
import { validJobs } from "../lib/repo.ts";
import type { Check } from "./types.ts";

/** Reviewed shadow runs a job needs before it goes live; runs started by hand count too. */
export const MIN_SHADOW_RUNS = 4;
export function runLink(): RegExp {
  return new RegExp(`https:\/\/github\\.com\/${workspace().repo}\/actions\/runs\/(\\d+)`, "g");
}

export function countShadowRuns(text: string): number {
  return new Set([...text.matchAll(runLink())].map((m) => m[1])).size;
}

/** A job may only go live after enough recorded shadow runs. */
export const liveModeCheck: Check = {
  id: "live-mode",
  title: `live jobs list at least ${MIN_SHADOW_RUNS} shadow runs`,
  run(repo) {
    const problems: Problem[] = [];
    for (const { name, config } of validJobs(repo)) {
      if (config.mode !== "live") continue;
      const file = jobFile(name, "SHADOW_RUNS.md");
      const path = join(repo.root, file);
      if (!existsSync(path)) {
        problems.push(
          problem(
            jobFile(name, "job.yml"),
            `live mode needs ${file} listing at least ${MIN_SHADOW_RUNS} shadow run links`,
            "mode",
          ),
        );
        continue;
      }
      const runs = countShadowRuns(readFileSync(path, "utf8"));
      if (runs < MIN_SHADOW_RUNS) {
        problems.push(
          problem(
            file,
            `lists ${runs} distinct shadow run links; live mode needs at least ${MIN_SHADOW_RUNS}`,
          ),
        );
      }
    }
    return problems;
  },
};
