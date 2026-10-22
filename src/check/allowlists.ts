import {
  modelFamily,
  thinkingRefusal,
  type Allowlists,
} from "../lib/allowlists.ts";
import { modelRefusal } from "../lib/gateway.ts";
import { jobFile, toolDir, TOOLS_DIR } from "../lib/paths.ts";
import { problem, type Problem } from "../lib/problem.ts";
import { usesModel } from "../lib/job.ts";
import { isPlainRelativePath, matchesAnyGlob } from "../output-check/glob.ts";
import { validJobs } from "../lib/repo.ts";
import type { Check } from "./types.ts";

/** Why output.notify is refused: it must be in the post list, with an id for a live job. */
function notifyProblems(
  file: string,
  notify: string | undefined,
  mode: string,
  allowlists: Allowlists,
): Problem[] {
  if (notify === undefined) return [];
  const channel = allowlists.postChannels.find((c) => c.name === notify);
  if (channel === undefined)
    return [
      problem(
        file,
        `"${notify}" is not listed in channels.yml`,
        "output.notify",
      ),
    ];
  if (mode === "live" && channel.id === undefined)
    return [
      problem(
        file,
        `"${notify}" has no id in channels.yml; a live job posts by channel id`,
        "output.notify",
      ),
    ];
  return [];
}

/** Models, tools, Slack channels and repositories must be on the reviewed allowlists. */
/** Top folders auto_merge may never cover: workflows, the kit, jobs, tests and tools. */
const NEVER_AUTO_MERGED = new Set([
  ".github",
  "dist",
  "jobs",
  "schema",
  "scripts",
  "src",
  "test",
  "tests",
  "tools",
]);

/**
 * Why an auto_merge glob is refused, or undefined when it is narrow enough:
 * it starts with a literal folder inside the job's output paths, avoids the
 * folders above, and names no prompt.
 */
export function autoMergeGlobProblem(
  glob: string,
  outputPaths: readonly string[],
): string | undefined {
  const parts = glob.split("/");
  const literal = parts.slice(0, parts.findIndex((p) => /[*?]/.test(p)) >>> 0);
  if (parts.length < 2 || literal.length === 0)
    return `"${glob}" must start with a folder, not a wildcard or a single file name`;
  if (NEVER_AUTO_MERGED.has(parts[0]!))
    return `"${glob}" covers ${parts[0]}/, which is never merged without review`;
  if (/prompt/i.test(glob))
    return `"${glob}" names a prompt; prompts are never merged without review`;
  const sample = parts.map((p) => p.replace(/[*?]+/g, "x")).join("/");
  if (!matchesAnyGlob(sample, outputPaths))
    return `"${glob}" is outside the job's output paths`;
  return undefined;
}

