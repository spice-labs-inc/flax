import { jobEnvs, NO_MODEL, usesModel } from "../lib/job.ts";
import { jobFile } from "../lib/paths.ts";
import { problem, type Problem } from "../lib/problem.ts";
import { validJobs } from "../lib/repo.ts";
import type { Check } from "./types.ts";

/**
 * Check jobs (output kind results) run no model by construction: model
 * none and no media.model. They run on trigger.envs, one environment a
 * run, each environment on a cron of its own; and trigger.envs is theirs
 * alone. Their alert channel is in the post list of channels.yml, with an
 * id once the job is live.
 */
export const checkJobsCheck: Check = {
  id: "check-jobs",
  title: "check jobs run no model, one environment a run",
  run(repo) {
    const problems: Problem[] = [];
    for (const { name, config } of validJobs(repo)) {
      const file = jobFile(name, "job.yml");
      const output = config.output;
      const envs = "envs" in config.trigger;
      if (output.kind !== "results") {
        if (envs)
          problems.push(
            problem(
              file,
              "trigger.envs runs one environment a run, for a check job; it needs output kind results",
              "trigger.envs",
            ),
          );
        continue;
      }
      if (usesModel(config))
        problems.push(
          problem(
            file,
            `a check job (output kind results) runs no model; set model: ${NO_MODEL}`,
            "model",
          ),
        );
      if (config.media?.model !== undefined)
        problems.push(
          problem(
            file,
            "a check job (output kind results) runs no model, in its media stage either; remove media.model",
            "media.model",
          ),
        );
      if (config.media?.parts !== undefined)
        problems.push(
          problem(
            file,
            "a check job's media stage is one run; it takes no parts",
            "media.parts",
          ),
        );
      if (!envs)
        problems.push(
          problem(
            file,
            "a check job (output kind results) checks one environment a run; give it trigger.envs",
            "trigger",
          ),
        );
      else {
        const trigger = config.trigger as { envs: Record<string, string> };
        const seen = new Map<string, string>();
        for (const env of jobEnvs(config)) {
          const cron = trigger.envs[env]!.trim().replace(/\s+/g, " ");
          const other = seen.get(cron);
          if (other !== undefined)
            problems.push(
              problem(
                file,
                `${env} has the same cron as ${other}; the workflow tells the environments apart by the cron that fired`,
                `trigger.envs.${env}`,
              ),
            );
          seen.set(cron, env);
        }
      }
      if (output.alert !== undefined) {
        const channel = repo.allowlists.postChannels.find(
          (c) => c.name === output.alert,
        );
        if (channel === undefined)
          problems.push(
            problem(
              file,
              `"${output.alert}" is not listed in channels.yml`,
              "output.alert",
            ),
          );
        else if (config.mode === "live" && channel.id === undefined)
          problems.push(
            problem(
              file,
              `"${output.alert}" has no id in channels.yml; a live job posts by channel id`,
              "output.alert",
            ),
          );
      }
    }
    return problems;
  },
};
