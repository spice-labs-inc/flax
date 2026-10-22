import { workspace } from "./workspace.ts";
export type Trigger =
  | { schedule: string }
  | { after: string }
  | { manual: true }
  | { envs: EnvSchedules };

/** The environments a check job runs against, one per run. */
export function checkEnvs(): readonly string[] {
  return workspace().environments;
}
export type CheckEnv = string;

/** A check job's schedule per environment: five-field crons, UTC, each its own. */
export type EnvSchedules = Partial<Record<CheckEnv, string>>;

/** The environment one run of a check job checks, in the environment media.ts gets. */
export const TARGET_ENV_ENV = "FLAX_AGENTS_ENV";

/** The environments a job with trigger.envs runs against, in CHECK_ENVS order; none for any other job. */
export function jobEnvs(job: { trigger: Trigger }): CheckEnv[] {
  if (!("envs" in job.trigger)) return [];
  const envs = job.trigger.envs;
  return checkEnvs().filter((e) => envs[e] !== undefined);
}

export type Output =
  | {
      kind: "slack";
      channel: string;
      /** What a run whose model saw untrusted text delivers; post when not set. */
      untrusted_input?: "post" | "report_only";
    }
  | {
      kind: "pr";
      repos: string[];
      paths: string[];
      max_changed_lines: number;
      /** What a run whose model saw untrusted text delivers. */
      untrusted_input: "report_only" | "open_pr";
      /** Frontmatter keys the model may change, with evidence; none when not set. */
      frontmatter_keys?: string[];
      /** Frontmatter keys the job's code sets through the input's stamps, applied at delivery; none when not set. */
      stamp_keys?: string[];
      /** The organization team asked to review every new pull request, by its slug; none when not set. */
      review_team?: string;
      /** The model the second check runs on, of another family than the writer; the job's own model when not set. */
      review_model?: ModelChoice;
      /** Merge a live run's pull request when every changed path matches one of these globs; off when not set. */
      auto_merge?: { paths: string[] };
      /** Leave out a page whose line credits a commit or pull request GitHub shows did not make the change, or dates it wrong; off when not set. */
      attribution_check?: boolean;
      /** When the second check refuses only some changes, publish.ts rebuilds the answer without them and the second check runs once more; off when not set. */
      drop_refused_changes?: boolean;
      /** A channel from the post list of channels.yml told about each pull request a live run opens; none when not set. */
      notify?: string;
      /** One pull request branch per key, agent/<job>/<key>, the key read from a top-level field of the input or the answer; one branch a day, agent/<job>/<YYYY-MM-DD>, when not set. */
      branch_key?: BranchKey;
      /** Pages a patch names that the input did not give, read by the runner with the reader app; none when not set. */
      pages_on_demand?: { paths: string[] };
      /** New files a patch may create, at most max, each under one of paths; none when not set. */
      new_files?: { max: number; paths: string[] };
      /** A change may cite a quote of what a tool returned in the run ({ tool, quote }); off when not set. */
      tool_citations?: boolean;
      /** The job fixes code: a change may cite the very code it changes, each page stays inside its repository's repos.yml code paths, and the second check holds it to the code-fix rules; off when not set. */
      code_fix?: boolean;
      /** Every pull request the job opens is a draft, for a person to mark ready; off when not set. */
      draft?: boolean;
    }
  | {
      kind: "youtube";
      /** The title of a playlist on the channel every upload is added to; none when null. */
      playlist: string | null;
      /** The repository, in repos.yml, whose map file records the uploaded videos. */
      docs_repo: string;
      /** The map file in docs_repo: scenario id to { youtubeId, title, hash, publishedAt }. */
      map_path: string;
      /** A channel from the post list of channels.yml told about each live upload; none when not set. */
      notify?: string;
      /** The organization team asked to review the map pull request when it is opened, by its slug; none when not set. */
      review_team?: string;
      /** A folder under public/ in docs_repo for each video's poster and captions, named in its map entry; none when not set. */
      docs_media_dir?: string;
      /** A folder in docs_repo where the map pull request commits each uploaded video's scenario source file (data.scenarios[id].scenarioFile); none when not set. */
      docs_source_dir?: string;
      /** What the review notice and the map pull request call one video, such as "What's new episode"; "demo video" when not set. */
      video_noun?: string;
      /** A second schedule that only unlists replaced videos; off when not set. */
      unlist_replaced?: UnlistReplaced;
    }
  | { kind: "file" }
  | {
      kind: "results";
      /** A channel from the post list of channels.yml told when a check that passed in the previous run of the same environment fails, or the reverse; no alert when not set. */
      alert?: string;
    };

