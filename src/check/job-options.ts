import { workspace } from "../lib/workspace.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { revisable } from "../generate/render.ts";
import { KIT_WORKFLOW_INPUTS, NO_MODEL, usesModel } from "../lib/job.ts";
import { jobFile } from "../lib/paths.ts";
import { problem, type Problem } from "../lib/problem.ts";
import { validJobs } from "../lib/repo.ts";
import type { Check } from "./types.ts";
import { NEVER_CODE_FIX } from "../output-check/pr.ts";

/** The kit's own repository: its code runs every job, so no job fixes it. */
const KIT_REPO = () => workspace().repo;

/** GitHub takes at most this many workflow_dispatch inputs. */
export const MAX_DISPATCH_INPUTS = 10;

/**
 * The opt-in options of a job fit it: collect inputs only for a job that
 * runs a model and has collect.ts, each a new name with a pattern that
 * compiles, within GitHub's limit on dispatch inputs; tool citations only
 * for a job whose model has tools; pages on demand and a branch key from
 * the answer only for a job that runs a model; a branch key from the
 * input only for a job with collect.ts; a code fix only in repositories
 * with code settings in repos.yml, never the kit's own, and never with a
 * glob that names a build, workflow, deployment or migration file.
 */
export const jobOptionsCheck: Check = {
  id: "job-options",
  title: "opt-in job options fit the job",
  run(repo) {
    const problems: Problem[] = [];
    // A repos.yml glob is named once, however many jobs fix code in its repository.
    const namedGlobs = new Set<string>();
    for (const { name, config } of validJobs(repo)) {
      const file = jobFile(name, "job.yml");
      const hasCollect = existsSync(
        join(repo.root, jobFile(name, "collect.ts")),
      );
      const inputs = config.collect_inputs;
      if (inputs !== undefined) {
        if (!usesModel(config))
          problems.push(
            problem(
              file,
              `collect inputs reach collect.ts, which a job with model: ${NO_MODEL} does not run; use media.inputs`,
              "collect_inputs",
            ),
          );
        if (!hasCollect)
          problems.push(
            problem(
              file,
              "has collect inputs, but the job has no collect.ts to read them",
              "collect_inputs",
            ),
          );
        const taken = new Set(config.media?.inputs?.map((i) => i.name) ?? []);
        const seen = new Set<string>();
        for (const [i, input] of inputs.entries()) {
          const field = `collect_inputs[${i}]`;
          if (KIT_WORKFLOW_INPUTS.includes(input.name) || taken.has(input.name))
            problems.push(
              problem(
                file,
                `${input.name} is a workflow input the job already has; name it otherwise`,
                `${field}.name`,
              ),
            );
          if (seen.has(input.name))
            problems.push(
              problem(file, `${input.name} is listed twice`, `${field}.name`),
            );
          seen.add(input.name);
          try {
            new RegExp(input.pattern);
          } catch {
            problems.push(
              problem(
                file,
                "is not a regular expression JavaScript takes",
                `${field}.pattern`,
              ),
            );
          }
        }
        const kit =
          (repo.allowlists.models.length > 0 ? 2 : 0) +
          (revisable(config) ? 4 : 0) +
          (config.media?.model === undefined ? 0 : 1);
        if (kit + inputs.length > MAX_DISPATCH_INPUTS)
          problems.push(
            problem(
              file,
              `the workflow would have ${kit + inputs.length} inputs with the kit's own ${kit}; GitHub takes at most ${MAX_DISPATCH_INPUTS}`,
              "collect_inputs",
            ),
          );
      }
      if (config.ledger === true && (!usesModel(config) || !hasCollect))
        problems.push(
          problem(
            file,
            "a ledger is what collect.ts keeps between runs; the job needs a model and a collect.ts",
            "ledger",
          ),
        );
      const output = config.output;
      if (output.kind !== "pr") continue;
      if (output.tool_citations === true && config.tools.length === 0)
        problems.push(
          problem(
            file,
            "a quote of a tool result needs a tool the model calls; the job lists no tools",
            "output.tool_citations",
          ),
        );
      if (output.code_fix === true) {
        for (const r of output.repos) {
          if (r === KIT_REPO())
            problems.push(
              problem(
                file,
                `${r} holds the kit's own code, which no job fixes`,
                "output.code_fix",
              ),
            );
          const code = repo.allowlists.repoCode[r];
          if (code === undefined)
            problems.push(
              problem(
                file,
                `${r} has no code settings in repos.yml (code: paths, tests, test_command), so a code fix has nowhere to go`,
                "output.code_fix",
              ),
            );
          for (const glob of [...(code?.paths ?? []), ...(code?.tests ?? [])])
            if (NEVER_CODE_FIX.test(glob) && !namedGlobs.has(`${r} ${glob}`)) {
              namedGlobs.add(`${r} ${glob}`);
              problems.push(
                problem(
                  "repos.yml",
                  `${r} code glob ${glob} names a workflow, build, dependency, deployment or migration file, which a code fix never changes`,
                ),
              );
            }
        }
        for (const glob of [
          ...output.paths,
          ...(output.new_files?.paths ?? []),
        ])
          if (NEVER_CODE_FIX.test(glob))
            problems.push(
              problem(
                file,
                `${glob} names a workflow, build, dependency, deployment or migration file, which a code fix never changes`,
                "output.paths",
              ),
            );
      }
      if (output.pages_on_demand !== undefined && !usesModel(config))
        problems.push(
          problem(
            file,
            `pages on demand are for pages a model's patch names; a job with model: ${NO_MODEL} gives its pages in the input`,
            "output.pages_on_demand",
          ),
        );
      const key = output.branch_key;
      if (key?.from === "answer" && !usesModel(config))
        problems.push(
          problem(
            file,
            `a job with model: ${NO_MODEL} has no model answer to read the key from; use from: input`,
            "output.branch_key.from",
          ),
        );
      if (key?.from === "input" && !hasCollect)
        problems.push(
          problem(
            file,
            "the key comes from the input, but the job has no collect.ts to set it",
            "output.branch_key.from",
          ),
        );
    }
    return problems;
  },
};
