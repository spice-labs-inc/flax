import { workspace } from "../lib/workspace.ts";
import { format } from "../lib/format.ts";
import { Document, Scalar, YAMLMap, YAMLSeq } from "yaml";
import type { Box } from "../lib/box.ts";
import { WRITER_SECRET_ENV } from "../deliver/github-writer.ts";
import { SLACK_POST_TOKEN_ENV } from "../deliver/slack-poster.ts";
import { YOUTUBE_SECRET_ENV } from "../deliver/youtube.ts";
import { resultsArtifact } from "../run-job/results-output.ts";
import { ledgerArtifact } from "../run-job/job-ledger.ts";
import { modelKeyEnv } from "../lib/gateway.ts";
import {
  allJobTools,
  AUTO,
  checkEnvs,
  jobEnvs,
  mediaMinutes,
  mediaSourceDir,
  mediaSourceRepo,
  mediaSourceTokenRepos,
  monthlyBudgetUsd,
  reviewSeconds,
  THINKING_LEVELS,
  usesModel,
  EDITION_HEAP_INPUT,
  partStage,
  type JobConfig,
  type MediaPart,
  type MediaCache,
  type MediaStage,
  type EnvSchedules,
  type ThinkingLevel,
  type UnlistReplaced,
} from "../lib/job.ts";
import {
  MAINTAINER_NOTES_FILE,
  notesArtifact,
} from "../lib/maintainer-notes.ts";
import {
  jobFile,
  JOBS_DIR,
  JOBS_INDEX,
  REVISE_POLL_BUNDLE,
  RUNNER_BUNDLE,
  WORKFLOWS_DIR,
} from "../lib/paths.ts";
import { byCodePoint } from "../lib/sort.ts";
import {
  MEDIA_DISPATCH_TOKEN_ENV,
  MEDIA_ORG_READ_ENV,
  MEDIA_READ_TOKEN_ENV,
  mediaPartArtifact,
} from "../lib/media.ts";
import {
  toolUpstreams,
  upstreamSecrets,
  type ToolEntry,
} from "../lib/tools.ts";

export function runnerLabels(): string[] {
  return workspace().runsOn;
}

/** A job that runs no model only reads files and delivers them, after its media stage. */
export const NO_MODEL_TIMEOUT_MINUTES = 30;

// Room for each model turn, the second check and the media stage plus setup, capped at GitHub's six-hour job limit.
export function timeoutMinutes(job: JobConfig): number {
  const media =
    mediaMinutes(job) +
    mediaSetupMinutes(job.media) +
    (joinsNetwork(job.media?.network) ? NETWORK_JOIN_MINUTES : 0);
  if (!usesModel(job)) return Math.min(360, NO_MODEL_TIMEOUT_MINUTES + media);
  return Math.min(
    360,
    10 + 2 * job.limits.turns + Math.ceil(reviewSeconds(job) / 60) + media,
  );
}

export function workflowName(job: string): string {
  return `job-${job}`;
}

export function workflowPath(job: string): string {
  return `${WORKFLOWS_DIR}/job-${job}.yml`;
}

export const GENERATED_WORKFLOW = /^job-([a-z][a-z0-9-]{1,40})\.yml$/;

/** The workflow that starts revision runs of live pull request jobs. */
export const REVISE_POLL_WORKFLOW = `${WORKFLOWS_DIR}/revise-poll.yml`;

/** Pull request jobs take a pull request to revise when started by hand or by the poller. */
export function revisable(job: JobConfig): boolean {
  return job.output.kind === "pr" && usesModel(job);
}

const REVISE_INPUT = {
  description:
    "A pull request to revise, owner/name#number; empty for a normal run",
  type: "string",
  required: false,
  default: "",
};

// Scheduled and chained runs have no inputs, so inputs.revise is null there, which equals '' in an expression.
export const REVISE_RUN_NAME =
  "${{ inputs.revise != '' && format('{0} revise {1}', github.workflow, inputs.revise) || github.workflow }}";

function triggers(
  job: JobConfig,
  models: readonly string[],
  thinkingLevels: readonly ThinkingLevel[],
  mediaModels: readonly string[] = [],
): Record<string, unknown> {
  const on: Record<string, unknown> = {};
  if ("schedule" in job.trigger) on.schedule = [{ cron: job.trigger.schedule }];
  if ("envs" in job.trigger) {
    const envs = job.trigger.envs;
    on.schedule = jobEnvs(job).map((e) => ({ cron: envs[e]! }));
  }
  const tidy = unlistReplaced(job);
  if (tidy !== undefined)
    on.schedule = [
      ...((on.schedule as { cron: string }[] | undefined) ?? []),
      { cron: tidy.schedule },
    ];
  if ("after" in job.trigger) {
    on.workflow_run = {
      workflows: [workflowName(job.trigger.after)],
      types: ["completed"],
      branches: ["main"],
    };
  }
  // A job with models lets collect.ts choose unless the run names a model.
  const chooses = usesModel(job) && job.models !== undefined;
  const inputs: Record<string, unknown> =
    models.length === 0
      ? {}
      : {
          model: {
            description: chooses
              ? `Model for this run (models.yml); ${AUTO} lets collect.ts choose`
              : "Model for this run (models.yml)",
            type: "choice",
            options: chooses ? [AUTO, ...models] : [...models],
            default: chooses ? AUTO : job.model,
          },
          thinking: {
            description: chooses
              ? `Thinking level for this run (Pi --thinking); ${AUTO} takes the chosen model's`
              : "Thinking level for this run (Pi --thinking)",
            type: "choice",
            options: [
              ...(chooses ? [AUTO] : []),
              ...THINKING_LEVELS.filter(
                (level) =>
                  thinkingLevels.includes(level) || level === job.thinking,
              ),
            ],
            default: chooses ? AUTO : job.thinking,
          },
        };
  if (revisable(job)) {
    inputs.revise = REVISE_INPUT;
    // A second check on another model, and a replay of an earlier run's input: the parity experiments.
    if (models.length > 0)
      inputs.review_model = {
        description: `Model for the second check (models.yml), of another family than the run's; ${AUTO} uses the job's own setting`,
        type: "choice",
        options: [AUTO, ...models],
        default: AUTO,
      };
    if (models.length > 0)
      inputs.review_thinking = {
        description: `Thinking level for the second check; ${AUTO} takes review_model's own`,
        type: "choice",
        options: [
          AUTO,
          ...THINKING_LEVELS.filter((level) => thinkingLevels.includes(level)),
        ],
        default: AUTO,
      };
    inputs.replay_run = REPLAY_INPUT;
  }
  const mediaModel = job.media?.model?.model;
  if (mediaModel !== undefined && mediaModels.length > 0)
    inputs[MEDIA_MODEL_INPUT] = {
      description: "Model for the media stage this run (models.yml)",
      type: "choice",
      options: [...mediaModels],
      default: mediaModel,
    };
  if (job.media?.parts?.some((p) => p.edition_heap === true))
    inputs[EDITION_HEAP_INPUT] = EDITION_HEAP_DISPATCH_INPUT;
  for (const input of job.media?.inputs ?? [])
    inputs[input.name] = {
      description: input.description,
      type: "boolean",
      default: false,
    };
  for (const input of job.collect_inputs ?? [])
    inputs[input.name] = {
      description: input.description,
      type: "string",
      required: false,
      default: "",
    };
  if (tidy !== undefined)
    inputs[UNLIST_ONLY_INPUT] = UNLIST_ONLY_DISPATCH_INPUT;
  if ("envs" in job.trigger) {
    const envs = jobEnvs(job);
    inputs[ENV_INPUT] = {
      description: "The environment this run checks",
      type: "choice",
      options: envs,
      default: envs[0],
      required: true,
    };
    inputs[REASON_INPUT] = REASON_DISPATCH_INPUT;
  }
  on.workflow_dispatch = Object.keys(inputs).length === 0 ? {} : { inputs };
  return on;
}