/** Where a pull request job with one branch per key reads the key: a top-level string field of the input (collect.ts) or of the answer. */
export interface BranchKey {
  from: "input" | "answer";
  field: string;
}

/**
 * The tidy runs of a youtube job: on schedule, a video the job's merged map
 * pull requests once recorded and the map no longer does is taken out of
 * playlists and set from public to unlisted. shadow only plans it.
 */
export interface UnlistReplaced {
  schedule: string;
  playlists: string[];
  mode: "shadow" | "live";
}

/** The levels Pi's --thinking takes, lowest first (Pi 0.87.1); schema/job.schema.json lists the same. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** The media stage: what media.ts may reach, which secrets it gets and how long it may run. */
export interface MediaStage {
  /** tailnet: the workflow joins the tailnet as tag:ci before the run. */
  network: string;
  /** Names from flax.yml agents.mediaSecrets. */
  secrets: string[];
  timeout_minutes: number;
  /** Globs of files a pull request job may change with bytes from this stage, never from the model; none when not set. */
  pr_paths?: string[];
  /** What the workflow installs before the run; nothing when not set. */
  setup?: MediaSetup[];
  /** notes-co repositories checked out read-only into media-sources/<name>. */
  sources?: MediaSource[];
  /** media.ts gets a contents-read token for every repository the reader app can see (FLAX_AGENTS_ORG_READ_TOKEN); off when not set. */
  org_read?: boolean;
  /** A short-lived gateway key for media.ts, served on a socket; none when not set. */
  model?: MediaModel;
  /** notes-co repositories media.ts reads through the GitHub API with a contents-read token of the reader app's, as GH_TOKEN; none when not set. */
  read_repos?: string[];
  /** notes-co repositories media.ts may start workflow runs in and read their runs and artifacts, with an actions-write token of the writer app's (FLAX_AGENTS_DISPATCH_TOKEN); none when not set. */
  dispatch_repos?: string[];
  /** Each part records in a workflow job of its own, in parallel, and one job after them delivers; one run of media.ts when not set. */
  parts?: MediaPart[];
  /** Build files inside the source checkouts kept between runs with the Actions cache; none when not set. */
  cache?: MediaCache[];
  /** Boolean workflow inputs for a run started by hand; the ticked ones reach media.ts (FLAX_AGENTS_MEDIA_INPUTS); none when not set. */
  inputs?: MediaInput[];
}

/** A boolean workflow input of a media stage: ticked for a run started by hand, it reaches media.ts. */
export interface MediaInput {
  name: string;
  description: string;
}

/** A string workflow input of a job with collect.ts: filled in for a run started by hand, it reaches collect.ts when it matches pattern. */
export interface CollectInput {
  name: string;
  description: string;
  /** A regular expression, anchored with ^ and $, every value must match. */
  pattern: string;
}

/** The workflow inputs the kit gives a job's workflow itself; a media input may not take one of these names. */
export const KIT_WORKFLOW_INPUTS: readonly string[] = [
  "model",
  "thinking",
  "revise",
  "review_model",
  "review_thinking",
  "replay_run",
  "media_model",
  "edition_heap",
  "unlist_only",
  "env",
  "reason",
];

/**
 * Directories of one media source's checkout that the workflow restores
 * before the run and saves after a successful one, keyed by the runner OS
 * and the contents of key_files.
 */
export interface MediaCache {
  /** A repository listed in the stage's sources. */
  source: string;
  /** Directories inside the checkout, globs allowed. */
  paths: string[];
  /** Files inside the checkout whose contents key the cache: a change to them starts it afresh. */
  key_files: string[];
}

/**
 * One part of a media stage split into parts: media.ts runs once per part
 * (FLAX_AGENTS_MEDIA_PART names it) in a workflow job of its own. What it
 * leaves out it takes from the stage; setup and sources add to the stage's.
 */
