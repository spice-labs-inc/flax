import { workspace } from "../lib/workspace.ts";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEDIA_FIXTURE,
  MEDIA_EXTERNALS,
  MEDIA_FIXTURE_DIR,
  mediaSecretEnv,
  readMediaManifest,
  networkJoinSecrets,
} from "../lib/media.ts";
import { modelRefusal } from "../lib/gateway.ts";
import {
  KIT_WORKFLOW_INPUTS,
  mediaSourceRepo,
  NO_MODEL,
  partStage,
  usesModel,
  type JobConfig,
  type MediaStage,
  MEDIA_SETUP,
} from "../lib/job.ts";
import { bundledJobScript, jobFile } from "../lib/paths.ts";
import { isPlainRelativePath } from "../output-check/glob.ts";
import { firstLine, problem, type Problem } from "../lib/problem.ts";
import { toolSecretEnv } from "../lib/tools.ts";
import { RUNNER_SECRET_ENV } from "../run-job/argv.ts";
import { mediaKeyMinutes } from "../run-job/media-model.ts";
import type { Check } from "./types.ts";

/**
 * Secrets media.ts may never get, even if someone adds them to
 * agents.mediaSecrets: the gateway issuer key, the writer and posting tokens,
 * every tool credential, the tailnet's OAuth client and the workflow's own
 * tokens.
 */
export function neverMediaSecrets(): readonly string[] {
  return [
    ...RUNNER_SECRET_ENV,
    ...toolSecretEnv(),
    ...networkJoinSecrets(),
    ...(workspace().sandbox.tokenSecret === undefined
      ? []
      : [workspace().sandbox.tokenSecret as string]),
    "GITHUB_TOKEN",
  ];
}

