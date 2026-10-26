import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runChecks } from "../check/index.ts";
import {
  modelFamily,
  thinkingRefusal,
  type Allowlists,
  type Model,
  type PostChannel,
  type RepoCode,
  type RepoPreview,
  type ShadowChannel,
} from "../lib/allowlists.ts";
import { UNPINNED_MESSAGE, type Box } from "../lib/box.ts";
import { modelRefusal, type Gateway } from "../lib/gateway.ts";
import {
  isThinkingLevel,
  NO_MODEL,
  THINKING_LEVELS,
  usesModel,
  type MediaModel,
  type ModelJobConfig,
  type NoModelJobConfig,
  type Output,
  type ThinkingLevel,
} from "../lib/job.ts";
import { BOX_FILE, GATEWAY_FILE, jobFile } from "../lib/paths.ts";
import { formatProblem, isError } from "../lib/problem.ts";
import { loadRepo } from "../lib/repo.ts";

export interface RunnableJob {
  config: ModelJobConfig;
  model: Model;
  /** May be unpinned or missing only in stub runs, which never start a box. */
  box?: Box;
  /** gateway.yml, which flax agents check has accepted. */
  gateway: Gateway;
  /** The gateway CA root; none for a static provider trusting the system roots. */
  gatewayCa?: string;
  prompt: string;
  outputSchema: object;
  /** For a job with output kind slack: its channel and the shadow channel from channels.yml, and the prefixes a message may link to. */
  slack?: { channel: PostChannel; shadow?: ShadowChannel; links: string[] };
  /** For a pull request job with output.notify: that channel, the shadow channel and the prefixes the notice may link to. */
  prNotify?: PrNotify;
  /** The prefixes channels.yml lets agent text link to (links), which the pull request sections of publish.ts must keep to. */
  links: string[];
  /** The model of media.model, when the media stage gets a key. */
  mediaModel?: Model;
  /** The model of media.model.fallback, when it has one other than mediaModel. */
  mediaFallback?: Model;
  /** repos.yml's preview instructions, by repository, for pull request bodies. */
  previews: Readonly<Record<string, RepoPreview>>;
  /** repos.yml's code settings, by repository, for a job with output.code_fix. */
  repoCode: Readonly<Record<string, RepoCode>>;
  /** models.yml's entries for the job's models, when collect.ts may choose between them. */
  choices?: Model[];
  /** The model and level the second check runs on, when it is not the run's own model. */
  reviewModel?: { model: Model; thinking: ThinkingLevel };
}

/**
 * The second check's model: --review-model, else output.review_model; none
 * when neither is set (the check runs on the run's own model). It must be
 * listed, take its level, and be of another family than the run's model.
 */
function reviewModelOf(
  models: readonly Model[],
  config: ModelJobConfig,
  options: { reviewModel?: string; reviewThinking?: string },
):
  { model: Model; thinking: ThinkingLevel } | { errors: string[] } | undefined {
  const set =
    config.output.kind === "pr" ? config.output.review_model : undefined;
  const id = options.reviewModel ?? set?.model;
  if (id === undefined) {
    if (options.reviewThinking !== undefined)
      return {
        errors: [
          "--review-thinking: the job has no review_model; name one with --review-model",
        ],
      };
    return undefined;
  }
  if (config.output.kind !== "pr")
    return {
      errors: [
        `--review-model: only a pull request job has a second check, and this one delivers ${config.output.kind}`,
      ],
    };
  const flag =
    options.reviewModel === undefined
      ? "output.review_model"
      : "--review-model";
  const model = models.find((m) => m.id === id);
  if (model === undefined)
    return { errors: [`${flag}: "${id}" is not listed in models.yml`] };
  const refusal = modelRefusal(model);
  if (refusal !== undefined) return { errors: [`${flag}: ${refusal}`] };
  const thinking =
    options.reviewThinking ??
    (set !== undefined && set.model === id ? set.thinking : undefined) ??
    model.thinking?.at(-1) ??
    "high";
  if (!isThinkingLevel(thinking))
    return {
      errors: [
        `--review-thinking: "${thinking}" is not a level Pi takes (${THINKING_LEVELS.join(", ")})`,
      ],
    };
  const refusedThinking = thinkingRefusal(model, thinking);
  if (refusedThinking !== undefined)
    return { errors: [`--review-thinking: ${refusedThinking}`] };
  if (modelFamily(model.id) === modelFamily(config.model))
    return {
      errors: [
        `${flag}: "${model.id}" is of the same family (${modelFamily(model.id)}) as ${config.model}, which writes the answer; the second check must run on another family`,
      ],
    };
  return { model, thinking };
}