export const ENV_INPUT = "env";
export const REASON_INPUT = "reason";
const REASON_DISPATCH_INPUT = {
  description:
    "Why this run, such as the deploy it follows (one line of printable ASCII); empty for a run by hand",
  type: "string",
  required: false,
  default: "",
};

/**
 * The environment a run of a job with trigger.envs checks: the env input
 * of a run started by hand (or through the API by another repository's
 * workflow), otherwise the environment whose cron fired. Scheduled runs
 * have no inputs; a cron that matches none gives an empty value, which
 * run-job refuses.
 */
export function targetEnvExpression(envs: EnvSchedules): string {
  const crons = checkEnvs()
    .filter((e) => envs[e] !== undefined)
    .map((e) => `(github.event.schedule == '${envs[e]}' && '${e}')`);
  return `inputs.${ENV_INPUT} || ${crons.join(" || ")} || ''`;
}

export const PREVIOUS_RESULTS_DIR = "previous-results";
export const RESULTS_DIR = "results";
export const FIND_PREVIOUS_STEP = "Find the previous results";
export const DOWNLOAD_PREVIOUS_STEP = "Download the previous results";
export const KEEP_RESULTS_STEP = "Keep the results";

/** A check job's results artifact in the workflow: one per environment, shadow runs under names of their own. */
export function resultsArtifactName(job: JobConfig): string {
  if (!("envs" in job.trigger))
    throw new Error(`${job.name} has no trigger.envs`);
  return resultsArtifact(
    job.name,
    job.mode,
    `\${{ ${targetEnvExpression(job.trigger.envs)} }}`,
  );
}

/**
 * Before a check job's run: the runner finds the run with the
 * environment's newest results artifact, other than this one, with the
 * workflow's own token (actions: read), and the download action fetches it
 * for the run to compare with. No run found, no download: the run then
 * compares with nothing.
 */
function previousResultsSteps(
  job: JobConfig,
  targetEnv: Record<string, string>,
): Record<string, unknown>[] {
  return [
    {
      name: FIND_PREVIOUS_STEP,
      id: "previous",
      env: { GH_TOKEN: "${{ github.token }}", ...targetEnv },
      run: `${RUNNER} ${job.name} --env "$RUN_ENV" --find-previous`,
    },
    {
      name: DOWNLOAD_PREVIOUS_STEP,
      if: "${{ steps.previous.outputs.run_id != '' }}",
      uses: "actions/download-artifact@v4",
      with: {
        name: resultsArtifactName(job),
        "run-id": "${{ steps.previous.outputs.run_id }}",
        "github-token": "${{ github.token }}",
        path: `\${{ runner.temp }}/${PREVIOUS_RESULTS_DIR}`,
      },
    },
  ];
}

/** A youtube job's unlist_replaced, when it has one. */
function unlistReplaced(job: JobConfig): UnlistReplaced | undefined {
  return job.output.kind === "youtube" ? job.output.unlist_replaced : undefined;
}

export const UNLIST_ONLY_INPUT = "unlist_only";
export const UNLIST_STEP = "Unlist the replaced videos";
const UNLIST_ONLY_DISPATCH_INPUT = {
  description:
    "Record and upload nothing; only take replaced videos out of the playlists and unlist them",
  type: "boolean",
  default: false,
};

/** True in a tidy run: the unlist_replaced schedule fired, or a person asked for one. Scheduled runs have no inputs, and null is not true. */
export function tidyRunExpression(tidy: UnlistReplaced): string {
  return `github.event.schedule == '${tidy.schedule}' || inputs.${UNLIST_ONLY_INPUT} == true`;
}

const MEDIA_MODEL_INPUT = "media_model";

/** The run step's variable a collect input's value reaches it in. */
export function collectInputEnv(name: string): string {
  return `RUN_COLLECT_INPUT_${name.toUpperCase()}`;
}

/** The run step's variable a media input's value reaches it in. */
export function mediaInputEnv(name: string): string {
  return `RUN_MEDIA_INPUT_${name.toUpperCase()}`;
}

const EDITION_HEAP_DISPATCH_INPUT = {
  description:
    "Heap of the edition run for this run, such as 8g or 4096m; empty for the scenario's own",
  type: "string",
  required: false,
  default: "",
};

export function boxRepository(): string {
  return workspace().sandbox.repo;
}

/** The step of a model job workflow that calls the kit's action: preflight, image pull, the lbx release binary checked against box.yml and put on PATH, the run. */
export const KIT_ACTION_STEP = "Run the job with the kit";

export const REPORT_DIR = "job-output";

export function reportArtifact(job: string): string {
  return `job-${job}-report`;
}

export const REPORT_RETENTION_DAYS = 90;

export const PREVIOUS_LEDGER_DIR = "previous-ledger";
export const LEDGER_DIR = "ledger";
export const FIND_LEDGER_STEP = "Find the previous ledger";
export const DOWNLOAD_LEDGER_STEP = "Download the previous ledger";
export const KEEP_LEDGER_STEP = "Keep the ledger";
/** The run step's flags for a job with a ledger: where the workflow downloaded the previous one, and where the next goes for upload. */
const LEDGER_FLAGS = ` --ledger-in "$RUNNER_TEMP/${PREVIOUS_LEDGER_DIR}" --ledger-out "$RUNNER_TEMP/${LEDGER_DIR}"`;

/**
 * Before a run of a job with a ledger: the runner finds the run with the
 * newest ledger artifact, other than this one, with the workflow's own
 * token (actions: read), and the download action fetches it for
 * collect.ts. No run found, no download: collect.ts starts with none.
 */