export interface MediaPart {
  /** The part's id, a scenario id for output kind youtube. */
  id: string;
  timeout_minutes?: number;
  network?: MediaStage["network"];
  /** A subset of the stage's secrets; all of them when not set. */
  secrets?: string[];
  setup?: MediaSetup[];
  sources?: MediaSource[];
  /** This part gets the stage's media.model key; no part does when not set. */
  model?: boolean;
  /** The workflow's edition_heap input reaches this part (FLAX_AGENTS_EDITION_HEAP); off when not set. */
  edition_heap?: boolean;
}

/** The stage one part runs as: its own limits, network, secrets and key, the stage's setup and sources plus its own. */
export function partStage(stage: MediaStage, part: MediaPart): MediaStage {
  const setup = new Set([...(stage.setup ?? []), ...(part.setup ?? [])]);
  const sources: MediaSource[] = [];
  for (const s of [...(stage.sources ?? []), ...(part.sources ?? [])])
    if (!sources.some((t) => mediaSourceRepo(t) === mediaSourceRepo(s)))
      sources.push(s);
  return {
    network: part.network ?? stage.network,
    secrets: part.secrets ?? stage.secrets,
    timeout_minutes: part.timeout_minutes ?? stage.timeout_minutes,
    ...(setup.size === 0
      ? {}
      : { setup: MEDIA_SETUP.filter((s) => setup.has(s)) }),
    ...(sources.length === 0 ? {} : { sources }),
    ...(stage.read_repos === undefined ? {} : { read_repos: stage.read_repos }),
    ...(stage.dispatch_repos === undefined
      ? {}
      : { dispatch_repos: stage.dispatch_repos }),
    ...(part.model === true && stage.model !== undefined
      ? { model: stage.model }
      : {}),
  };
}

/** The part of the job's media stage with this id, or undefined. */
export function mediaPart(
  job: { media?: MediaStage },
  id: string,
): MediaPart | undefined {
  return job.media?.parts?.find((p) => p.id === id);
}

/** The model media.ts may call through the runner, and what one run's key may spend. */
export interface MediaModel {
  /** A models.yml id. */
  model: string;
  /** Another models.yml id the same key and socket also serve, for media.ts to ask when model fails; none when not set. */
  fallback?: string;
  usd_per_run: number;
  /** Only for a job with model: none, which has no limits.usd_per_month. */
  usd_per_month?: number;
  /** When the month cannot hold usd_per_run, media.ts runs without the model instead of the run failing; off when not set. */
  optional?: boolean;
}

/**
 * A repository the media stage reads: owner/name, or an object whose
 * checkout also brings its submodules, naming the private ones the read
 * token must cover (public submodules need none).
 */
export type MediaSource = string | { repo: string; submodules: string[] };

/** The repository a media source checks out. */
export function mediaSourceRepo(s: MediaSource): string {
  return typeof s === "string" ? s : s.repo;
}

/** Every repository a media source's read token must cover. */
export function mediaSourceTokenRepos(s: MediaSource): string[] {
  return typeof s === "string" ? [s] : [s.repo, ...s.submodules];
}

/** The most a media stage's key may spend in one run. */
export const MEDIA_MODEL_MAX_USD = 2;

/** What a media stage may have installed, in the order the workflow installs it. */
export const MEDIA_SETUP = [
  "packages",
  "chromium",
  "notes-cli",
  "java",
  "ghcr",
] as const;
export type MediaSetup = (typeof MEDIA_SETUP)[number];

/** Where the workflow checks out a media stage's sources, from the workspace root. */
export const MEDIA_SOURCES_DIR = "media-sources";

/** The directory a media source repository is checked out in, from the workspace root. */
export function mediaSourceDir(repo: string): string {
  return `${MEDIA_SOURCES_DIR}/${repo.slice(repo.indexOf("/") + 1)}`;
}

/** The model of a job that runs no model: no box, no thinking level, no gateway key but its media stage's; the kit builds its answer. */
export const NO_MODEL = "none";

interface JobBase {
  name: string;
  owner: string;
  purpose: string;
  trigger: Trigger;
  tools: string[];
  /** Pi also gets its bash tool inside the box; off when not set. */
  shell?: boolean;
  /** Tools collect.ts may call; none when not set. */
  collect_tools?: string[];
  /** The model's gh-file reads each repository the input's `repos` names at the commit given there, unless a call names a ref; off when not set. */
  pin_files?: boolean;
  /** collect.ts keeps a ledger between runs (readLedger, writeLedger), kept as the job-<name>-ledger artifact; off when not set. */
  ledger?: boolean;
  /** String workflow inputs a person fills in when starting a run by hand; the filled ones reach collect.ts, which reads them with collectInputs(); none when not set. */
  collect_inputs?: CollectInput[];
  /** Values a person sets for collect.ts, which reads them with jobSettings(); none when not set. */
  settings?: Record<string, boolean | number | string>;
  /** Runs jobs/<name>/media.ts on the runner before collect.ts; none when not set. */
  media?: MediaStage;
  output: Output;
  mode: "shadow" | "live";
}