export const allowlistsCheck: Check = {
  id: "allowlists",
  title: "models, tools, channels and repositories are allowlisted",
  run(repo) {
    const { models, tools, channels, repos } = repo.allowlists;
    const validTools = new Set(
      repo.tools.filter((t) => t.spec !== undefined).map((t) => t.name),
    );
    const problems: Problem[] = [...repo.allowlistProblems];
    for (const { name, config } of validJobs(repo)) {
      const file = jobFile(name, "job.yml");
      const model = models.find((m) => m.id === config.model);
      if (usesModel(config) && model === undefined) {
        problems.push(
          problem(
            file,
            `"${config.model}" is not listed in models.yml`,
            "model",
          ),
        );
      } else if (usesModel(config) && model !== undefined) {
        const refusal = modelRefusal(model);
        if (refusal !== undefined)
          problems.push(problem(file, refusal, "model"));
        const thinking = thinkingRefusal(model, config.thinking);
        if (thinking !== undefined)
          problems.push(problem(file, thinking, "thinking"));
      }
      if (usesModel(config) && config.models !== undefined) {
        const seen = new Set<string>();
        for (const [i, choice] of config.models.entries()) {
          const field = `models[${i}]`;
          if (seen.has(choice.model))
            problems.push(
              problem(file, `"${choice.model}" is listed twice`, field),
            );
          seen.add(choice.model);
          const listed = models.find((m) => m.id === choice.model);
          if (listed === undefined) {
            problems.push(
              problem(
                file,
                `"${choice.model}" is not listed in models.yml`,
                `${field}.model`,
              ),
            );
            continue;
          }
          const refusal = modelRefusal(listed);
          if (refusal !== undefined)
            problems.push(problem(file, refusal, `${field}.model`));
          const thinking = thinkingRefusal(listed, choice.thinking);
          if (thinking !== undefined)
            problems.push(problem(file, thinking, `${field}.thinking`));
        }
        if (
          !config.models.some(
            (c) => c.model === config.model && c.thinking === config.thinking,
          )
        )
          problems.push(
            problem(
              file,
              `model and thinking (${config.model} at ${config.thinking}) must be one of the models entries: they are the default choice`,
              "models",
            ),
          );
      }
      const review =
        config.output.kind === "pr" ? config.output.review_model : undefined;
      if (usesModel(config) && review !== undefined) {
        const field = "output.review_model";
        const listed = models.find((m) => m.id === review.model);
        if (listed === undefined)
          problems.push(
            problem(
              file,
              `"${review.model}" is not listed in models.yml`,
              `${field}.model`,
            ),
          );
        else {
          const refusal = modelRefusal(listed);
          if (refusal !== undefined)
            problems.push(problem(file, refusal, `${field}.model`));
          const thinking = thinkingRefusal(listed, review.thinking);
          if (thinking !== undefined)
            problems.push(problem(file, thinking, `${field}.thinking`));
        }
        const writers = [
          config.model,
          ...(config.models ?? []).map((c) => c.model),
        ];
        const same = writers.find(
          (w) => modelFamily(w) === modelFamily(review.model),
        );
        if (same !== undefined)
          problems.push(
            problem(
              file,
              `"${review.model}" is of the same family (${modelFamily(review.model)}) as ${same}, which writes the answer; the second check must run on another family`,
              `${field}.model`,
            ),
          );
      }
      if (!usesModel(config) && "models" in config) {
        problems.push(
          problem(
            file,
            "a job with model none runs no model, so it has no models to choose between",
            "models",
          ),
        );
      }
      for (const [key, list] of [
        ["tools", config.tools],
        ["collect_tools", config.collect_tools ?? []],
      ] as const) {
        for (const [i, tool] of list.entries()) {
          if (!tools.includes(tool)) {
            problems.push(
              problem(
                file,
                `"${tool}" has no directory ${TOOLS_DIR}/${tool}/`,
                `${key}[${i}]`,
              ),
            );
          } else if (!validTools.has(tool)) {
            problems.push(
              problem(
                file,
                `"${tool}" is not a valid tool; fix the problems reported for ${toolDir(tool)}/`,
                `${key}[${i}]`,
              ),
            );
          }
        }
      }
      const output = config.output;
      if (output.kind === "slack" && !channels.includes(output.channel)) {
        problems.push(
          problem(
            file,
            `"${output.channel}" is not listed in channels.yml`,
            "output.channel",
          ),
        );
      } else if (
        output.kind === "slack" &&
        config.mode === "live" &&
        repo.allowlists.postChannels.find((c) => c.name === output.channel)
          ?.id === undefined
      ) {
        problems.push(
          problem(
            file,
            `"${output.channel}" has no id in channels.yml; a live job posts by channel id`,
            "output.channel",
          ),
        );
      }
      if (
        !usesModel(config) &&
        output.kind !== "youtube" &&
        output.kind !== "file" &&
        output.kind !== "results" &&
        !(output.kind === "pr" && config.media?.pr_paths !== undefined)
      )
        problems.push(
          problem(
            file,
            `a job with model: none runs no model, so its answer must be one the kit builds: output kind youtube, output kind results, output kind pr with media.pr_paths whose media.ts builds the answer, or output kind file (the media stage's files and manifest stay in the report), not ${output.kind}${output.kind === "pr" ? " without media.pr_paths" : ""}`,
            "model",
          ),
        );
      if (usesModel(config) && output.kind === "youtube")
        problems.push(
          problem(
            file,
            "output kind youtube publishes what the scenario files say and runs no model; set model: none",
            "model",
          ),
        );
      if (output.kind === "youtube") {
        if (!isPlainRelativePath(output.map_path))
          problems.push(
            problem(
              file,
              `"${output.map_path}" is not a plain relative path`,
              "output.map_path",
            ),
          );
        if (!repos.includes(output.docs_repo))
          problems.push(
            problem(
              file,
              `"${output.docs_repo}" is not listed in repos.yml`,
              "output.docs_repo",
            ),
          );
        problems.push(
          ...notifyProblems(file, output.notify, config.mode, repo.allowlists),
        );
        const sourceDir = output.docs_source_dir;
        if (sourceDir !== undefined) {
          const under = (path: string, dir: string) =>
            path === dir || path.startsWith(`${dir}/`);
          const mediaDir = output.docs_media_dir;
          if (!isPlainRelativePath(sourceDir))
            problems.push(
              problem(
                file,
                `"${sourceDir}" is not a plain relative path`,
                "output.docs_source_dir",
              ),
            );
          else if (
            mediaDir !== undefined &&
            (under(sourceDir, mediaDir) || under(mediaDir, sourceDir))
          )
            problems.push(
              problem(
                file,
                `"${sourceDir}" and docs_media_dir "${mediaDir}" overlap; the scenario sources need a folder of their own`,
                "output.docs_source_dir",
              ),
            );
          else if (under(output.map_path, sourceDir))
            problems.push(
              problem(
                file,
                `map_path "${output.map_path}" is inside "${sourceDir}", where a scenario source could overwrite it`,
                "output.docs_source_dir",
              ),
            );
        }
        const tidy = output.unlist_replaced;
        if (tidy !== undefined) {
          if (config.media?.parts === undefined)
            problems.push(
              problem(
                file,
                "unlist_replaced runs only the delivery job on its schedule, so the media stage must be split into parts",
                "output.unlist_replaced",
              ),
            );
          if (
            "schedule" in config.trigger &&
            config.trigger.schedule === tidy.schedule
          )
            problems.push(
              problem(
                file,
                "unlist_replaced.schedule must differ from the job's own schedule, or the recording run would only tidy",
                "output.unlist_replaced.schedule",
              ),
            );
          if (tidy.mode === "live" && config.mode !== "live")
            problems.push(
              problem(
                file,
                "a shadow job has no YouTube grant; unlist_replaced can only be live in a live job",
                "output.unlist_replaced.mode",
              ),
            );
        }
      }
      if (output.kind === "pr") {
        problems.push(
          ...notifyProblems(file, output.notify, config.mode, repo.allowlists),
        );
        for (const [i, r] of output.repos.entries()) {
          if (!repos.includes(r)) {
            problems.push(
              problem(
                file,
                `"${r}" is not listed in repos.yml`,
                `output.repos[${i}]`,
              ),
            );
          }
        }
        for (const [i, g] of (output.auto_merge?.paths ?? []).entries()) {
          const why = autoMergeGlobProblem(g, output.paths);
          if (why !== undefined)
            problems.push(problem(file, why, `output.auto_merge.paths[${i}]`));
        }
        for (const [i, k] of (output.stamp_keys ?? []).entries()) {
          if ((output.frontmatter_keys ?? []).includes(k)) {
            problems.push(
              problem(
                file,
                `"${k}" is also in frontmatter_keys; a key the job's code stamps is never the model's to change`,
                `output.stamp_keys[${i}]`,
              ),
            );
          }
        }
      }
    }
    return problems;
  },
};