function ledgerSteps(job: JobConfig): Record<string, unknown>[] {
  return [
    {
      name: FIND_LEDGER_STEP,
      id: "ledger",
      env: { GH_TOKEN: "${{ github.token }}" },
      run: `${RUNNER} ${job.name} --find-ledger`,
    },
    {
      name: DOWNLOAD_LEDGER_STEP,
      if: "${{ steps.ledger.outputs.run_id != '' }}",
      uses: "actions/download-artifact@v4",
      with: {
        name: ledgerArtifact(job.name),
        "run-id": "${{ steps.ledger.outputs.run_id }}",
        "github-token": "${{ github.token }}",
        path: `\${{ runner.temp }}/${PREVIOUS_LEDGER_DIR}`,
      },
    },
  ];
}

/** After a run of a job with a ledger, whatever happened: the ledger collect.ts wrote, for the next run. */
function keepLedgerStep(job: JobConfig): Record<string, unknown> {
  return {
    name: KEEP_LEDGER_STEP,
    if: "always()",
    uses: "actions/upload-artifact@v4",
    with: {
      name: ledgerArtifact(job.name),
      path: `\${{ runner.temp }}/${LEDGER_DIR}/`,
      "retention-days": REPORT_RETENTION_DAYS,
      "if-no-files-found": "ignore",
    },
  };
}

/** The secrets the job's tools need, for the model and for collect.ts: only those of the upstreams they read from. */
export function jobToolSecrets(
  job: JobConfig,
  tools: readonly ToolEntry[],
): string[] {
  return upstreamSecrets(toolUpstreams(tools, allJobTools(job)));
}

function secretEnv(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => [name, `\${{ secrets.${name} }}`]),
  );
}

// The committed bundle: no install and no tsx before the steps that run it.
const RUNNER = `node ${RUNNER_BUNDLE}`;

// Scheduled and chained runs have no inputs, so the model and level are empty and run-job uses the job's own.
const MODEL_INPUT = {
  RUN_MODEL: "${{ inputs.model }}",
  RUN_THINKING: "${{ inputs.thinking }}",
};

const REVISE_INPUT_ENV = {
  RUN_REVISE: "${{ inputs.revise }}",
  RUN_REVIEW_MODEL: "${{ inputs.review_model }}",
  RUN_REVIEW_THINKING: "${{ inputs.review_thinking }}",
  RUN_REPLAY: "${{ inputs.replay_run }}",
};
const REVISE_FLAG =
  ' ${RUN_REVISE:+--revise "$RUN_REVISE"} --review-model "$RUN_REVIEW_MODEL" --review-thinking "$RUN_REVIEW_THINKING" ${RUN_REPLAY:+--replay "$RUN_REPLAY"}';

const REPLAY_INPUT = {
  description:
    "An earlier run id whose input to run again (shadow only): the same input for another model; empty for a normal run",
  type: "string",
  required: false,
  default: "",
};

/** What a live pull request job's revision run reads the original run's report artifact with. */
export const REVISION_READ_SECRETS = [
  "AGENTS_READER_APP_ID",
  "AGENTS_READER_PRIVATE_KEY",
];

const CHECKOUT = {
  uses: "actions/checkout@v5",
  with: { "persist-credentials": false },
};
const SETUP_NODE = {
  uses: "actions/setup-node@v6",
  with: { "node-version": 24 },
};

// Joining a network takes up to a few minutes.
const NETWORK_JOIN_MINUTES = 5;

/** A network name other than public: a join from flax.yml agents.networkJoins. */
export function joinsNetwork(network: string | undefined): boolean {
  return network !== undefined && network !== "public";
}

function networkJoin(network: string): Record<string, unknown>[] {
  const join = workspace().networkJoins[network];
  if (join === undefined)
    throw new Error(
      `network "${network}" is not in flax.yml agents.networkJoins`,
    );
  return join.join.map((s) => ({ ...s }));
}

/** Leaves at once on every path, so the network is gone before the report uploads. */
function networkLeave(network: string): Record<string, unknown>[] {
  const join = workspace().networkJoins[network];
  return (join?.leave ?? []).map((s) => ({ ...s, if: s.if ?? "always()" }));
}

// Installing packages, a browser, the CLI and a JDK, and checking out sources, took under ten minutes together.
const MEDIA_SETUP_MINUTES = 10;

function mediaSetupMinutes(stage: MediaStage | undefined): number {
  return (stage?.setup?.length ?? 0) + (stage?.sources?.length ?? 0) > 0
    ? MEDIA_SETUP_MINUTES
    : 0;
}

export const MEDIA_SOURCES_TOKEN_STEP =
  "Make a read token for the media sources";

/** The step before the package install when the @flax packages come from a private repository. */
export const PACKAGES_TOKEN_STEP = "Read the private framework packages";
/** Before it, with agents.packagesTokenApp: the app's contents-read token for those repositories. */
export const PACKAGES_APP_TOKEN_STEP =
  "Make a read token for the framework packages";
/** git sends the token for every github.com clone this job makes; pnpm clones the @flax package tags with git. */
export const PACKAGES_TOKEN_RUN =
  'git config --global url."https://x-access-token:${PACKAGES_TOKEN}@github.com/".insteadOf "https://github.com/"';

function packagesTokenSteps(): Record<string, unknown>[] {
  const { packagesTokenSecret: secret, packagesTokenApp: app } = workspace();
  const gitConfig = (token: string) => ({
    name: PACKAGES_TOKEN_STEP,
    env: { PACKAGES_TOKEN: token },
    run: PACKAGES_TOKEN_RUN,
  });
  if (secret !== undefined) return [gitConfig(`\${{ secrets.${secret} }}`)];
  if (app === undefined) return [];
  return [
    {
      name: PACKAGES_APP_TOKEN_STEP,
      id: "packages-token",
      uses: APP_TOKEN_ACTION,
      with: {
        "app-id": `\${{ secrets.${app.appIdSecret} }}`,
        "private-key": `\${{ secrets.${app.privateKeySecret} }}`,
        owner: app.repositories[0]!.split("/")[0],
        repositories: app.repositories
          .map((r) => r.slice(r.indexOf("/") + 1))
          .join(","),
        "permission-contents": "read",
      },
    },
    gitConfig("${{ steps.packages-token.outputs.token }}"),
  ];
}

/**
 * The steps that install what media.ts needs, before the run and before the
 * tailnet join. None of them gets a secret but the sources token step,
 * which turns the reader app into a contents-read token for those
 * repositories alone; the checkouts keep no credentials.
 */