/** The workflow input value that leaves the model (or thinking level) to the job: collect.ts's choice, or the job's default. */
export const AUTO = "auto";

/** One model a job's collect.ts may choose for a run, with the thinking level it runs at. */
export interface ModelChoice {
  model: string;
  thinking: ThinkingLevel;
}

/** A job that runs a model in the box. */
export interface ModelJobConfig extends JobBase {
  model: string;
  thinking: ThinkingLevel;
  /**
   * The models collect.ts may choose between, each with its thinking level;
   * model and thinking are the default and one of them. None when not set:
   * every run uses model.
   */
  models?: ModelChoice[];
  limits: {
    turns: number;
    tokens_per_run: number;
    usd_per_month: number;
    tool_calls?: number;
    tool_seconds?: number;
    collect_tool_calls?: number;
  };
}

/** A job with model: none: no box, no model, no limits; the kit builds its answer (output kind youtube, output kind results, output kind file, or output kind pr with media.pr_paths). */
export interface NoModelJobConfig extends JobBase {
  model: typeof NO_MODEL;
  thinking?: undefined;
  limits?: undefined;
}

/** A job.yml that has passed schema/job.schema.json. */
export type JobConfig = ModelJobConfig | NoModelJobConfig;

export function usesModel(job: JobConfig): job is ModelJobConfig {
  return job.model !== NO_MODEL;
}

export function triggerAfter(job: JobConfig): string | undefined {
  return "after" in job.trigger ? job.trigger.after : undefined;
}

export const DEFAULT_TOOL_CALLS = 200;
export const DEFAULT_TOOL_SECONDS = 60;

export interface ToolLimits {
  /** Tool calls allowed in one run. */
  calls: number;
  /** Seconds one tool call may take. */
  seconds: number;
}

export function toolLimits(job: JobConfig): ToolLimits {
  return {
    calls: job.limits?.tool_calls ?? DEFAULT_TOOL_CALLS,
    seconds: job.limits?.tool_seconds ?? DEFAULT_TOOL_SECONDS,
  };
}

export const DEFAULT_COLLECT_TOOL_CALLS = 200;

/** The limits on the tool calls of collect.ts: its own call limit, the job's seconds per call. */
export function collectToolLimits(job: JobConfig): ToolLimits {
  return {
    calls: job.limits?.collect_tool_calls ?? DEFAULT_COLLECT_TOOL_CALLS,
    seconds: job.limits?.tool_seconds ?? DEFAULT_TOOL_SECONDS,
  };
}

/** Every tool the job names, for the model or for collect.ts, each once. */
export function allJobTools(job: JobConfig): string[] {
  return [...new Set([...job.tools, ...(job.collect_tools ?? [])])];
}

/** How long the second check of a pull request job's answer may run: one fresh model call in its own box. */
export const REVIEW_TIMEOUT_SECONDS = 600;

/** The seconds a run adds for the second check: only pull request jobs have one. */
export function reviewSeconds(job: { output?: Output }): number {
  return job.output?.kind === "pr" ? REVIEW_TIMEOUT_SECONDS : 0;
}

/** A job's monthly budget: its limits, or for a job with model: none, its media model's. */
export function monthlyBudgetUsd(job: JobConfig): number {
  return job.limits?.usd_per_month ?? job.media?.model?.usd_per_month ?? 0;
}

/** The minutes the media stage adds to a run: media.ts's own limit. */
export function mediaMinutes(job: { media?: MediaStage }): number {
  return job.media?.timeout_minutes ?? 0;
}

/** The workflow input a part with edition_heap reads: the edition's heap for this run, such as 8g. */
export const EDITION_HEAP_INPUT = "edition_heap";
/** What an edition heap may be: a number of megabytes or gigabytes, as java's -Xmx takes it. */
export const EDITION_HEAP = /^[1-9][0-9]{0,5}[mMgG]$/;