/** A job with model: none: no box, model, gateway or prompt; the kit builds its answer. */
export interface NoModelJob {
  config: NoModelJobConfig;
  /** For output kind youtube: the channel its notice goes to, if any, the shadow channel a shadow run's notice goes to, and the prefixes a notice may link to. */
  youtube?: { notify?: PostChannel; shadow?: ShadowChannel; links: string[] };
  /** For a pull request job with output.notify: that channel, the shadow channel and the prefixes the notice may link to. */
  prNotify?: PrNotify;
  /** For output kind results: the alert channel and the shadow channel, and the prefixes an alert may link to. */
  results?: {
    alert?: PostChannel;
    shadow?: ShadowChannel;
    links: string[];
  };
  /** For a job with media.model: the model, its fallback model if any, and the gateway that issues the media stage's key. */
  mediaModel?: {
    model: Model;
    fallback?: Model;
    gateway: Gateway;
    gatewayCa?: string;
  };
  /** repos.yml's preview instructions, by repository, for pull request bodies. */
  previews: Readonly<Record<string, RepoPreview>>;
}

export type Loaded =
  | { ok: true; job: RunnableJob }
  | { ok: true; noModel: NoModelJob }
  | { ok: false; errors: string[] };

/** Where a pull request job tells people about the pull requests it opens. */
export interface PrNotify {
  channel: PostChannel;
  /** Where a shadow run posts the notice; without it a shadow run posts none. */
  shadow?: ShadowChannel;
  links: string[];
}

function prNotifyOf(
  output: Output,
  allowlists: Allowlists,
): PrNotify | undefined {
  if (output.kind !== "pr" || output.notify === undefined) return undefined;
  const channel = allowlists.postChannels.find((c) => c.name === output.notify);
  if (channel === undefined) return undefined;
  return {
    channel: { ...channel },
    ...(allowlists.shadowChannel === undefined
      ? {}
      : { shadow: { ...allowlists.shadowChannel } }),
    links: [...allowlists.links],
  };
}

function youtubeDelivery(
  output: Output,
  allowlists: Allowlists,
): NoModelJob["youtube"] {
  if (output.kind !== "youtube") return undefined;
  const notify =
    output.notify === undefined
      ? undefined
      : allowlists.postChannels.find((c) => c.name === output.notify);
  return {
    ...(notify === undefined ? {} : { notify: { ...notify } }),
    ...(notify === undefined || allowlists.shadowChannel === undefined
      ? {}
      : { shadow: { ...allowlists.shadowChannel } }),
    links: [...allowlists.links],
  };
}

function resultsDelivery(
  output: Output,
  allowlists: Allowlists,
): NoModelJob["results"] {
  if (output.kind !== "results") return undefined;
  const alert =
    output.alert === undefined
      ? undefined
      : allowlists.postChannels.find((c) => c.name === output.alert);
  return {
    ...(alert === undefined ? {} : { alert: { ...alert } }),
    ...(allowlists.shadowChannel === undefined
      ? {}
      : { shadow: { ...allowlists.shadowChannel } }),
    links: [...allowlists.links],
  };
}

/**
 * The models.yml entry of media.model, which flax agents check has accepted, or of
 * --media-model for this run, and of media.model.fallback unless it is the
 * model this run uses.
 */