export function mediaSetupSteps(
  job: JobConfig,
  stage: MediaStage | undefined = job.media,
): Record<string, unknown>[] {
  const setup = new Set(stage?.setup ?? []);
  const sources = stage?.sources ?? [];
  const out: Record<string, unknown>[] = [];
  if (setup.has("packages")) {
    out.push({ name: "Set up pnpm", uses: PNPM_ACTION });
    out.push(...packagesTokenSteps());
    out.push({
      name: "Install the locked packages",
      run: "pnpm install --frozen-lockfile",
    });
  }
  if (setup.has("chromium"))
    out.push({
      name: "Install Chromium for Playwright",
      run: "pnpm exec playwright install --with-deps chromium",
    });
  if (setup.has("java"))
    out.push(
      {
        name: "Set up JDK 21",
        uses: SETUP_JAVA_ACTION,
        with: { distribution: "temurin", "java-version": "21" },
      },
      {
        name: "Make sure Maven is installed",
        run: "command -v mvn || (sudo apt-get update -q && sudo apt-get install -y -q maven)",
      },
    );
  // Any other name is a setup from flax.yml agents.setupSteps.
  const builtIn = new Set(["packages", "chromium", "java", "ghcr"]);
  for (const name of stage?.setup ?? []) {
    if (builtIn.has(name)) continue;
    const steps = workspace().setupSteps[name];
    if (steps === undefined)
      throw new Error(`setup "${name}" is not in flax.yml agents.setupSteps`);
    out.push(...steps.map((s) => ({ ...s })));
  }
  // A job that runs a model already logs in to pull its box image.
  if (setup.has("ghcr") && !usesModel(job))
    out.push({
      name: "Log in to ghcr.io",
      uses: "docker/login-action@v3",
      with: {
        registry: "ghcr.io",
        username: "${{ github.actor }}",
        password: "${{ secrets.GITHUB_TOKEN }}",
      },
    });
  if (sources.length > 0) {
    const [appId, key] = REVISION_READ_SECRETS;
    out.push({
      name: MEDIA_SOURCES_TOKEN_STEP,
      id: "media-sources-token",
      uses: APP_TOKEN_ACTION,
      with: {
        "app-id": `\${{ secrets.${appId} }}`,
        "private-key": `\${{ secrets.${key} }}`,
        owner: workspace().github,
        repositories: [...new Set(sources.flatMap(mediaSourceTokenRepos))]
          .map((r) => r.slice(r.indexOf("/") + 1))
          .join(","),
        "permission-contents": "read",
      },
    });
    for (const source of sources) {
      const repo = mediaSourceRepo(source);
      out.push({
        name: `Check out ${repo}`,
        uses: "actions/checkout@v5",
        with: {
          repository: repo,
          token: "${{ steps.media-sources-token.outputs.token }}",
          path: mediaSourceDir(repo),
          ...(typeof source === "string" ? {} : { submodules: "recursive" }),
          "persist-credentials": false,
        },
      });
    }
  }
  return out;
}

export const CACHE_RESTORE_ACTION = "actions/cache/restore@v5";
export const CACHE_SAVE_ACTION = "actions/cache/save@v5";

function cacheStepId(i: number): string {
  return `media-cache-${i}`;
}

function cachePaths(entry: MediaCache): string[] {
  return entry.paths.map((p) => `${mediaSourceDir(entry.source)}/${p}`);
}

/** Every file under each path, as hashFiles arguments. */
function hashFilesArgs(paths: readonly string[]): string {
  return paths.map((p) => `'${p}/**'`).join(", ");
}

/**
 * Restores each media.cache entry once its source is checked out: the
 * newest cache saved under the job, the runner OS and the key files'
 * contents. Every save adds the hash of what it holds to that key, so a
 * run restores the latest complete build and a cache that missed files
 * is replaced rather than kept for good.
 */
export function mediaCacheRestoreSteps(
  job: JobConfig,
): Record<string, unknown>[] {
  return (job.media?.cache ?? []).map((entry, i) => {
    const keyFiles = entry.key_files
      .map((f) => `'${mediaSourceDir(entry.source)}/${f}'`)
      .join(", ");
    const key = `media-${job.name}-${i}-\${{ runner.os }}-\${{ hashFiles(${keyFiles}) }}`;
    return {
      name: `Restore the ${entry.source} build cache`,
      id: cacheStepId(i),
      uses: CACHE_RESTORE_ACTION,
      with: {
        path: cachePaths(entry).join("\n"),
        key,
        "restore-keys": `${key}-`,
      },
    };
  });
}

/** After a successful run, saves each media.cache entry whose paths hold files that differ from what was restored. */
export function mediaCacheSaveSteps(job: JobConfig): Record<string, unknown>[] {
  return (job.media?.cache ?? []).map((entry, i) => {
    const step = `steps.${cacheStepId(i)}.outputs`;
    const hash = `hashFiles(${hashFilesArgs(cachePaths(entry))})`;
    return {
      name: `Save the ${entry.source} build cache`,
      if: `success() && ${hash} != '' && ${step}.cache-matched-key != format('{0}-{1}', ${step}.cache-primary-key, ${hash})`,
      uses: CACHE_SAVE_ACTION,
      with: {
        path: cachePaths(entry).join("\n"),
        key: `\${{ ${step}.cache-primary-key }}-\${{ ${hash} }}`,
      },
    };
  });
}

export const MEDIA_READ_TOKEN_STEP = "Make a read token for media.ts";
export const MEDIA_DISPATCH_TOKEN_STEP =
  "Make a workflow dispatch token for media.ts";

/**
 * For a stage with read_repos: the reader app's contents-read token for
 * those repositories alone, made just before the run because it lives an
 * hour. Only the run step gets it, and the runner hands it to media.ts
 * alone, as GH_TOKEN.
 * For a stage with dispatch_repos: the writer app's actions-write token
 * for those repositories alone, made and handed over the same way, as
 * FLAX_AGENTS_DISPATCH_TOKEN.
 */