/** The packages a media.ts bundle imports from node_modules, which only media.setup packages installs. */
export function bundleExternals(bundle: string): string[] {
  return MEDIA_EXTERNALS.filter((name) =>
    new RegExp(`\\bfrom\\s*"${name}"`).test(bundle),
  );
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A stage's cache entries: each names a source the stage checks out and
 * plain relative paths inside it, so a restore writes only into that
 * checkout; a stage split into parts has none.
 */
export function cacheProblems(file: string, media: MediaStage): Problem[] {
  const problems: Problem[] = [];
  if (media.cache === undefined) return problems;
  if (media.parts !== undefined)
    problems.push(
      problem(
        file,
        "a stage split into parts keeps no cache; each part runs in a workflow job of its own",
        "media.cache",
      ),
    );
  const sources = (media.sources ?? []).map(mediaSourceRepo);
  for (const [i, entry] of media.cache.entries()) {
    if (!sources.includes(entry.source))
      problems.push(
        problem(
          file,
          `${entry.source} is not in media.sources; a cache keeps files of a checked out source`,
          `media.cache[${i}].source`,
        ),
      );
    for (const field of ["paths", "key_files"] as const)
      for (const [j, path] of entry[field].entries())
        if (!isPlainRelativePath(path))
          problems.push(
            problem(
              file,
              `${path} must be a plain relative path inside the checkout`,
              `media.cache[${i}].${field}[${j}]`,
            ),
          );
  }
  return problems;
}

/**
 * A stage's workflow inputs: only for a job with model: none whose stage
 * is not split into parts (the one run step passes them), each name once
 * and none the kit's own workflow inputs already take.
 */
export function inputProblems(
  file: string,
  config: JobConfig,
  media: MediaStage,
): Problem[] {
  const problems: Problem[] = [];
  if (media.inputs === undefined) return problems;
  if (usesModel(config))
    problems.push(
      problem(
        file,
        `media inputs reach media.ts through a job's one run step; only a job with model: ${NO_MODEL} may have them`,
        "media.inputs",
      ),
    );
  if (media.parts !== undefined)
    problems.push(
      problem(
        file,
        "a stage split into parts takes no inputs; each part runs in a workflow job of its own",
        "media.inputs",
      ),
    );
  const seen = new Set<string>();
  for (const [i, input] of media.inputs.entries()) {
    if (KIT_WORKFLOW_INPUTS.includes(input.name))
      problems.push(
        problem(
          file,
          `${input.name} is a workflow input the kit already gives the job; name it otherwise`,
          `media.inputs[${i}].name`,
        ),
      );
    if (seen.has(input.name))
      problems.push(
        problem(
          file,
          `${input.name} is listed twice`,
          `media.inputs[${i}].name`,
        ),
      );
    seen.add(input.name);
  }
  return problems;
}

/**
 * A stage split into parts: only a job with model: none and output kind
 * youtube, whose delivery merges the parts' scenarios; each part's id
 * once, its secrets the stage's, chromium with packages, and the stage's
 * media key going to at least one part and living within the gateway's
 * ceiling for each part that gets it.
 */
export function partProblems(
  file: string,
  config: JobConfig,
  gateway: { key_max_minutes: number } | undefined,
): Problem[] {
  const media = config.media!;
  const parts = media.parts ?? [];
  const problems: Problem[] = [];
  if (usesModel(config) || config.output.kind !== "youtube")
    problems.push(
      problem(
        file,
        `parts merge into one youtube delivery; only a job with model: ${NO_MODEL} and output kind youtube may split its media stage`,
        "media.parts",
      ),
    );
  if (media.pr_paths !== undefined)
    problems.push(
      problem(
        file,
        "a stage split into parts takes no pr_paths",
        "media.parts",
      ),
    );
  const seen = new Set<string>();
  for (const [i, part] of parts.entries()) {
    const at = `media.parts[${i}]`;
    if (seen.has(part.id))
      problems.push(problem(file, `${part.id} is listed twice`, `${at}.id`));
    seen.add(part.id);
    for (const name of part.secrets ?? [])
      if (!media.secrets.includes(name))
        problems.push(
          problem(
            file,
            `${name} is not one of the stage's secrets; a part gets a subset of media.secrets`,
            `${at}.secrets`,
          ),
        );
    const stage = partStage(media, part);
    if (stage.setup?.includes("chromium") && !stage.setup.includes("packages"))
      problems.push(
        problem(
          file,
          "chromium is installed with the locked packages; add packages",
          `${at}.setup`,
        ),
      );
    if (part.model === true && media.model === undefined)
      problems.push(
        problem(file, "asks for a key, but the stage has no model", at),
      );
    if (
      part.model === true &&
      gateway !== undefined &&
      mediaKeyMinutes(stage) > gateway.key_max_minutes
    )
      problems.push(
        problem(
          file,
          `the part's media key would live ${mediaKeyMinutes(stage)} minutes, over the gateway's ${gateway.key_max_minutes}-minute ceiling (key_max_minutes in gateway.yml)`,
          `${at}.timeout_minutes`,
        ),
      );
  }
  if (media.model !== undefined && !parts.some((p) => p.model === true))
    problems.push(
      problem(
        file,
        "the stage has a media model, but no part gets its key; mark the parts that need it with model: true",
        "media.parts",
      ),
    );
  return problems;
}

/** A job has media.ts exactly when its job.yml has media, lists only secrets media.ts may get, names pull request paths only for a pull request job, and any media fixture checks out. */
export const mediaCheck: Check = {
  id: "media",
  title: "media stages have media.ts and only allowed secrets",
  run(repo) {
    const problems: Problem[] = [];
    for (const name of mediaSecretEnv())
      if (neverMediaSecrets().includes(name))
        problems.push(
          problem(
            "src/lib/media.ts",
            `flax.yml agents.mediaSecrets lists ${name}, which media.ts may never get`,
          ),
        );
    for (const job of repo.jobs) {
      const file = jobFile(job.name, "job.yml");
      const hasScript = existsSync(
        join(repo.root, jobFile(job.name, "media.ts")),
      );
      const media = job.config?.media;
      if (job.config !== undefined && media === undefined && hasScript)
        problems.push(
          problem(
            jobFile(job.name, "media.ts"),
            "runs only for a job whose job.yml has media; add it or remove media.ts",
          ),
        );
      if (media !== undefined && !hasScript)
        problems.push(problem(file, "the job has no media.ts to run", "media"));
      if (
        job.config !== undefined &&
        !usesModel(job.config) &&
        media === undefined
      )
        problems.push(
          problem(
            file,
            `a job with model: ${NO_MODEL} delivers what its media.ts makes; add media`,
            "media",
          ),
        );
      for (const [i, name] of (media?.secrets ?? []).entries()) {
        if (neverMediaSecrets().includes(name))
          problems.push(
            problem(
              file,
              `${name} is held by the runner or the workflow alone; media.ts may never get it`,
              `media.secrets[${i}]`,
            ),
          );
        else if (!mediaSecretEnv().includes(name))
          problems.push(
            problem(
              file,
              `${name} is not a secret media.ts may get (flax.yml agents.mediaSecrets: ${mediaSecretEnv().join(", ") || "none"})`,
              `media.secrets[${i}]`,
            ),
          );
      }
      if (media?.org_read === true && media.parts !== undefined)
        problems.push(
          problem(
            file,
            "org_read gives one media.ts run a token for every repository; a stage split into parts cannot have it",
            "media.org_read",
          ),
        );
      if (media !== undefined) problems.push(...cacheProblems(file, media));
      if (media !== undefined && job.config !== undefined)
        problems.push(...inputProblems(file, job.config, media));
      const mediaModel = media?.model;
      if (mediaModel !== undefined && job.config !== undefined) {
        const model = repo.allowlists.models.find(
          (m) => m.id === mediaModel.model,
        );
        const refusal = model === undefined ? undefined : modelRefusal(model);
        if (model === undefined)
          problems.push(
            problem(
              file,
              `"${mediaModel.model}" is not listed in models.yml`,
              "media.model.model",
            ),
          );
        else if (refusal !== undefined)
          problems.push(problem(file, refusal, "media.model.model"));
        const fallbackId = mediaModel.fallback;
        if (fallbackId !== undefined) {
          const fallback = repo.allowlists.models.find(
            (m) => m.id === fallbackId,
          );
          const fallbackRefusal =
            fallback === undefined ? undefined : modelRefusal(fallback);
          if (fallbackId === mediaModel.model)
            problems.push(
              problem(
                file,
                "is the same model as media.model.model; a fallback is another model",
                "media.model.fallback",
              ),
            );
          else if (fallback === undefined)
            problems.push(
              problem(
                file,
                `"${fallbackId}" is not listed in models.yml`,
                "media.model.fallback",
              ),
            );
          else if (fallbackRefusal !== undefined)
            problems.push(
              problem(file, fallbackRefusal, "media.model.fallback"),
            );
        }
        if (usesModel(job.config)) {
          if (mediaModel.usd_per_month !== undefined)
            problems.push(
              problem(
                file,
                "a job that runs a model has limits.usd_per_month, which its media key counts toward; remove usd_per_month",
                "media.model.usd_per_month",
              ),
            );
        } else if (mediaModel.usd_per_month === undefined)
          problems.push(
            problem(
              file,
              `a job with model: ${NO_MODEL} has no limits; give its media key a monthly budget`,
              "media.model.usd_per_month",
            ),
          );
        else if (mediaModel.usd_per_run > mediaModel.usd_per_month)
          problems.push(
            problem(
              file,
              "is more than usd_per_month, so no run could start",
              "media.model.usd_per_run",
            ),
          );
        const minutes = mediaKeyMinutes(media!);
        if (
          repo.gateway !== undefined &&
          minutes > repo.gateway.key_max_minutes
        )
          problems.push(
            problem(
              file,
              `the media key would live ${minutes} minutes (timeout_minutes plus a margin), over the gateway's ${repo.gateway.key_max_minutes}-minute ceiling (key_max_minutes in gateway.yml)`,
              "media.timeout_minutes",
            ),
          );
      }
      const setup = media?.setup ?? [];
      const network = media?.network;
      if (network !== undefined && network !== "public" && !(network in workspace().networkJoins))
        problems.push(
          problem(
            file,
            `network "${network}" is not public and not a join in flax.yml agents.networkJoins (${Object.keys(workspace().networkJoins).join(", ") || "none"})`,
            "media.network",
          ),
        );
      for (const name of setup)
        if (!(MEDIA_SETUP as readonly string[]).includes(name) && !(name in workspace().setupSteps))
          problems.push(
            problem(
              file,
              `setup "${name}" is neither one of the kit's (${MEDIA_SETUP.join(", ")}) nor in flax.yml agents.setupSteps`,
              "media.setup",
            ),
          );
      if (setup.includes("chromium") && !setup.includes("packages"))
        problems.push(
          problem(
            file,
            "chromium is installed with the locked packages; add packages",
            "media.setup",
          ),
        );
      const bundle = join(repo.root, bundledJobScript(job.name, "media.ts"));
      if (media !== undefined && hasScript && existsSync(bundle))
        for (const name of bundleExternals(readFileSync(bundle, "utf8")))
          if (!setup.includes("packages"))
            problems.push(
              problem(
                file,
                `media.ts imports ${name}, which runs from the locked packages; add packages`,
                "media.setup",
              ),
            );
      if (media?.pr_paths !== undefined && job.config?.output.kind !== "pr")
        problems.push(
          problem(
            file,
            "lists files a pull request may change, but the job's output is not a pull request",
            "media.pr_paths",
          ),
        );
      if (media?.parts !== undefined && job.config !== undefined)
        problems.push(...partProblems(file, job.config, repo.gateway));
      for (const [i, glob] of (media?.pr_paths ?? []).entries())
        if (!isPlainRelativePath(glob) || glob.split("/").includes("**"))
          problems.push(
            problem(
              file,
              `${glob} must be a plain relative path glob without **`,
              `media.pr_paths[${i}]`,
            ),
          );
      const fixture = jobFile(job.name, MEDIA_FIXTURE);
      const fixtureDir = jobFile(job.name, MEDIA_FIXTURE_DIR);
      const hasFixture = exists(join(repo.root, fixture));
      if (hasFixture && job.config !== undefined && media === undefined)
        problems.push(
          problem(fixture, "stands in for media.ts, but the job has no media"),
        );
      if (!hasFixture && exists(join(repo.root, fixtureDir)))
        problems.push(
          problem(
            fixtureDir,
            `holds the files of ${MEDIA_FIXTURE}, which is missing`,
          ),
        );
      if (hasFixture) {
        try {
          readMediaManifest(
            join(repo.root, fixture),
            join(repo.root, fixtureDir),
          );
        } catch (err) {
          problems.push(problem(fixture, firstLine(err)));
        }
      }
    }
    return problems;
  },
};