function mediaModelOf(
  models: readonly Model[],
  media: MediaModel,
  override?: string,
):
  | { ok: true; model: Model; fallback?: Model }
  | { ok: false; errors: string[] } {
  const id = override ?? media.model;
  const field = override === undefined ? "media.model" : "--media-model";
  const model = models.find((m) => m.id === id);
  if (model === undefined)
    return {
      ok: false,
      errors: [`${field}: "${id}" is not listed in models.yml`],
    };
  const refusal = modelRefusal(model);
  if (refusal !== undefined)
    return { ok: false, errors: [`${field}: ${refusal}`] };
  const fallback =
    media.fallback === undefined || media.fallback === id
      ? undefined
      : models.find((m) => m.id === media.fallback);
  return { ok: true, model, ...(fallback === undefined ? {} : { fallback }) };
}

/**
 * Loads a job the way flax agents check sees it. The whole repository is checked,
 * not just this job: a run must never start from a tree flax agents check rejects.
 */
export async function loadRunnableJob(
  root: string,
  name: string,
  options: {
    stub: boolean;
    model?: string;
    thinking?: string;
    reviewModel?: string;
    reviewThinking?: string;
    mediaModel?: string;
  },
): Promise<Loaded> {
  const repo = loadRepo(root);
  const entry = repo.jobs.find((j) => j.name === name);
  if (entry === undefined)
    return { ok: false, errors: [`no job named "${name}" under jobs/`] };
  const errors = (await runChecks(repo)).filter(isError).map(formatProblem);
  if (errors.length > 0) return { ok: false, errors };
  const job = entry.config!;
  if (options.mediaModel !== undefined && job.media?.model === undefined)
    return {
      ok: false,
      errors: [
        `--media-model: ${name} has no media.model, so its media stage gets no model`,
      ],
    };
  if (!usesModel(job)) {
    if (
      options.model !== undefined ||
      options.thinking !== undefined ||
      options.reviewModel !== undefined ||
      options.reviewThinking !== undefined
    )
      return {
        ok: false,
        errors: [
          `${options.model !== undefined ? "--model" : options.thinking !== undefined ? "--thinking" : options.reviewModel !== undefined ? "--review-model" : "--review-thinking"}: ${name} runs no model (model: ${NO_MODEL})`,
        ],
      };
    const youtube = youtubeDelivery(job.output, repo.allowlists);
    const results = resultsDelivery(job.output, repo.allowlists);
    const prNotify = prNotifyOf(job.output, repo.allowlists);
    let mediaModel: NoModelJob["mediaModel"];
    if (job.media?.model !== undefined) {
      const loaded = mediaModelOf(
        repo.allowlists.models,
        job.media.model,
        options.mediaModel,
      );
      if (!loaded.ok) return loaded;
      if (repo.gateway === undefined)
        return {
          ok: false,
          errors: [`${GATEWAY_FILE}: the gateway or its CA root did not load`],
        };
      mediaModel = {
        model: loaded.model,
        ...(loaded.fallback === undefined ? {} : { fallback: loaded.fallback }),
        gateway: repo.gateway,
        ...(repo.gatewayCa === undefined ? {} : { gatewayCa: repo.gatewayCa }),
      };
    }
    return {
      ok: true,
      noModel: {
        config: job,
        previews: repo.allowlists.repoPreviews,
        ...(youtube === undefined ? {} : { youtube }),
        ...(results === undefined ? {} : { results }),
        ...(prNotify === undefined ? {} : { prNotify }),
        ...(mediaModel === undefined ? {} : { mediaModel }),
      },
    };
  }
  const model = repo.allowlists.models.find(
    (m) => m.id === (options.model ?? job.model),
  );
  if (model === undefined)
    return {
      ok: false,
      errors: [`--model: "${options.model}" is not listed in models.yml`],
    };
  const refusal = modelRefusal(model);
  if (refusal !== undefined)
    return {
      ok: false,
      errors: [
        options.model === undefined
          ? `${jobFile(name, "job.yml")}: model: ${refusal}`
          : `--model: ${refusal}`,
      ],
    };
  // A model picked by hand from the job's models runs at that entry's level unless the run names one.
  const thinking =
    options.thinking ??
    job.models?.find((c) => c.model === model.id)?.thinking ??
    job.thinking;
  if (!isThinkingLevel(thinking))
    return {
      ok: false,
      errors: [
        `--thinking: "${thinking}" is not a level Pi takes (${THINKING_LEVELS.join(", ")})`,
      ],
    };
  const refusedThinking = thinkingRefusal(model, thinking);
  if (refusedThinking !== undefined)
    return {
      ok: false,
      errors: [
        options.thinking === undefined
          ? `--model: ${refusedThinking} (the job's own level); pick one it takes with --thinking`
          : `--thinking: ${refusedThinking}`,
      ],
    };
  const config: ModelJobConfig = { ...job, model: model.id, thinking };
  const reviewModel = reviewModelOf(repo.allowlists.models, config, options);
  if (reviewModel !== undefined && "errors" in reviewModel)
    return { ok: false, errors: reviewModel.errors };
  if (config.mode !== "shadow" && config.output.kind === "file") {
    return {
      ok: false,
      errors: [
        `${jobFile(name, "job.yml")}: mode: live runs deliver pull requests (output kind pr), Slack messages (output kind slack) or private YouTube uploads (output kind youtube); a file job has nothing to deliver and stays in shadow`,
      ],
    };
  }
  const output = config.output;
  const slack =
    output.kind === "slack"
      ? {
          channel: repo.allowlists.postChannels.find(
            (c) => c.name === output.channel,
          )!,
          ...(repo.allowlists.shadowChannel === undefined
            ? {}
            : { shadow: { ...repo.allowlists.shadowChannel } }),
          links: [...repo.allowlists.links],
        }
      : undefined;
  const prNotify = prNotifyOf(output, repo.allowlists);
  const box = repo.box;
  if (!options.stub && (box === undefined || !box.pinned))
    return { ok: false, errors: [`${BOX_FILE}: pinned: ${UNPINNED_MESSAGE}`] };
  let mediaModel: Model | undefined;
  let mediaFallback: Model | undefined;
  if (config.media?.model !== undefined) {
    const loaded = mediaModelOf(
      repo.allowlists.models,
      config.media.model,
      options.mediaModel,
    );
    if (!loaded.ok) return loaded;
    mediaModel = loaded.model;
    mediaFallback = loaded.fallback;
  }
  const { gateway, gatewayCa } = repo;
  if (gateway === undefined)
    return {
      ok: false,
      errors: [`${GATEWAY_FILE}: the gateway or its CA root did not load`],
    };
  return {
    ok: true,
    job: {
      config,
      model,
      ...(box === undefined ? {} : { box }),
      gateway,
      ...(gatewayCa === undefined ? {} : { gatewayCa }),
      ...(slack === undefined ? {} : { slack }),
      ...(prNotify === undefined ? {} : { prNotify }),
      links: [...repo.allowlists.links],
      ...(mediaModel === undefined ? {} : { mediaModel }),
      ...(mediaFallback === undefined ? {} : { mediaFallback }),
      ...(reviewModel === undefined ? {} : { reviewModel }),
      previews: repo.allowlists.repoPreviews,
      repoCode: repo.allowlists.repoCode,
      ...(config.models === undefined
        ? {}
        : {
            choices: repo.allowlists.models.filter((m) =>
              config.models!.some((c) => c.model === m.id),
            ),
          }),
      prompt: readFileSync(join(root, jobFile(name, "prompt.md")), "utf8"),
      outputSchema: JSON.parse(
        readFileSync(join(root, jobFile(name, "output.json")), "utf8"),
      ) as object,
    },
  };
}