function mediaReadTokenSteps(
  stage: MediaStage | undefined,
): Record<string, unknown>[] {
  const repos = stage?.read_repos ?? [];
  const [appId, key] = REVISION_READ_SECRETS;
  const out: Record<string, unknown>[] = [];
  if (repos.length > 0)
    out.push({
      name: MEDIA_READ_TOKEN_STEP,
      id: "media-read-token",
      uses: APP_TOKEN_ACTION,
      with: {
        "app-id": `\${{ secrets.${appId} }}`,
        "private-key": `\${{ secrets.${key} }}`,
        owner: workspace().github,
        repositories: repos.map((r) => r.slice(r.indexOf("/") + 1)).join(","),
        "permission-contents": "read",
      },
    });
  const dispatch = stage?.dispatch_repos ?? [];
  if (dispatch.length > 0) {
    const [writerId, writerKey] = WRITER_SECRET_ENV;
    out.push({
      name: MEDIA_DISPATCH_TOKEN_STEP,
      id: "media-dispatch-token",
      uses: APP_TOKEN_ACTION,
      with: {
        "app-id": `\${{ secrets.${writerId} }}`,
        "private-key": `\${{ secrets.${writerKey} }}`,
        owner: workspace().github,
        repositories: dispatch
          .map((r) => r.slice(r.indexOf("/") + 1))
          .join(","),
        "permission-actions": "write",
      },
    });
  }
  // No repositories listed: the token covers every repository the reader app can see, contents read only.
  if (stage?.org_read === true)
    out.push({
      name: MEDIA_ORG_READ_TOKEN_STEP,
      id: "media-org-read-token",
      uses: APP_TOKEN_ACTION,
      with: {
        "app-id": `\${{ secrets.${appId} }}`,
        "private-key": `\${{ secrets.${key} }}`,
        owner: workspace().github,
        "permission-contents": "read",
      },
    });
  return out;
}

function mediaReadTokenEnv(
  stage: MediaStage | undefined,
): Record<string, string> {
  return {
    ...((stage?.read_repos ?? []).length === 0
      ? {}
      : {
          [MEDIA_READ_TOKEN_ENV]: "${{ steps.media-read-token.outputs.token }}",
        }),
    ...((stage?.dispatch_repos ?? []).length === 0
      ? {}
      : {
          [MEDIA_DISPATCH_TOKEN_ENV]:
            "${{ steps.media-dispatch-token.outputs.token }}",
        }),
    ...(stage?.org_read === true
      ? {
          [MEDIA_ORG_READ_ENV]:
            "${{ steps.media-org-read-token.outputs.token }}",
        }
      : {}),
  };
}

export const MEDIA_ORG_READ_TOKEN_STEP =
  "Make a read token for every repository";

export const PNPM_ACTION = "pnpm/action-setup@v6";
export const SETUP_JAVA_ACTION = "actions/setup-java@v5";
export const APP_TOKEN_ACTION = "actions/create-github-app-token@v2";

/**
 * The delivery secrets: the writer app's for a live pull request job and
 * the posting token for one with notify, the posting token for a slack job
 * (a shadow run posts to the shadow channel),
 * for a youtube job the reader app's (every run reads the map file), the
 * posting token when it posts a notice (a shadow run posts one line to the
 * shadow channel) and, live, the YouTube grant and the writer app's; none
 * otherwise.
 */
export function deliverySecrets(job: JobConfig): string[] {
  const output = job.output;
  if (output.kind === "slack") return [SLACK_POST_TOKEN_ENV];
  if (output.kind === "youtube")
    return [
      ...REVISION_READ_SECRETS,
      ...(job.mode === "live"
        ? [...YOUTUBE_SECRET_ENV, ...WRITER_SECRET_ENV]
        : []),
      ...(output.notify === undefined ? [] : [SLACK_POST_TOKEN_ENV]),
    ];
  // A check job's shadow runs post their alerts to the shadow channel.
  if (output.kind === "results")
    return output.alert === undefined ? [] : [SLACK_POST_TOKEN_ENV];
  // A pull request job's shadow runs post their notice to the shadow channel.
  if (output.kind === "pr")
    return [
      ...(job.mode === "live" ? WRITER_SECRET_ENV : []),
      ...(output.notify === undefined ? [] : [SLACK_POST_TOKEN_ENV]),
    ];
  return [];
}

/** A tidy run's secrets: the reader app's for the map and its pull requests and, in a live job, the YouTube grant and the posting token when it posts a notice. No writer: it opens no pull request. */
export function tidySecrets(job: JobConfig): string[] {
  const output = job.output;
  if (output.kind !== "youtube") return [];
  return [
    ...REVISION_READ_SECRETS,
    ...(job.mode === "live"
      ? [
          ...YOUTUBE_SECRET_ENV,
          ...(output.notify === undefined ? [] : [SLACK_POST_TOKEN_ENV]),
        ]
      : []),
  ];
}

function steps(
  job: JobConfig,
  box: Box,
  tools: readonly ToolEntry[],
  models: readonly string[],
  pickMediaModel = false,
): Record<string, unknown>[] {
  if (!usesModel(job)) return noModelSteps(job, tools, pickMediaModel);
  const pick = models.length > 0;
  const modelFlag = pick
    ? ' --model "$RUN_MODEL" --thinking "$RUN_THINKING"'
    : "";
  const network = job.media?.network;
  const revise = revisable(job);
  // Scheduled runs have no inputs: each value is empty, which leaves the input out.
  const collectInputs = job.collect_inputs ?? [];
  const collectEnv = Object.fromEntries(
    collectInputs.map((i) => [
      collectInputEnv(i.name),
      `\${{ inputs.${i.name} }}`,
    ]),
  );
  const collectFlags = collectInputs
    .map((i) => ` --collect-input "${i.name}=$${collectInputEnv(i.name)}"`)
    .join("");
  return [
    { ...CHECKOUT },
    { ...SETUP_NODE },
    // Fails before any image is pulled when the tree is invalid or the box is not pinned yet.
    {
      name: "Check the job and the pinned box",
      ...(pick ? { env: { ...MODEL_INPUT } } : {}),
      run: `${RUNNER} ${job.name} --preflight${modelFlag}`,
    },
    // The image pull, the sandbox checkout and release check, lbx on PATH and the run itself are the kit action's.
    ...(job.ledger === true ? ledgerSteps(job) : []),
    ...mediaSetupSteps(job),
    ...mediaCacheRestoreSteps(job),
    ...(joinsNetwork(network) ? networkJoin(network!) : []),
    ...mediaReadTokenSteps(job.media),
    {
      name: KIT_ACTION_STEP,
      uses: workspace().kitAction,
      with: {
        job: job.name,
        workspace: ".",
        "box-image": box.image,
        "box-repository": boxRepository(),
        "box-release": box.box_release,
        "box-sha256": box.lbx_sha256,
        ...(workspace().provider.plugin === undefined
          ? {}
          : { "provider-plugin": workspace().provider.plugin }),
        ...(workspace().sandbox.tokenSecret === undefined
          ? {}
          : {
              "box-token": `\${{ secrets.${workspace().sandbox.tokenSecret} }}`,
            }),
        args: `${modelFlag} --out "$RUNNER_TEMP/${REPORT_DIR}"${revise ? REVISE_FLAG : ""}${collectFlags}${job.ledger === true ? LEDGER_FLAGS : ""}`.trim(),
      },
      // The gateway issuer key, the tool credentials and the media secrets stay with the runner process; the box gets none.
      env: {
        ...secretEnv([
          ...new Set([
            modelKeyEnv(),
            ...jobToolSecrets(job, tools),
            ...deliverySecrets(job),
            // Live revisions and replays (any mode) read an earlier run's report with the reader app.
            ...(revise ? REVISION_READ_SECRETS : []),
            ...(job.media?.secrets ?? []),
          ]),
        ]),
        ...mediaReadTokenEnv(job.media),
        ...(pick ? MODEL_INPUT : {}),
        ...(revise ? REVISE_INPUT_ENV : {}),
        ...collectEnv,
      },
    },
    ...(joinsNetwork(network) ? networkLeave(network!) : []),
    ...mediaCacheSaveSteps(job),
    ...(job.ledger === true ? [keepLedgerStep(job)] : []),
    {
      name: "Keep the report",
      if: "always()",
      uses: "actions/upload-artifact@v4",
      with: {
        name: reportArtifact(job.name),
        path: `\${{ runner.temp }}/${REPORT_DIR}/`,
        "retention-days": REPORT_RETENTION_DAYS,
        "if-no-files-found": "ignore",
      },
    },
    // The notes again on their own, so a summary can read them without downloading whole reports.
    {
      name: "Keep the maintainer notes",
      if: "always()",
      uses: "actions/upload-artifact@v4",
      with: {
        name: notesArtifact(job.name),
        path: `\${{ runner.temp }}/${REPORT_DIR}/${MAINTAINER_NOTES_FILE}`,
        "retention-days": REPORT_RETENTION_DAYS,
        "if-no-files-found": "ignore",
      },
    },
  ];
}

/** A job that runs no model: no image, no box and no lbx; only the run step gets secrets, the gateway issuer key only when media.model asks the runner for a media key. */
function noModelSteps(
  job: JobConfig,
  tools: readonly ToolEntry[],
  pickMediaModel: boolean,
): Record<string, unknown>[] {
  // Scheduled runs have no inputs: the flag is empty and the run uses media.model.
  const mediaEnv = pickMediaModel
    ? { RUN_MEDIA_MODEL: `\${{ inputs.${MEDIA_MODEL_INPUT} }}` }
    : {};
  const mediaFlag = pickMediaModel ? ' --media-model "$RUN_MEDIA_MODEL"' : "";
  // Scheduled runs have no inputs: each value is empty, which leaves the input off.
  const inputs = job.media?.inputs ?? [];
  const inputEnv = Object.fromEntries(
    inputs.map((i) => [mediaInputEnv(i.name), `\${{ inputs.${i.name} }}`]),
  );
  const inputFlags = inputs
    .map((i) => ` --media-input "${i.name}=$${mediaInputEnv(i.name)}"`)
    .join("");
  const network = job.media?.network;
  const checks = "envs" in job.trigger ? job.trigger.envs : undefined;
  const targetEnv =
    checks === undefined
      ? {}
      : { RUN_ENV: `\${{ ${targetEnvExpression(checks)} }}` };
  const targetFlag = checks === undefined ? "" : ' --env "$RUN_ENV"';
  const reasonEnv =
    checks === undefined
      ? {}
      : { RUN_REASON: `\${{ inputs.${REASON_INPUT} }}` };
  const reasonFlag =
    checks === undefined ? "" : ' ${RUN_REASON:+--reason "$RUN_REASON"}';
  const checkEnv = { ...mediaEnv, ...targetEnv };
  const resultsFlags =
    checks === undefined
      ? ""
      : ` --previous "$RUNNER_TEMP/${PREVIOUS_RESULTS_DIR}" --results-out "$RUNNER_TEMP/${RESULTS_DIR}"`;
  return [
    { ...CHECKOUT },
    { ...SETUP_NODE },
    {
      name: "Check the job",
      ...(Object.keys(checkEnv).length > 0 ? { env: checkEnv } : {}),
      run: `${RUNNER} ${job.name} --preflight${mediaFlag}${targetFlag}`,
    },
    ...(checks === undefined ? [] : previousResultsSteps(job, targetEnv)),
    ...mediaSetupSteps(job),
    ...mediaCacheRestoreSteps(job),
    ...(joinsNetwork(network) ? networkJoin(network!) : []),
    ...mediaReadTokenSteps(job.media),
    {
      name: "Run the job",
      env: {
        ...secretEnv([
          ...new Set([
            ...(job.media?.model === undefined ? [] : [modelKeyEnv()]),
            ...jobToolSecrets(job, tools),
            ...deliverySecrets(job),
            ...(job.media?.secrets ?? []),
          ]),
        ]),
        ...mediaReadTokenEnv(job.media),
        ...mediaEnv,
        ...inputEnv,
        ...targetEnv,
        ...reasonEnv,
      },
      run: `${RUNNER} ${job.name} --out "$RUNNER_TEMP/${REPORT_DIR}"${mediaFlag}${inputFlags}${targetFlag}${reasonFlag}${resultsFlags}`,
    },
    ...(joinsNetwork(network) ? networkLeave(network!) : []),
    ...mediaCacheSaveSteps(job),
    ...(checks === undefined
      ? []
      : [
          {
            name: KEEP_RESULTS_STEP,
            if: "always()",
            uses: "actions/upload-artifact@v4",
            with: {
              name: resultsArtifactName(job),
              path: `\${{ runner.temp }}/${RESULTS_DIR}/`,
              "retention-days": REPORT_RETENTION_DAYS,
              "if-no-files-found": "ignore",
              overwrite: true,
            },
          },
        ]),
    {
      name: "Keep the report",
      if: "always()",
      uses: "actions/upload-artifact@v4",
      with: {
        name: reportArtifact(job.name),
        path: `\${{ runner.temp }}/${REPORT_DIR}/`,
        "retention-days": REPORT_RETENTION_DAYS,
        "if-no-files-found": "ignore",
      },
    },
  ];
}

/** The workflow job that records one part of a stage split into parts. */
export function partJobId(part: string): string {
  return `media-${part}`;
}

/** The job after the parts that merges their media and delivers once. */
export const DELIVER_JOB = "deliver";

/** A part's own report; the delivery job's is the job's report. */
export function partReportArtifact(job: string, part: string): string {
  return `job-${job}-report-${part}`;
}

export const MEDIA_PARTS_DIR = "media-parts";
export const MEDIA_PART_DIR = "media-part";
// The delivery job reads the media within the week; the reports keep what a reviewer needs.
const MEDIA_PART_RETENTION_DAYS = 7;

// Room for the runner's own start and the copying of the media around media.ts.
const PART_RUN_MINUTES = 10;

/** Minutes a part's job may run: its media.ts, its setup and the tailnet join, and the runner around them. */
export function partTimeoutMinutes(stage: MediaStage): number {
  return Math.min(
    360,
    PART_RUN_MINUTES +
      stage.timeout_minutes +
      mediaSetupMinutes(stage) +
      (joinsNetwork(stage.network) ? NETWORK_JOIN_MINUTES : 0),
  );
}

/**
 * One part's job on the agents pool: its own setup and sources, the
 * tailnet only when the part reaches it, and only its own secrets in the
 * run step (the gateway issuer key only for a part with model: true). It
 * delivers nothing; its media (or why there are none) go up for the
 * delivery job.
 */
function partJob(
  job: JobConfig,
  part: MediaPart,
  tools: readonly ToolEntry[],
): Record<string, unknown> {
  const stage = partStage(job.media!, part);
  const network = stage.network;
  const heap = part.edition_heap === true;
  return {
    "runs-on": runnerLabels(),
    "timeout-minutes": partTimeoutMinutes(stage),
    permissions: { contents: "read", packages: "read" },
    steps: [
      { ...CHECKOUT },
      { ...SETUP_NODE },
      {
        name: "Check the job",
        run: `${RUNNER} ${job.name} --part ${part.id} --preflight`,
      },
      ...mediaSetupSteps(job, stage),
      ...(joinsNetwork(network) ? networkJoin(network!) : []),
      ...mediaReadTokenSteps(stage),
      {
        name: "Run the job",
        env: {
          ...secretEnv([
            ...new Set([
              ...(stage.model === undefined ? [] : [modelKeyEnv()]),
              ...jobToolSecrets(job, tools),
              ...stage.secrets,
            ]),
          ]),
          ...mediaReadTokenEnv(stage),
          ...(heap
            ? { RUN_EDITION_HEAP: `\${{ inputs.${EDITION_HEAP_INPUT} }}` }
            : {}),
        },
        run: `${RUNNER} ${job.name} --part ${part.id} --out "$RUNNER_TEMP/${REPORT_DIR}" --media-out "$RUNNER_TEMP/${MEDIA_PART_DIR}"${heap ? ' ${RUN_EDITION_HEAP:+--edition-heap "$RUN_EDITION_HEAP"}' : ""}`,
      },
      ...(joinsNetwork(network) ? networkLeave(network!) : []),
      {
        name: "Keep the media for delivery",
        if: "always()",
        uses: "actions/upload-artifact@v4",
        with: {
          name: mediaPartArtifact(job.name, part.id),
          path: `\${{ runner.temp }}/${MEDIA_PART_DIR}/`,
          "retention-days": MEDIA_PART_RETENTION_DAYS,
          "if-no-files-found": "ignore",
        },
      },
      {
        name: "Keep the report",
        if: "always()",
        uses: "actions/upload-artifact@v4",
        with: {
          name: partReportArtifact(job.name, part.id),
          path: `\${{ runner.temp }}/${REPORT_DIR}/`,
          "retention-days": REPORT_RETENTION_DAYS,
          "if-no-files-found": "ignore",
        },
      },
    ],
  };
}

/**
 * After every part has ended, however it ended: downloads the parts' media,
 * merges them (a part without media is listed with why) and delivers once.
 * Only the delivery secrets reach it: no media secrets, no tailnet.
 */
function deliverJob(
  job: JobConfig,
  tools: readonly ToolEntry[],
): Record<string, unknown> {
  const parts = job.media!.parts!;
  const tidy = unlistReplaced(job);
  const recordOnly =
    tidy === undefined
      ? {}
      : { if: "${{ !(" + tidyRunExpression(tidy) + ") }}" };
  return {
    needs: parts.map((p) => partJobId(p.id)),
    if: "${{ !cancelled() }}",
    "runs-on": runnerLabels(),
    "timeout-minutes": NO_MODEL_TIMEOUT_MINUTES,
    permissions: { contents: "read" },
    steps: [
      { ...CHECKOUT },
      { ...SETUP_NODE },
      {
        name: "Download the parts' media",
        ...recordOnly,
        uses: "actions/download-artifact@v4",
        // No part left media when every one failed before uploading; the run step names each.
        "continue-on-error": true,
        with: {
          pattern: mediaPartArtifact(job.name, "*"),
          path: `\${{ runner.temp }}/${MEDIA_PARTS_DIR}`,
        },
      },
      {
        name: "Run the job",
        ...recordOnly,
        env: secretEnv([
          ...new Set([...jobToolSecrets(job, tools), ...deliverySecrets(job)]),
        ]),
        run: `${RUNNER} ${job.name} --media-parts "$RUNNER_TEMP/${MEDIA_PARTS_DIR}" --out "$RUNNER_TEMP/${REPORT_DIR}"`,
      },
      ...(tidy === undefined
        ? []
        : [
            {
              name: UNLIST_STEP,
              if: "${{ " + tidyRunExpression(tidy) + " }}",
              env: secretEnv(tidySecrets(job)),
              run: `${RUNNER} ${job.name} --unlist-only --out "$RUNNER_TEMP/${REPORT_DIR}"`,
            },
          ]),
      {
        name: "Keep the report",
        if: "always()",
        uses: "actions/upload-artifact@v4",
        with: {
          name: reportArtifact(job.name),
          path: `\${{ runner.temp }}/${REPORT_DIR}/`,
          "retention-days": REPORT_RETENTION_DAYS,
          "if-no-files-found": "ignore",
        },
      },
    ],
  };
}

/** models, from models.yml, become a choice when the workflow is started by hand, with thinkingLevels beside them; no models leaves no choice. */
export async function renderWorkflow(
  job: JobConfig,
  box: Box,
  tools: readonly ToolEntry[] = [],
  models: readonly string[] = [],
  thinkingLevels: readonly ThinkingLevel[] = THINKING_LEVELS,
): Promise<string> {
  const run: Record<string, unknown> = {};
  if ("after" in job.trigger) {
    // workflow_run fires on every completion; only a success should start the next job.
    run.if =
      "github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'";
  }
  // A job with model: none and one media stage may pick the media stage's model by hand.
  const mediaModels =
    !usesModel(job) &&
    job.media?.model !== undefined &&
    job.media.parts === undefined
      ? models
      : [];
  if (!usesModel(job)) models = [];
  const parts = job.media?.parts;
  const jobs: Record<string, unknown> = {};
  if (parts === undefined) {
    Object.assign(run, {
      "runs-on": runnerLabels(),
      "timeout-minutes": timeoutMinutes(job),
      // A check job reads the previous run's results artifact.
      permissions: {
        contents: "read",
        packages: "read",
        ...(job.output.kind === "results" || job.ledger === true
          ? { actions: "read" }
          : {}),
      },
      steps: steps(job, box, tools, models, mediaModels.length > 0),
    });
    jobs.run = run;
  } else {
    // Copies, so the document repeats each job in full instead of YAML anchors.
    const tidy = unlistReplaced(job);
    for (const part of parts) {
      // A tidy run records nothing; its delivery job only unlists.
      const recordIf =
        tidy === undefined
          ? {}
          : {
              if: `\${{ ${typeof run.if === "string" ? `(${run.if}) && ` : ""}!(${tidyRunExpression(tidy)}) }}`,
            };
      jobs[partJobId(part.id)] = structuredClone({
        ...run,
        ...recordIf,
        ...partJob(job, part, tools),
      });
    }
    jobs[DELIVER_JOB] = structuredClone(deliverJob(job, tools));
  }
  const doc = new Document({
    name: workflowName(job.name),
    ...(revisable(job) ? { "run-name": REVISE_RUN_NAME } : {}),
    on: triggers(job, models, thinkingLevels, mediaModels),
    permissions: {},
    // A check job queues per environment: one environment's run never waits on, or replaces, another's.
    concurrency: {
      group:
        "envs" in job.trigger
          ? `${workflowName(job.name)}-\${{ ${targetEnvExpression(job.trigger.envs)} }}`
          : workflowName(job.name),
      "cancel-in-progress": false,
    },
    jobs,
  });
  doc.commentBefore = ` Generated from ${jobFile(job.name, "job.yml")} by flax agents generate. Do not edit.`;
  for (const id of Object.keys(jobs)) {
    const runsOn = doc.getIn(["jobs", id, "runs-on"], true);
    if (runsOn instanceof YAMLSeq) runsOn.flow = true;
  }
  for (let i = 0; i < checkEnvs().length; i++) {
    const cron = doc.getIn(["on", "schedule", i, "cron"], true);
    if (cron instanceof Scalar) cron.type = Scalar.QUOTE_DOUBLE;
  }
  // YAML 1.1 readers take a bare off for false.
  const thinking = doc.getIn(["on", "workflow_dispatch", "inputs", "thinking"]);
  if (thinking instanceof YAMLMap) {
    const options = thinking.get("options", true);
    for (const item of options instanceof YAMLSeq ? options.items : [])
      if (item instanceof Scalar) item.type = Scalar.QUOTE_DOUBLE;
    const fallback = thinking.get("default", true);
    if (fallback instanceof Scalar) fallback.type = Scalar.QUOTE_DOUBLE;
  }
  return format(doc.toString({ lineWidth: 0 }), { parser: "yaml" });
}

/** The revision poller's workflow: every 10 minutes on the agents pool, with the reader app's secrets, a token that can start job workflows, and the writer app's secrets for queued Notes Agent checks. */
export async function renderRevisePoll(): Promise<string> {
  const doc = new Document({
    name: "Revision poller",
    on: { schedule: [{ cron: "*/10 * * * *" }], workflow_dispatch: {} },
    permissions: {},
    concurrency: { group: "revise-poll", "cancel-in-progress": false },
    jobs: {
      poll: {
        "runs-on": runnerLabels(),
        "timeout-minutes": 10,
        permissions: { actions: "write", contents: "read" },
        steps: [
          { ...CHECKOUT },
          { ...SETUP_NODE },
          {
            name: "Start revision runs",
            env: {
              ...secretEnv(REVISION_READ_SECRETS),
              // Only to queue the Notes Agent check of a started revision.
              ...secretEnv(WRITER_SECRET_ENV),
              GH_TOKEN: "${{ github.token }}",
            },
            run: `node ${REVISE_POLL_BUNDLE}`,
          },
        ],
      },
    },
  });
  doc.commentBefore = " Generated by flax agents generate. Do not edit.";
  const runsOn = doc.getIn(["jobs", "poll", "runs-on"], true);
  if (runsOn instanceof YAMLSeq) runsOn.flow = true;
  const cron = doc.getIn(["on", "schedule", 0, "cron"], true);
  if (cron instanceof Scalar) cron.type = Scalar.QUOTE_DOUBLE;
  return format(doc.toString({ lineWidth: 0 }), { parser: "yaml" });
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function describeTrigger(job: JobConfig): string {
  if ("schedule" in job.trigger) return `schedule \`${job.trigger.schedule}\``;
  if ("after" in job.trigger) return `after \`${job.trigger.after}\``;
  if ("envs" in job.trigger) {
    const envs = job.trigger.envs;
    return jobEnvs(job)
      .map((e) => `${e} \`${envs[e]}\``)
      .join(", ");
  }
  return "manual";
}

function describeOutput(job: JobConfig): string {
  switch (job.output.kind) {
    case "slack":
      return `slack #${job.output.channel}`;
    case "pr":
      return `pr ${job.output.repos.join(", ")}`;
    case "youtube":
      return `youtube ${job.output.docs_repo}`;
    case "file":
      return "file";
    case "results":
      return `results${job.output.alert === undefined ? "" : `, alerts #${job.output.alert}`}`;
  }
}

export async function renderJobsIndex(
  jobs: readonly JobConfig[],
): Promise<string> {
  const lines = [
    `<!-- Generated from ${JOBS_DIR}/*/job.yml by flax agents generate. Do not edit. -->`,
    "",
    "# Jobs",
    "",
  ];
  if (jobs.length === 0) {
    lines.push("No jobs yet.");
  } else {
    lines.push(
      "| Name | Owner | Purpose | Trigger | Model | Thinking | USD/month | Output | Mode |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const job of [...jobs].sort((a, b) => byCodePoint(a.name, b.name))) {
      lines.push(
        `| [${job.name}](${jobFile(job.name, "job.yml")}) | @${job.owner} | ${cell(job.purpose)} | ${describeTrigger(job)} | \`${job.model}\` | ${job.thinking ?? "none"} | ${monthlyBudgetUsd(job)} | ${describeOutput(job)} | ${job.mode} |`,
      );
    }
  }
  return format(`${lines.join("\n")}\n`, { parser: "markdown" });
}

/** Every generated file, keyed by its path relative to the repository root. */
export async function renderAll(
  jobs: readonly JobConfig[],
  box: Box,
  tools: readonly ToolEntry[] = [],
  models: readonly string[] = [],
  thinkingLevels: readonly ThinkingLevel[] = THINKING_LEVELS,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const job of [...jobs].sort((a, b) => byCodePoint(a.name, b.name))) {
    files.set(
      workflowPath(job.name),
      await renderWorkflow(job, box, tools, models, thinkingLevels),
    );
  }
  // The poller only has work once a job opens pull requests for real.
  if (jobs.some((j) => j.mode === "live" && j.output.kind === "pr"))
    files.set(REVISE_POLL_WORKFLOW, await renderRevisePoll());
  files.set(JOBS_INDEX, await renderJobsIndex(jobs));
  return files;
}
