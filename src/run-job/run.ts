import { workspace } from "../lib/workspace.ts";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  COLLECT_DIR,
  COLLECT_INPUTS_ENV,
  COLLECT_MAILBOX_ENV,
  JOB_SETTINGS_ENV,
} from "../collect/env.ts";
import { MAILBOX_DIR } from "../../images/agent/pi-mcp-mailbox/src/protocol.ts";
import {
  MODEL_SOCKET,
  TOOLS_SOCKET,
} from "../../images/agent/pi-mcp-mailbox/src/sockets.ts";
import { modelKeyEnv, gatewayModelName, piModel } from "../lib/gateway.ts";
import { collectToolLimits, toolLimits, type BranchKey } from "../lib/job.ts";
import { isBranchKey } from "../deliver/writer.ts";
import {
  renderSections,
  sectionLinkProblems,
  type PrSection,
} from "../deliver/pr-sections.ts";
import { postAnalysis } from "./analysis-output.ts";
import { jobFile } from "../lib/paths.ts";
import {
  MAINTAINER_NOTES_FILE,
  splitMaintainerNotes,
  withMaintainerNotes,
  type MaintainerNote,
} from "../lib/maintainer-notes.ts";
import { firstLine } from "../lib/problem.ts";
import { byCodePoint } from "../lib/sort.ts";
import { writeToolsReport, type RunningTools } from "../tools-server/start.ts";
import { MAX_ANSWER_BYTES, answerProblems, parseAnswer } from "./answer.ts";
import {
  buildLbxArgv,
  DATA_FILES,
  piCommand,
  runName as makeRunName,
  runTimeoutSeconds,
} from "./argv.ts";
import {
  anotherReviewProblem,
  checkMonthlyBudget,
  dearest,
  noopLedger,
  type BudgetDecision,
  type Ledger,
} from "./budget.ts";
import type { Model } from "../lib/allowlists.ts";
import { chooseModel } from "./model-choice.ts";
import { checkCitations } from "./evidence.ts";
import {
  createRunDirs,
  currentIdentity,
  scratchBase,
  writeDataFiles,
  type Identity,
} from "./data-dir.ts";
import {
  blockRunKey,
  GatewayClient,
  gatewayLedger,
  keyMinutes,
  keySpendUsd,
  issueRunKey,
  SPEND_SETTLE_MS,
  type RunKey,
} from "./gateway.ts";
import { startModelForwarder, type ModelForwarder } from "./forwarder.ts";
import {
  createSocketDir,
  removeOnExit,
  runtimeDirs,
  socketDirBases,
  socketEntriesProblem,
} from "./socket-dir.ts";
import {
  gatherInput,
  hasCollect,
  nothingToDoReason,
  withoutRunnerSecrets,
} from "./input.ts";
import { checkCollectInputs } from "./collect-inputs.ts";
import {
  LbxLauncher,
  lbxSocketProblem,
  StubLauncher,
  type LaunchResult,
  type Launcher,
} from "./launcher.ts";
import { writeLbxConfig } from "./lbx-files.ts";
import { runMediaStage, type MediaStageResult } from "./media.ts";
import {
  MEDIA_FORWARDER_FILE,
  openMediaModel,
  type OpenedMediaModel,
} from "./media-model.ts";
import { MEDIA_MANIFEST_ENV } from "../lib/media.ts";
import { loadRunnableJob } from "./load.ts";
import { runNoModelJob } from "./no-model.ts";
import type { DocsState } from "../deliver/video-map.ts";
import type { VideoHistory } from "../deliver/video-history.ts";
import type { OpenedYouTube } from "../deliver/youtube.ts";
import { buildPrompt } from "./preamble.ts";
import {
  appendStepSummary,
  ReportWriter,
  secretValues,
  summaryMarkdown,
  type GatewayRecord,
  type SocketsRecord,
  type RunReport,
  type Timing,
} from "./report.ts";
import {
  hasRender,
  plainSlackMessage,
  renderSlackMessage,
  slackMarkdown,
  type SlackMessage,
} from "./slack-render.ts";
import { runSlackStage } from "./slack-output.ts";
import {
  openSlackPoster,
  SLACK_POST_TOKEN_ENV,
  type OpenedPoster,
} from "../deliver/slack-poster.ts";
import {
  inputCommits,
  jobUpstreams,
  missingToolSecrets,
  serveTools,
  startRunUpstreams,
  type RunToolsHooks,
  type RunUpstreams,
} from "./tools.ts";
import { readUntrusted } from "./untrusted.ts";
import {
  openGithubWriter,
  WRITER_SECRET_ENV,
  type OpenedWriter,
} from "../deliver/github-writer.ts";
import { REVIEW_TIMEOUT_SECONDS } from "../lib/job.ts";
import {
  repairPrompt,
  repairSeconds,
  sessionToContinue,
  sizeNotes,
  type RepairRecord,
} from "./repair.ts";
import { untrustedInput, untrustedTools } from "./input-gate.ts";
import { runPrStage } from "./pr-output.ts";
import { hasPublish, runPublishScript } from "./publish-script.ts";
import {
  findLedgerRun,
  keepLedger,
  LEDGER_FILE,
  prepareLedger,
} from "./job-ledger.ts";
import {
  splitRevisionReplies,
  revisionPrompt,
  withRevisionReplies,
  type RevisionReply,
} from "../revise/answer.ts";
import {
  limitComment,
  postRevision,
  revisionComment,
  type RevisionOutcome,
} from "../revise/comment.ts";
import {
  readOriginalInput,
  READER_APP_ID_ENV,
  READER_PRIVATE_KEY_ENV,
} from "../revise/original.ts";
import { prepareRevision } from "../revise/prepare.ts";
import {
  endedCheck,
  endRevisionCheck,
  inProgressCheck,
  startRevisionCheck,
  type RevisionCheckTarget,
} from "../revise/check.ts";
import type { CheckRecord } from "../deliver/checks.ts";
import type { RevisionRequest } from "../revise/requests.ts";
import { loadGithubHosts } from "../lib/github-hosts.ts";
import { createInstallationToken, GITHUB_API } from "../tools-server/github.ts";
import { readCapped } from "../tools-server/artifacts.ts";
import { MAX_COMPARE_BYTES } from "../tools-server/compare.ts";
import type { GithubJsonReader } from "./review-commits.ts";
import type { CitedFileReader } from "./review-files.ts";
import type { RevisionRecord } from "./report.ts";
import {
  parseVerdict,
  REVIEW_SCHEMA,
  reviewFolder,
  reviewPrompt,
  STUB_REVIEW_ANSWER,
  type ReviewInput,
  type ReviewVerdict,
} from "./review.ts";
import { footerBlock, workflowRunUrl } from "./slack-render.ts";

export interface RunOptions {
  root: string;
  name: string;
  /** Run offline: no lbx, no docker, no model; the fixture answer stands in. */
  stub?: boolean;
  /** A model from models.yml to run with instead of the one in job.yml. */
  model?: string;
  /** A thinking level to run with instead of the one in job.yml. */
  thinking?: string;
  /** A models.yml model for the second check instead of output.review_model (or the job's model). */
  reviewModel?: string;
  /** A thinking level for the second check instead of output.review_model's. */
  reviewThinking?: string;
  /** Run on the input of this earlier run (its report's input.json) instead of collecting, in shadow: the same input for another model. */
  replay?: number;
  /** A models.yml model for the media stage instead of media.model's. */
  mediaModel?: string;
  /** Only load, check and budget; start nothing. */
  preflight?: boolean;
  /** Where the run directory goes; RUNNER_TEMP otherwise, and the system temp directory for stub runs. */
  scratch?: string;
  /** Where the report goes; defaults to report/ in the run directory. */
  out?: string;
  env?: NodeJS.ProcessEnv;
  launcher?: Launcher;
  /** Runs the second check of a pull request job; the stub or the run's launcher by default. */
  reviewLauncher?: Launcher;
  /** Makes the pull request writer instead of the writer app's token; for tests. */
  writer?: (repos: readonly string[]) => Promise<OpenedWriter>;
  /** Makes the Slack poster instead of the posting token; for tests. */
  poster?: () => Promise<OpenedPoster>;
  /** Makes the YouTube uploader instead of the YouTube grant; for tests. */
  youtube?: () => Promise<OpenedYouTube>;
  /** Reads a youtube job's map file instead of the reader app; for tests. */
  readDocs?: (
    repo: string,
    path: string,
    job: string,
  ) => Promise<{ state: DocsState; secrets: string[] }>;
  /** For a job with model: none, a media directory with a checked media.json to deliver instead of running its media stage (tests). */
  mediaDir?: string;
  /** For a job whose media stage has parts: record only this part and deliver nothing. */
  part?: string;
  /** Where a part run leaves its media (or failed.json) for the delivery job. */
  mediaOut?: string;
  /** For a job whose media stage has parts: deliver the parts' media found here, one directory per part's artifact, instead of running media.ts. */
  mediaParts?: string;
  /** The heap a part with edition_heap runs its edition with, such as 8g. */
  editionHeap?: string;
  /** The media inputs (media.inputs in job.yml) ticked for this run, by name. */
  mediaInputs?: string[];
  /** The collect inputs (collect_inputs in job.yml) given for this run, by name; an empty value is left out. */
  collectInputs?: Record<string, string>;
  /** For a youtube job with unlist_replaced: record and upload nothing, only unlist the replaced videos. */
  unlistOnly?: boolean;
  /** For a job with trigger.envs: the environment this run checks; a stub run takes the first one when not set. */
  targetEnv?: string;
  /** For a job with trigger.envs: why this run, such as the deploy it follows; one printable line. */
  reason?: string;
  /** For a check job: the previous run's results artifact, as the workflow downloaded it; none when there is no previous run. */
  previous?: string;
  /** For a check job: where its results go for the workflow to upload. */
  resultsOut?: string;
  /** For a check job: only find the run with the environment's previous results, for the workflow's download step. */
  findPrevious?: boolean;
  /** For a job with a ledger: only find the run with the newest ledger, for the workflow's download step. */
  findLedger?: boolean;
  /** For a job with a ledger: where the workflow downloaded the previous run's ledger; none when there is none yet. */
  ledgerIn?: string;
  /** For a job with a ledger: where the ledger collect.ts writes goes for the workflow to upload. */
  ledgerOut?: string;
  /** Calls the GitHub API instead of fetch when finding the previous results; for tests. */
  githubFetch?: typeof fetch;
  /** Reads a youtube job's map and its map pull requests instead of the reader app; for tests. */
  readHistory?: (
    repo: string,
    path: string,
    job: string,
  ) => Promise<{ history: VideoHistory; secrets: string[] }>;
  /** Revise this open pull request of the job, from its reviewers' requests, instead of a fresh run. */
  revise?: { repo: string; number: number };
  /** Reads the input of the run that opened a pull request; the reader app and the run's report artifact by default. */
  readOriginal?: (job: string, runId: number) => Promise<unknown>;
  /** Reads a file the answer cites, at a commit, for the second check; the reader app by default, none in stub runs. */
  readCitedFile?: CitedFileReader;
  /** Reads the commits and pull requests the answer credits, for the second check; the reader app by default, none in stub runs. */
  readGithub?: GithubJsonReader;
  ledger?: Ledger;
  now?: () => Date;
  identity?: Identity;
  /** The lbx executable; found on PATH by default. */
  lbx?: string;
  /** Stand-ins for fetching binaries and starting upstreams, for jobs with tools. */
  tools?: RunToolsHooks;
  /** Settings for talking to a fake model gateway in tests. */
  gateway?: RunGatewayHooks;
  /** Where the socket directory may go, best first; socketDirBases() by default. */
  socketBases?: readonly string[];
  log?: (line: string) => void;
}

export interface RunGatewayHooks {
  /** Where the gateway is instead of gateway.yml's host and port; its certificate must still chain to the pinned CA. */
  baseUrl?: string;
  /** How long to wait for the gateway to write a blocked key's spend. */
  settleMs?: number;
  timeoutMs?: number;
}

export interface RunResult {
  ok: boolean;
  /** What happened, one line per item. */
  messages: string[];
  outDir?: string;
  report?: RunReport;
}

// Placeholder for stub runs from a tree whose box.yml is not valid yet; lbx never sees it.
const STUB_IMAGE = "lbx:docker";
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_FILES = 20;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function fail(...messages: string[]): RunResult {
  return { ok: false, messages };
}

/** Regular files under dir, at most a few levels deep, skipping links and odd names. */
function sessionFiles(dir: string, rel = "", depth = 0): string[] {
  if (depth > 3) return [];
  let entries: string[];
  try {
    entries = readdirSync(join(dir, rel)).sort(byCodePoint);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!SAFE_NAME.test(entry) || entry === "." || entry === "..") continue;
    const path = rel === "" ? entry : `${rel}/${entry}`;
    const stat = lstatSync(join(dir, path));
    if (stat.isDirectory()) out.push(...sessionFiles(dir, path, depth + 1));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

function callCounts(tools: RunningTools): { calls: number; ok: number } {
  const calls = tools.server.calls;
  return {
    calls: calls.length,
    ok: calls.filter((c) => c.outcome === "ok").length,
  };
}

export async function runJob(options: RunOptions): Promise<RunResult> {
  const env = options.env ?? process.env;
  const stub = options.stub ?? false;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.log(line));
  const timings: Timing[] = [];
  const timed = async <T>(
    step: string,
    fn: () => T | Promise<T>,
  ): Promise<T> => {
    const started = now();
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      timings.push({
        step,
        startedAt: started.toISOString(),
        ms: Math.round(performance.now() - t0),
      });
    }
  };

  // a. Load and check.
  const loaded = await timed("load", () =>
    loadRunnableJob(options.root, options.name, {
      stub,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
      ...(options.reviewModel === undefined
        ? {}
        : { reviewModel: options.reviewModel }),
      ...(options.reviewThinking === undefined
        ? {}
        : { reviewThinking: options.reviewThinking }),
      ...(options.mediaModel === undefined
        ? {}
        : { mediaModel: options.mediaModel }),
    }),
  );
  if (!loaded.ok) return fail(...loaded.errors);
  const givenInputs = Object.entries(options.collectInputs ?? {}).filter(
    ([, v]) => v !== "",
  );
  if ("noModel" in loaded) {
    if (givenInputs.length > 0)
      return fail(
        `${options.name} runs no model and no collect.ts; only a job with collect_inputs takes --collect-input`,
      );
    if (
      options.findLedger === true ||
      options.ledgerIn !== undefined ||
      options.ledgerOut !== undefined
    )
      return fail(
        `${options.name} runs no model and no collect.ts; only a job with ledger: true takes the ledger flags`,
      );
    return runNoModelJob(options, loaded.noModel, timings, timed);
  }
  if (
    options.part !== undefined ||
    options.mediaParts !== undefined ||
    options.editionHeap !== undefined ||
    options.unlistOnly === true
  )
    return fail(
      `${options.name} runs a model; only a job with model: none splits its media stage into parts`,
    );
  if ((options.mediaInputs ?? []).length > 0)
    return fail(
      `${options.name} runs a model; only a job with model: none takes --media-input`,
    );
  if (
    options.targetEnv !== undefined ||
    options.reason !== undefined ||
    options.findPrevious === true ||
    options.previous !== undefined ||
    options.resultsOut !== undefined
  )
    return fail(
      `--env, --reason and the results flags are for a check job (output kind results); ${options.name} runs a model`,
    );
  if (
    loaded.job.config.ledger !== true &&
    (options.findLedger === true ||
      options.ledgerIn !== undefined ||
      options.ledgerOut !== undefined)
  )
    return fail(
      `${options.name} keeps no ledger (ledger: true in job.yml), so it takes no ledger flags`,
    );
  if (options.findLedger === true) {
    const found = await findLedgerRun({
      job: options.name,
      env,
      ...(options.githubFetch === undefined
        ? {}
        : { fetch: options.githubFetch }),
    });
    return found.ok
      ? { ok: true, messages: [found.message] }
      : fail(found.message);
  }
  const { box, gateway } = loaded.job;
  const collectInputs = checkCollectInputs(
    loaded.job.config,
    options.collectInputs ?? {},
  );
  if ("error" in collectInputs) return fail(collectInputs.error);
  if (
    Object.keys(collectInputs.values).length > 0 &&
    (options.revise !== undefined || options.replay !== undefined)
  )
    return fail(
      "--collect-input is for a run that collects: a revision or a replay reads an earlier run's input",
    );
  // collect.ts may switch both to another of the job's models once the input is in.
  let config = loaded.job.config;
  let model = loaded.job.model;
  const reviewOn = loaded.job.reviewModel;
  // A run whose second check runs on another model reserves at the dearer of the two prices.
  const priced = (m: Model): Model =>
    reviewOn === undefined || dearest(m) >= dearest(reviewOn.model)
      ? m
      : reviewOn.model;
  const revise = options.revise;
  const replay = options.replay;
  if (replay !== undefined) {
    if (revise !== undefined)
      return fail(
        "--replay and --revise do not go together: a revision reads its own original input",
      );
    if (config.output.kind !== "pr")
      return fail(
        `--replay: only a pull request job replays an input, and ${config.name} delivers ${config.output.kind}`,
      );
    // A replay is an experiment on an old input: it never delivers.
    config = { ...config, mode: "shadow" };
  }
  if (revise !== undefined) {
    if (config.output.kind !== "pr")
      return fail(
        `${config.name} opens no pull requests (output kind ${config.output.kind}), so it has none to revise`,
      );
    if (config.mode !== "live" && !stub)
      return fail(
        `${config.name} is in shadow mode and opens no pull requests, so it has none to revise`,
      );
    if (!config.output.repos.includes(revise.repo))
      return fail(`${revise.repo} is not a repository ${config.name} changes`);
    if (stub && options.writer === undefined)
      return fail("a stub revision needs a stand-in writer");
  }

  // A real run holds only the issuer key and reads the month's spend from the gateway.
  let client: GatewayClient | undefined;
  if (!stub && !options.preflight) {
    const keyEnv = modelKeyEnv();
    const issuerKey = env[keyEnv] ?? "";
    if (issuerKey === "")
      return fail(
        gateway.mode === "static"
          ? `${keyEnv} is not set; the model provider needs it for every call`
          : `${keyEnv} is not set; the model gateway needs it to issue the run's key`,
      );
    client = new GatewayClient({
      gateway,
      ...(loaded.job.gatewayCa === undefined
        ? {}
        : { ca: loaded.job.gatewayCa }),
      issuerKey,
      ...(options.gateway?.baseUrl === undefined
        ? {}
        : { baseUrl: options.gateway.baseUrl }),
      ...(options.gateway?.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.gateway.timeoutMs }),
    });
  }
  const ledger =
    options.ledger ??
    (client === undefined ? noopLedger : gatewayLedger(client));

  // b. Budget.
  let decision: BudgetDecision;
  // The media key, when the media stage gets one, counts toward the same month.
  const mediaReserve =
    revise === undefined ? (config.media?.model?.usd_per_run ?? 0) : 0;
  try {
    decision = await timed("budget", () =>
      checkMonthlyBudget(config, priced(model), ledger, now(), mediaReserve),
    );
  } catch (err) {
    return fail(`${firstLine(err)}; the job did not start`);
  }
  if (!decision.ok) return fail(decision.reason);
  let budget = decision;
  // The gateway refuses a key over its ceiling; saying so here is clearer and costs nothing.
  if (budget.reserveUsd > gateway.key_max_usd)
    return fail(
      `a run of ${config.name} at ${model.id} can cost up to $${budget.reserveUsd.toFixed(2)}, over the gateway's $${gateway.key_max_usd} ceiling for one key (key_max_usd in gateway.yml)`,
    );
  if (keyMinutes(config) > gateway.key_max_minutes)
    return fail(
      `a run of ${config.name} needs a key for ${keyMinutes(config)} minutes, over the gateway's ${gateway.key_max_minutes}-minute ceiling (key_max_minutes in gateway.yml)`,
    );
  if (!ledger.durable)
    log(
      gateway.mode === "static"
        ? "The model provider is a static key, which keeps no month-to-date spend the runner can read; only the per-run worst case is checked."
        : "Month-to-date spend is read from the model gateway in the run itself; here only the per-run worst case is checked.",
    );

  if (options.preflight) {
    return {
      ok: true,
      messages: [
        `${config.name}: ready to run (mode ${config.mode}, box ${box?.box_commit ?? "not pinned"}).`,
      ],
    };
  }

  const secrets = secretValues(env);
  if (!stub) {
    if (config.tools.length > 0 || (config.collect_tools ?? []).length > 0) {
      const missing = missingToolSecrets(
        env,
        jobUpstreams(options.root, config),
      );
      if (missing.length > 0)
        return fail(
          `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set; the job's tools need ${missing.length === 1 ? "it" : "them"}`,
        );
    }
    const mediaMissing =
      revise === undefined
        ? (config.media?.secrets ?? []).filter((n) => (env[n] ?? "") === "")
        : [];
    if (mediaMissing.length > 0)
      return fail(
        `${mediaMissing.join(", ")} ${mediaMissing.length === 1 ? "is" : "are"} not set; the job's media.ts needs ${mediaMissing.length === 1 ? "it" : "them"}`,
      );
    if (
      config.mode === "live" &&
      config.output.kind === "pr" &&
      options.writer === undefined
    ) {
      const missing = WRITER_SECRET_ENV.filter((n) => (env[n] ?? "") === "");
      if (missing.length > 0)
        return fail(
          `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set; a live pull request job needs the writer app to open its pull requests`,
        );
    }
    if (
      (revise !== undefined || replay !== undefined) &&
      options.readOriginal === undefined &&
      [READER_APP_ID_ENV, READER_PRIVATE_KEY_ENV].some(
        (n) => (env[n] ?? "") === "",
      )
    )
      return fail(
        `${READER_APP_ID_ENV} and ${READER_PRIVATE_KEY_ENV} must be set; a revision or a replay reads an earlier run's input with them`,
      );
    const prNotify = loaded.job.prNotify;
    if (
      prNotify !== undefined &&
      revise === undefined &&
      options.poster === undefined &&
      (env[SLACK_POST_TOKEN_ENV] ?? "") === "" &&
      (config.mode === "live" || prNotify.shadow !== undefined)
    )
      return fail(
        `${SLACK_POST_TOKEN_ENV} is not set; a pull request job with output.notify needs it to post its notice to #${config.mode === "live" ? prNotify.channel.name : prNotify.shadow!.name}`,
      );
    if (
      config.output.kind === "slack" &&
      options.poster === undefined &&
      (env[SLACK_POST_TOKEN_ENV] ?? "") === ""
    ) {
      const shadowChannel = loaded.job.slack?.shadow;
      if (config.mode === "live")
        return fail(
          `${SLACK_POST_TOKEN_ENV} is not set; a live slack job needs it to post its message`,
        );
      if (shadowChannel !== undefined)
        return fail(
          `${SLACK_POST_TOKEN_ENV} is not set; a shadow run of a slack job needs it to post its message to #${shadowChannel.name}`,
        );
    }
  }

  // A real run needs an lbx with the runner's sockets; ask it before anything is created.
  const lbx = options.lbx ?? "lbx";
  const lbxEnv = withoutRunnerSecrets(env);
  if ((options.launcher?.kind ?? (stub ? "stub" : "lbx")) === "lbx") {
    const problem = await lbxSocketProblem(lbx, lbxEnv);
    if (problem !== undefined)
      return fail(
        `every run gets no network and the runner's sockets, but ${problem}; pin a sandbox (lbx) release whose lbx has --socket-dir and --no-network`,
      );
  }

  // c. Run directory and inputs.
  const who = options.identity ?? currentIdentity();
  const chosen = scratchBase(options.scratch, env, who);
  if ("error" in chosen) return fail(chosen.error);
  let dirs;
  try {
    dirs = createRunDirs(chosen.base, config.name, who);
  } catch (err) {
    return fail((err as Error).message);
  }
  const report = new ReportWriter(
    options.out ?? join(dirs.root, "report"),
    secrets,
  );
  const name = makeRunName(config.name, env, now());
  const result: RunReport = {
    job: config.name,
    mode: config.mode,
    launcher: stub ? "stub" : "lbx",
    runName: name,
    model: config.model,
    thinking: config.thinking,
    ...(reviewOn === undefined
      ? {}
      : {
          reviewModel: {
            model: reviewOn.model.id,
            thinking: reviewOn.thinking,
          },
        }),
    inputSource: "fixture",
    ok: false,
    answerProblems: [],
    argv: [],
    timings,
    budget: {
      month: budget.month,
      spentUsd: budget.spentUsd,
      reserveUsd: budget.reserveUsd,
      ledger: ledger.durable ? "durable" : "none",
      ...(budget.shared === undefined ? {} : { shared: budget.shared }),
    },
  };
  const gatewayRecord: GatewayRecord = {
    url: gateway.url,
    blocked: false,
    problems: [],
  };
  result.gateway = gatewayRecord;
  const socketsRecord: SocketsRecord = { problems: [] };
  result.sockets = socketsRecord;

  let releaseSocketDir: (() => void) | undefined;
  let forwarder: ModelForwarder | undefined;
  // The forwarder the writer used, kept for the record once the second check gets its own (review_model).
  let writerForwarder: ModelForwarder | undefined;
  let forwarderClosed = false;
  // Stops the forwarder as soon as the box is done, on every path, and records what it passed on.
  const closeForwarder = async (): Promise<void> => {
    if (forwarderClosed || forwarder === undefined) return;
    forwarderClosed = true;
    await forwarder.stop().catch((err: unknown) => {
      gatewayRecord.problems.push(
        `stopping the forwarder failed: ${firstLine(err)}`,
      );
    });
    const all =
      writerForwarder === undefined
        ? [forwarder]
        : [writerForwarder, forwarder];
    const counts = { forwarded: 0, refused: 0, failed: 0, polls: 0 };
    for (const f of all)
      for (const k of Object.keys(counts) as (keyof typeof counts)[])
        counts[k] += f.counts[k];
    report.writeJson(
      "forwarder.json",
      all.flatMap((f) => f.records),
    );
    socketsRecord.forwarder = { ...counts };
    gatewayRecord.forwarder = { ...counts };
  };

  let runKey: RunKey | undefined;
  let gatewayClosed = false;
  // Blocks the run's key as soon as the box is done, on every path, then reads what the key spent.
  const closeGateway = async (): Promise<void> => {
    if (gatewayClosed || runKey === undefined || client === undefined) return;
    gatewayClosed = true;
    const record = gatewayRecord;
    try {
      await blockRunKey(client, runKey.key);
      record.blocked = true;
    } catch (err) {
      record.problems.push(`blocking the key failed: ${firstLine(err)}`);
    }
    await new Promise((r) =>
      setTimeout(r, options.gateway?.settleMs ?? SPEND_SETTLE_MS),
    );
    try {
      const spent = await keySpendUsd(client, runKey.id);
      if (spent !== undefined) record.spendUsd = spent;
    } catch (err) {
      record.problems.push(`reading the key's spend failed: ${firstLine(err)}`);
    }
  };

  let upstreams: RunUpstreams | undefined;
  let tools: RunningTools | undefined;
  let toolsClosed = false;
  let toolsProblem: string | undefined;
  // Stops the model's tools server and the upstreams, then records what the tools did.
  const closeTools = async (): Promise<void> => {
    if (toolsClosed) return;
    toolsClosed = true;
    if (tools !== undefined) {
      try {
        await tools.stop();
      } catch (err) {
        toolsProblem = `stopping the tools failed: ${firstLine(err)}`;
      }
      writeToolsReport(report, tools, dirs.data);
      result.tools = {
        names: [...config.tools],
        upstreams: upstreams?.servers ?? [],
        ...callCounts(tools),
      };
    }
    try {
      await upstreams?.close();
    } catch (err) {
      toolsProblem ??= `stopping the tools failed: ${firstLine(err)}`;
    }
  };

  let notes: readonly MaintainerNote[] = [];
  // A revision run reads, pushes and comments with one writer, opened before the input and closed at the end.
  let revisionWriter: OpenedWriter | undefined;
  let revisionRecord: RevisionRecord | undefined;
  let revisionRound:
    | { round: number; requests: RevisionRequest[]; replies: RevisionReply[] }
    | undefined;
  // The round's Notes Agent check run: queued by the poller, in progress here, completed in closeRevision.
  let revisionCheck:
    { target: RevisionCheckTarget; started: CheckRecord } | undefined;
  // Every round that read its requests answers them on the pull request, on every path, so the poller never repeats it by itself.
  const closeRevision = async (failure?: string): Promise<void> => {
    if (revisionWriter === undefined || revise === undefined) return;
    const record = revisionRecord;
    if (
      record !== undefined &&
      revisionRound !== undefined &&
      !record.commented
    ) {
      const delivered = result.delivery?.revision;
      const runUrl = workflowRunUrl(env);
      const outcome: RevisionOutcome = {
        job: config.name,
        round: revisionRound.round,
        runName: name,
        ...(runUrl === undefined ? {} : { runUrl }),
        requests: revisionRound.requests,
        replies: revisionRound.replies,
        ...(delivered?.commit === undefined
          ? {}
          : {
              commit: delivered.commit,
              pages: (result.delivery?.pages ?? []).map((p) => ({
                path: p.path,
                changedLines: p.changedLines,
              })),
            }),
        ...(failure !== undefined
          ? { problem: firstLine(failure) }
          : result.delivery?.outcome === "report_only"
            ? {
                problem: firstLine(
                  result.delivery.reason ?? "a check refused it",
                ),
              }
            : {}),
      };
      try {
        const posted = await postRevision(
          revisionWriter.writer,
          revise.repo,
          revise.number,
          outcome,
        );
        report.write("revision/comment.md", posted.summary);
        record.commented = true;
        for (const r of posted.refused)
          record.problems.push(
            `replying in the thread of ${r.request} failed: ${r.why}; answered in the summary comment`,
          );
      } catch (err) {
        report.write("revision/comment.md", revisionComment(outcome));
        record.problems.push(`posting the reply failed: ${firstLine(err)}`);
      }
    }
    if (record !== undefined && revisionCheck !== undefined) {
      const delivered = result.delivery?.revision;
      const round = revisionRound?.round ?? record.round ?? 0;
      const problem =
        failure ??
        (result.delivery?.outcome === "report_only"
          ? (result.delivery.reason ?? "a check refused it")
          : undefined);
      const ended = await endRevisionCheck(
        revisionWriter.writer,
        revisionCheck.target,
        endedCheck(
          problem !== undefined
            ? { kind: "failed", reason: problem }
            : delivered?.commit !== undefined
              ? { kind: "revised", commit: delivered.commit, round }
              : { kind: "answered", round },
          workflowRunUrl(env),
        ),
        revisionCheck.started,
      );
      if (ended !== undefined) record.check = ended;
      revisionCheck = undefined;
    }
    await revisionWriter.close().catch((err: unknown) => {
      revisionRecord?.problems.push(
        `revoking the writer token failed: ${firstLine(err)}; it expires within the hour`,
      );
    });
    revisionWriter = undefined;
  };
  // The full analysis publish.ts gave when it published nothing, as Markdown.
  let analysisMarkdown: string | undefined;
  const finish = async (failure?: string): Promise<RunResult> => {
    await closeRevision(failure);
    if (revisionRecord !== undefined) result.revision = revisionRecord;
    await closeTools();
    await closeForwarder();
    await closeGateway();
    releaseSocketDir?.();
    failure ??= toolsProblem;
    if (runKey !== undefined && !gatewayRecord.blocked)
      failure ??= `the run is incomplete: its gateway key ${runKey.alias} could not be blocked and stays usable until it expires${runKey.expires === undefined ? "" : ` at ${runKey.expires}`}`;
    if (failure !== undefined) result.failure = failure;
    result.ok = failure === undefined;
    report.writeJson("argv.json", result.argv);
    report.writeJson("timings.json", timings);
    report.writeJson("status.json", {
      ...result,
      argv: undefined,
      timings: undefined,
    });
    if (report.secretHits > 0) {
      // Checked last, after every file went through the scrubber.
      result.ok = false;
      result.failure =
        "a secret value appeared in the run's output; it was replaced with [redacted] in the report. Rotate the key.";
      report.writeJson("status.json", {
        ...result,
        argv: undefined,
        timings: undefined,
      });
    }
    const summary =
      analysisMarkdown === undefined
        ? summaryMarkdown(result, notes)
        : `${summaryMarkdown(result, notes)}\n#### Analysis\n\n${analysisMarkdown}`;
    report.write("summary.md", summary);
    appendStepSummary(env, summary, report.secretList);
    return {
      ok: result.ok,
      messages: [
        result.ok
          ? result.nothingToDo !== undefined
            ? `${config.name}: nothing to do: ${result.nothingToDo.reason}`
            : revisionRecord !== undefined &&
                revisionRecord.decision !== "revise"
              ? `${config.name}: ${revisionRecord.decision === "limit" ? "the round limit is reached; said so on the pull request" : `nothing to revise: ${revisionRecord.reason ?? ""}`}.`
              : `${config.name}: answer accepted.`
          : `${config.name}: ${result.failure}`,
        `Report: ${report.dir}`,
      ],
      outDir: report.dir,
      report: result,
    };
  };

  let collectUntrusted: string[] = [];
  try {
    const collectTools = config.collect_tools ?? [];
    const collectsWithTools =
      revise === undefined &&
      !stub &&
      collectTools.length > 0 &&
      hasCollect(options.root, config.name);

    // An earlier run's input, from its report artifact: what a revision builds on and a replay runs again.
    const readOriginal =
      options.readOriginal ??
      (async (job: string, runId: number) => {
        const token = await createInstallationToken({
          appId: env[READER_APP_ID_ENV] ?? "",
          privateKey: env[READER_PRIVATE_KEY_ENV] ?? "",
          repositories: [
            workspace().repo.slice(workspace().repo.indexOf("/") + 1),
          ],
        });
        report.addSecrets([token.token]);
        try {
          return await readOriginalInput({
            token: token.token,
            job,
            runId,
            downloadHosts: loadGithubHosts(options.root).hosts?.hosts ?? [],
          });
        } finally {
          await token.revoke().catch(() => undefined);
        }
      });
    let replayInput: unknown;
    if (replay !== undefined) {
      try {
        replayInput = await timed("replay", () =>
          readOriginal(config.name, replay),
        );
      } catch (err) {
        return finish(
          `the input of run ${replay} could not be read: ${firstLine(err)}`,
        );
      }
      result.replayOf = replay;
    }

    // A revision's input is the pull request at its head and the original run's input, never collect.ts.
    let revisionInput: Record<string, unknown> | undefined;
    if (revise !== undefined) {
      try {
        revisionWriter = await (
          options.writer ?? ((repos) => openGithubWriter(env, repos))
        )([revise.repo]);
      } catch (err) {
        return finish(
          `the pull request writer could not start: ${firstLine(err)}`,
        );
      }
      report.addSecrets(revisionWriter.secrets);

      const prepared = await timed("revision", () =>
        prepareRevision({
          job: config.name,
          repo: revise.repo,
          number: revise.number,
          policy: {
            repos: (config.output as { repos: string[] }).repos,
            paths: (config.output as { paths: string[] }).paths,
            maxChangedLines: (config.output as { max_changed_lines: number })
              .max_changed_lines,
          },
          writer: revisionWriter!.writer,
          readOriginal,
        }),
      );
      report.writeJson("revision/thread.json", prepared.thread);
      revisionRecord = {
        repo: revise.repo,
        pull: revise.number,
        decision:
          prepared.kind === "nothing"
            ? "nothing"
            : prepared.kind === "limit"
              ? "limit"
              : "revise",
        requests:
          "requests" in prepared ? prepared.requests.map((r) => r.id) : [],
        commented: false,
        problems: [],
      };
      const checkTarget: RevisionCheckTarget = {
        repo: revise.repo,
        job: config.name,
        branch: prepared.thread.pull.branch,
        head: prepared.thread.pull.headSha,
      };
      if (prepared.kind === "nothing") {
        revisionRecord.reason = prepared.reason;
        // A queued check the poller made is closed; none is made for nothing.
        const ended = await endRevisionCheck(
          revisionWriter!.writer,
          checkTarget,
          endedCheck(
            { kind: "nothing", reason: prepared.reason },
            workflowRunUrl(env),
          ),
          undefined,
          false,
        );
        if (ended !== undefined) revisionRecord.check = ended;
        return finish();
      }
      if (prepared.kind === "limit") {
        try {
          await revisionWriter!.writer.comment(
            revise.repo,
            revise.number,
            limitComment(config.name),
          );
          revisionRecord.commented = true;
        } catch (err) {
          return finish(
            `posting the round limit comment failed: ${firstLine(err)}`,
          );
        }
        const ended = await endRevisionCheck(
          revisionWriter!.writer,
          checkTarget,
          endedCheck({ kind: "limit" }, workflowRunUrl(env)),
        );
        if (ended !== undefined) revisionRecord.check = ended;
        return finish();
      }
      revisionCheck = {
        target: checkTarget,
        started: await startRevisionCheck(
          revisionWriter!.writer,
          checkTarget,
          inProgressCheck(
            prepared.round,
            prepared.requests.length,
            workflowRunUrl(env),
          ),
        ),
      };
      revisionRecord.round = prepared.round;
      revisionRound = {
        round: prepared.round,
        requests: prepared.requests,
        replies: [],
      };
      if (prepared.kind === "failed") return finish(prepared.error);
      revisionRecord.originalRun = prepared.originalRunId;
      revisionInput = prepared.input;
    }

    // The upstreams start once and serve both tools servers: before collect.ts when it calls tools, otherwise before the box.
    const startUpstreams = async (): Promise<RunUpstreams> => {
      const started = await timed("upstreams", () =>
        startRunUpstreams({
          root: options.root,
          job: config,
          runRoot: dirs.root,
          env,
          stub,
          ...(options.tools === undefined ? {} : { hooks: options.tools }),
          now,
        }),
      );
      upstreams = started;
      report.addSecrets(started.secrets);
      return started;
    };
    if (collectsWithTools) await startUpstreams();

    // media.ts runs after the upstreams started, so a tool that cannot start fails the run before a long recording. Delivery reads the media by the checked manifest, each file through readMediaFile.
    let media: MediaStageResult["media"];
    if (config.media !== undefined && revise === undefined) {
      const stageConfig = config.media;
      let mediaModel: OpenedMediaModel | undefined;
      if (
        !stub &&
        client !== undefined &&
        stageConfig.model !== undefined &&
        loaded.job.mediaModel !== undefined
      ) {
        try {
          mediaModel = await timed("media-key", () =>
            openMediaModel({
              client: client!,
              model: loaded.job.mediaModel!,
              ...(loaded.job.mediaFallback === undefined
                ? {}
                : { fallback: loaded.job.mediaFallback }),
              config: stageConfig.model!,
              stage: stageConfig,
              job: config.name,
              month: budget.month,
              runName: name,
              socketBases:
                options.socketBases ?? socketDirBases(env, dirs.root),
              ...(env.GITHUB_RUN_ID === undefined
                ? {}
                : { metadata: { github_run_id: env.GITHUB_RUN_ID } }),
              ...(options.gateway?.settleMs === undefined
                ? {}
                : { settleMs: options.gateway.settleMs }),
            }),
          );
        } catch (err) {
          return finish(
            `the media stage's model key could not be issued: ${firstLine(err)}`,
          );
        }
        report.addSecrets([mediaModel.key]);
        result.mediaModel = mediaModel.record;
      }
      let stage: MediaStageResult;
      try {
        stage = await timed("media", () =>
          runMediaStage({
            root: options.root,
            config: { ...config, media: stageConfig },
            runRoot: dirs.root,
            env,
            stub,
            report,
            ...(mediaModel === undefined ? {} : { extraEnv: mediaModel.env }),
          }),
        );
      } finally {
        if (mediaModel !== undefined)
          report.writeJson(MEDIA_FORWARDER_FILE, await mediaModel.close());
      }
      result.media = stage.record;
      if (stage.failure !== undefined) return finish(stage.failure);
      media = stage.media;
    }
    const mediaEnvExtra: Record<string, string> =
      media === undefined ? {} : { [MEDIA_MANIFEST_ENV]: media.manifestPath };
    // A job with a ledger: collect.ts reads the previous run's and writes the next.
    const jobLedger =
      config.ledger === true &&
      !stub &&
      revisionInput === undefined &&
      replay === undefined
        ? prepareLedger(dirs.root, options.ledgerIn)
        : undefined;

    const input = await timed("input", async () => {
      if (revisionInput !== undefined)
        return { source: "revision" as const, value: revisionInput };
      if (replay !== undefined)
        return { source: "replay" as const, value: replayInput };
      const settingsEnv = {
        [JOB_SETTINGS_ENV]: JSON.stringify(config.settings ?? {}),
        ...(Object.keys(collectInputs.values).length === 0
          ? {}
          : { [COLLECT_INPUTS_ENV]: JSON.stringify(collectInputs.values) }),
        ...(jobLedger?.env ?? {}),
      };
      if (!collectsWithTools || upstreams === undefined)
        return gatherInput(options.root, config.name, {
          stub,
          env,
          extraEnv: { ...mediaEnvExtra, ...settingsEnv },
        });
      // collect.ts gets its own tools server, on a mailbox outside the data directory.
      const dir = join(dirs.root, COLLECT_DIR);
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700);
      const collector = await serveTools({
        root: options.root,
        job: config,
        dir,
        names: collectTools,
        limits: collectToolLimits(config),
        upstreams,
        ...(options.tools === undefined ? {} : { hooks: options.tools }),
        now,
      });
      try {
        return await gatherInput(options.root, config.name, {
          stub,
          env,
          extraEnv: {
            ...mediaEnvExtra,
            ...settingsEnv,
            [COLLECT_MAILBOX_ENV]: join(dir, MAILBOX_DIR),
          },
        });
      } finally {
        await collector.stop().catch(() => undefined);
        writeToolsReport(report, collector, dir, `${COLLECT_DIR}/`);
        result.collect = { names: [...collectTools], ...callCounts(collector) };
        collectUntrusted = untrustedTools(collector.server.results);
      }
    });
    result.inputSource = input.source;
    report.writeJson("input.json", input.value);
    if (jobLedger !== undefined) {
      result.ledger = jobLedger.record;
      const kept = keepLedger(
        jobLedger.next,
        options.ledgerOut,
        jobLedger.record,
      );
      if (kept.text !== undefined) report.write(LEDGER_FILE, kept.text);
      if (kept.error !== undefined) return finish(kept.error);
    }
    if (Object.keys(collectInputs.values).length > 0)
      result.collectInputs = collectInputs.values;

    // collect.ts may say there is nothing to do: no model is called and the run passes.
    const nothing =
      input.source === "revision" ? undefined : nothingToDoReason(input.value);
    if (nothing !== undefined) {
      if ("error" in nothing) return finish(nothing.error);
      result.nothingToDo = { reason: nothing.reason };
      log(`${config.name}: nothing to do: ${nothing.reason}`);
      return finish();
    }

    // A job with one branch per key: a key from the input is checked before any model runs.
    const keyFrom =
      config.output.kind === "pr" && revise === undefined
        ? config.output.branch_key
        : undefined;
    let branchKey: string | undefined;
    if (keyFrom?.from === "input") {
      const key = branchKeyOf(input.value, keyFrom);
      if ("error" in key) return finish(key.error);
      branchKey = key.key;
    }

    // A job with models runs the one collect.ts chose, checked against the month at its own price.
    const choice = chooseModel({
      config,
      current: model,
      models: loaded.job.choices ?? [],
      input: input.value,
      overridden: options.model !== undefined,
    });
    if (!choice.ok) return finish(choice.error);
    if (config.models !== undefined)
      result.modelChoice = {
        model: choice.chosen.model.id,
        thinking: choice.chosen.thinking,
        ...(options.model !== undefined
          ? { reason: "chosen by hand for this run" }
          : choice.chosen.reason === undefined
            ? {}
            : { reason: choice.chosen.reason }),
      };
    if (choice.chosen.changed) {
      model = choice.chosen.model;
      config = { ...config, model: model.id, thinking: choice.chosen.thinking };
      result.model = model.id;
      result.thinking = config.thinking;
      let again: BudgetDecision;
      try {
        again = await checkMonthlyBudget(
          config,
          priced(model),
          ledger,
          now(),
          mediaReserve,
        );
      } catch (err) {
        return finish(`${firstLine(err)}; the job did not start`);
      }
      if (!again.ok) return finish(again.reason);
      budget = again;
      if (budget.reserveUsd > gateway.key_max_usd)
        return finish(
          `a run of ${config.name} at ${model.id} can cost up to ${budget.reserveUsd.toFixed(2)}, over the gateway's ${gateway.key_max_usd} ceiling for one key (key_max_usd in gateway.yml)`,
        );
      result.budget = { ...result.budget!, reserveUsd: budget.reserveUsd };
    }
    writeDataFiles(dirs.data, {
      prompt: buildPrompt(
        revise === undefined
          ? loaded.job.prompt
          : `${loaded.job.prompt.trimEnd()}\n${revisionPrompt()}`,
      ),
      input: input.value,
      schema:
        revise === undefined
          ? withMaintainerNotes(loaded.job.outputSchema)
          : withRevisionReplies(withMaintainerNotes(loaded.job.outputSchema)),
    });

    // The one directory lbx mounts into the box besides the data directory.
    const who = options.identity ?? currentIdentity();
    const socketDir = createSocketDir(
      options.socketBases ?? socketDirBases(env, dirs.root),
      {
        who,
        dataDir: dirs.data,
        stateDir: dirs.state,
        lbxDir: dirs.lbx,
        cwd: process.cwd(),
        runtimeDirs: runtimeDirs(env, who.uid),
      },
    );
    releaseSocketDir = removeOnExit(socketDir);

    // The model's tools server starts before the box, on the tools socket.
    if (config.tools.length > 0) {
      const running = upstreams ?? (await startUpstreams());
      tools = await timed("tools", () =>
        serveTools({
          root: options.root,
          job: config,
          dir: dirs.data,
          socketPath: join(socketDir, TOOLS_SOCKET),
          names: config.tools,
          limits: toolLimits(config),
          upstreams: running,
          ...(config.pin_files === true
            ? { commits: inputCommits(input.value) }
            : {}),
          ...(options.tools === undefined ? {} : { hooks: options.tools }),
          now,
        }),
      );
    }

    // The run's own gateway key, issued last so it lives no longer than the box needs.
    if (client !== undefined) {
      const minutes = keyMinutes(config);
      const metadata: Record<string, string> = {};
      if (/^\d+$/.test(env.GITHUB_RUN_ID ?? ""))
        metadata.workflow_run = env.GITHUB_RUN_ID!;
      if (/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? ""))
        metadata.sha = env.GITHUB_SHA!;
      try {
        const issued = await timed("gateway-key", () =>
          issueRunKey(client!, {
            job: config.name,
            model,
            ...(reviewOn === undefined ? {} : { alsoModels: [reviewOn.model] }),
            month: budget.month,
            runName: name,
            maxBudgetUsd: budget.reserveUsd,
            minutes,
            metadata,
          }),
        );
        report.addSecrets([issued.key]);
        runKey = issued;
      } catch (err) {
        return finish(`${firstLine(err)}; the job did not start`);
      }
      Object.assign(gatewayRecord, {
        keyAlias: runKey.alias,
        keyId: runKey.id,
        maxBudgetUsd: budget.reserveUsd,
        minutes,
        ...(runKey.expires === undefined ? {} : { expires: runKey.expires }),
      });
    }

    // The box's only way to the model: the forwarder on the model socket, adding the run's gateway key outside the box.
    if (client !== undefined && runKey !== undefined) {
      forwarder = await startModelForwarder({
        socketPath: join(socketDir, MODEL_SOCKET),
        client,
        key: runKey.key,
        model: gatewayModelName(model),
        maxTokens: config.limits.tokens_per_run,
        now,
      });
    }
    const entries = socketEntriesProblem(socketDir, who.uid, [
      ...(forwarder === undefined ? [] : [MODEL_SOCKET]),
      ...(tools === undefined ? [] : [TOOLS_SOCKET]),
    ]);
    if (entries !== undefined)
      return finish(`the socket directory is not as lbx needs it: ${entries}`);

    // d. The lbx configuration; the box gets no network, only the socket directory.
    const lbxConfig = writeLbxConfig(dirs.lbx, box?.image ?? STUB_IMAGE);

    // e. The command line.
    result.argv = buildLbxArgv({
      lbx,
      network: { socketDir },
      dataDir: dirs.data,
      timeoutSeconds: runTimeoutSeconds(config.limits.turns),
      runName: name,
      command: piCommand(piModel(model), config.thinking, config.tools, {
        shell: config.shell === true,
      }),
    });

    // f. Execute.
    const launcher =
      options.launcher ??
      (stub
        ? new StubLauncher(
            readFileSync(
              join(options.root, jobFile(config.name, "fixtures/output.json")),
              "utf8",
            ),
          )
        : new LbxLauncher());
    const answerPath = join(dirs.data, DATA_FILES.answer);
    const launch: LaunchResult = await timed("run", () =>
      launcher.launch({
        argv: result.argv,
        env: {
          ...lbxEnv,
          LLMBOX_CONFIG: lbxConfig,
          LLMBOX_STATE_DIR: dirs.state,
        },
        stateDir: dirs.state,
        runName: name,
        answerPath,
      }),
    );
    result.launch = launch;
    const recordUntrusted = () => {
      result.untrustedInput = untrustedInput(
        tools === undefined ? [] : untrustedTools(tools.server.results),
        collectUntrusted,
      );
    };
    recordUntrusted();
    // A failed run may still have used the model, so every real launch is recorded.
    if (launcher.kind === "lbx")
      await ledger.record({
        job: config.name,
        month: budget.month,
        runName: name,
        usd: budget.reserveUsd,
      });

    const saveTranscripts = (at: string) => {
      for (const file of sessionFiles(
        join(dirs.data, DATA_FILES.sessions),
      ).slice(0, MAX_TRANSCRIPT_FILES)) {
        const text = readUntrusted(
          join(dirs.data, DATA_FILES.sessions, file),
          MAX_TRANSCRIPT_BYTES,
        );
        if ("text" in text) report.write(`${at}${file}`, text.text);
      }
    };
    saveTranscripts("transcript/");

    // g. Validate the answer.
    const raw = readUntrusted(answerPath, MAX_ANSWER_BYTES);
    if ("text" in raw) report.write("answer.txt", raw.text);
    const status = launch.status;
    if (status === undefined)
      return finish(
        `lbx ended with exit code ${launch.exitCode} and no status`,
      );
    if (status.cleanupIncomplete === true)
      return finish(
        "lbx could not remove everything this run created; its standard error names the leftovers",
      );
    if (status.status !== "exited" || status.code !== 0) {
      return finish(
        status.status === "exited"
          ? `Pi exited with code ${status.code}`
          : `lbx reported status=${status.status} code=${status.code}`,
      );
    }
    if ("error" in raw) return finish(`the answer file ${raw.error}`);

    // What an answer holds once the maintainer notes (and a revision's replies) come off, and what is wrong with it.
    interface ReadAnswer {
      notJson?: string;
      answer?: unknown;
      notes: readonly MaintainerNote[];
      warning?: string;
      /** What parseAnswer left off after the answer, said in one line. */
      ignored?: string;
      replies?: RevisionReply[];
      problems: string[];
    }
    const readAnswer = (text: string): ReadAnswer => {
      const parsed = parseAnswer(text);
      if ("error" in parsed)
        return { notJson: parsed.error, notes: [], problems: [parsed.error] };
      const split = splitMaintainerNotes(parsed.value);
      let answer = split.answer;
      let replies: RevisionReply[] | undefined;
      if (revisionRound !== undefined) {
        const r = splitRevisionReplies(answer);
        answer = r.answer;
        replies = r.replies;
      }
      return {
        answer,
        notes: split.notes,
        ...(parsed.warning === undefined ? {} : { ignored: parsed.warning }),
        ...(split.warning === undefined ? {} : { warning: split.warning }),
        ...(replies === undefined ? {} : { replies }),
        problems: answerProblems(answer, loaded.job.outputSchema),
      };
    };

    // The one repair turn: Pi continues its own session in a new box, on the same data directory, sockets and key, told exactly what is wrong.
    const repairTurn = async (
      first: ReadAnswer,
    ): Promise<ReadAnswer | undefined> => {
      const record: RepairRecord = {
        problems: first.problems,
        outcome: "skipped",
      };
      result.repair = record;
      const session = sessionToContinue(join(dirs.data, DATA_FILES.sessions));
      if (session === undefined) {
        record.reason = "the run left no Pi session to continue";
        return undefined;
      }
      // The repair turn counts against the run's own time limit, as it does against its key's budget.
      const seconds = repairSeconds(
        runTimeoutSeconds(config.limits.turns),
        timings.find((t) => t.step === "run")?.ms ?? 0,
      );
      if (seconds === 0) {
        record.reason =
          "the writer used up the run's time limit (limits.turns)";
        return undefined;
      }
      const prompt = repairPrompt({
        notJson: first.notJson !== undefined,
        problems: first.problems,
        sizes:
          first.notJson === undefined
            ? sizeNotes(first.answer, loaded.job.outputSchema)
            : [],
      });
      try {
        writeFileSync(join(dirs.data, DATA_FILES.repair), prompt, {
          mode: 0o600,
          flag: "wx",
        });
      } catch (err) {
        record.reason = `the repair request could not be written: ${firstLine(err)}`;
        return undefined;
      }
      report.write("repair/prompt.md", prompt);
      // The tools socket closed with the writer's session; the repair box gets a new session on it.
      try {
        await tools?.nextSession();
      } catch (err) {
        record.reason = `the tools socket could not be opened again: ${firstLine(err)}`;
        return undefined;
      }
      const entries = socketEntriesProblem(socketDir, who.uid, [
        ...(forwarder === undefined ? [] : [MODEL_SOCKET]),
        ...(tools === undefined ? [] : [TOOLS_SOCKET]),
      ]);
      if (entries !== undefined) {
        record.reason = `the socket directory is not as lbx needs it: ${entries}`;
        return undefined;
      }
      const repairName = `${name}-repair`;
      const argv = buildLbxArgv({
        lbx,
        network: { socketDir },
        dataDir: dirs.data,
        timeoutSeconds: seconds,
        runName: repairName,
        command: piCommand(piModel(model), config.thinking, config.tools, {
          shell: config.shell === true,
          session,
        }),
      });
      report.writeJson("repair/argv.json", argv);
      record.outcome = "failed";
      const ran: LaunchResult = await timed("repair", () =>
        launcher.launch({
          argv,
          env: {
            ...lbxEnv,
            LLMBOX_CONFIG: lbxConfig,
            LLMBOX_STATE_DIR: dirs.state,
          },
          stateDir: dirs.state,
          runName: repairName,
          answerPath,
        }),
      );
      saveTranscripts("repair/transcript/");
      const again = readUntrusted(answerPath, MAX_ANSWER_BYTES);
      if ("text" in again) report.write("repair/answer.txt", again.text);
      const s = ran.status;
      if (s === undefined || s.status !== "exited" || s.code !== 0) {
        record.reason =
          s === undefined
            ? `lbx ended with exit code ${ran.exitCode} and no status`
            : `the repair turn ended with status=${s.status} code=${s.code}`;
        return undefined;
      }
      if (s.cleanupIncomplete === true) {
        record.reason =
          "lbx could not remove everything the repair turn created";
        return undefined;
      }
      if ("error" in again) {
        record.reason = `the answer file ${again.error}`;
        return undefined;
      }
      const read = readAnswer(again.text);
      if (read.problems.length === 0) record.outcome = "repaired";
      else record.problemsAfter = read.problems;
      return read;
    };

    const first = await timed("validate", () => readAnswer(raw.text));
    const final =
      first.problems.length === 0
        ? first
        : ((await repairTurn(first)) ?? first);
    // The repair turn may have called tools too.
    await closeTools();
    recordUntrusted();
    // A pull request job may need the model once more, for the second check; finish() closes these on every path.
    if (config.output.kind !== "pr") {
      await closeForwarder();
      await closeGateway();
    }
    const afterRepair =
      result.repair === undefined || result.repair.outcome === "repaired"
        ? ""
        : result.repair.outcome === "failed"
          ? result.repair.reason === undefined
            ? ", also after the repair turn"
            : `; the repair turn failed: ${result.repair.reason}`
          : `; no repair turn: ${result.repair.reason ?? "it could not run"}`;

    // The maintainer notes come off before anything else reads the answer, and are kept whether or not the answer passes: the final answer's, or the first one's when the final one is not JSON.
    const noted = final.notJson === undefined ? final : first;
    if (noted.ignored !== undefined) {
      result.answerWarning = noted.ignored;
      log(`warning: ${noted.ignored}`);
    }
    if (noted.notJson === undefined) {
      notes = noted.notes;
      result.maintainerNotes = {
        count: noted.notes.length,
        ...(noted.warning === undefined ? {} : { warning: noted.warning }),
      };
      if (noted.warning !== undefined) log(`warning: ${noted.warning}`);
      report.writeJson(MAINTAINER_NOTES_FILE, {
        job: config.name,
        runName: name,
        model: config.model,
        notes: noted.notes,
        ...(noted.warning === undefined ? {} : { warning: noted.warning }),
      });
    }
    if (final.notJson !== undefined)
      return finish(`${final.notJson}${afterRepair}`);
    const answer = final.answer;
    if (revisionRound !== undefined) {
      revisionRound.replies = final.replies ?? [];
      report.writeJson("revision/replies.json", revisionRound.replies);
    }

    result.answerProblems = final.problems;
    if (result.answerProblems.length > 0)
      return finish(
        `the answer does not match ${jobFile(config.name, "output.json")} (${result.answerProblems.length} problem${result.answerProblems.length === 1 ? "" : "s"})${afterRepair}`,
      );

    // h. The answer stays in the report, and so does the Slack message render.ts makes of it (a slack job without render.ts gets the plain one).
    report.writeJson("answer.json", answer);
    let message: SlackMessage | undefined;
    if (hasRender(options.root, config.name)) {
      message = await timed("render", () =>
        renderSlackMessage({
          root: options.root,
          name: config.name,
          answer,
          env,
          model: config.model,
        }),
      );
    } else if (config.output.kind === "slack") {
      message = plainSlackMessage({
        name: config.name,
        answer,
        env,
        model: config.model,
      });
    }
    if (message !== undefined) {
      report.writeJson("slack.json", message);
      report.write("slack.md", slackMarkdown(message));
      result.slack = { blocks: message.blocks.length, posted: false };
    }

    // i. Quotes of tool results must be in what the tools returned.
    if (tools !== undefined) {
      if (stub) {
        result.citations = {
          status: "skipped",
          reason: "a stub run calls no tools",
        };
      } else {
        const citations = checkCitations(
          answer,
          tools.server.results,
          config.tools,
        );
        result.citations = { status: "checked", citations };
        const missed = citations.filter((c) => !c.found);
        if (missed.length > 0)
          return finish(
            `the answer quotes text no tool returned (${missed.length} of ${citations.length}: ${missed.map((c) => c.path).join(", ")})`,
          );
      }
    }

    if (keyFrom?.from === "answer") {
      const key = branchKeyOf(answer, keyFrom);
      if ("error" in key) return finish(key.error);
      branchKey = key.key;
    }

    // i2. A pull request job with publish.ts: the job's code turns the answer into the patch set to deliver, or into nothing.
    let deliverable: unknown = answer;
    let sections: PrSection[] | undefined;
    if (config.output.kind === "pr" && hasPublish(options.root, config.name)) {
      const published = await timed("publish", () =>
        runPublishScript({
          root: options.root,
          name: config.name,
          answer,
          input: input.value,
          env,
        }),
      );
      report.writeJson("publish.json", published);
      if (!published.publish) {
        result.publish = { publish: false, reason: published.reason };
        result.delivery = { outcome: "nothing", reason: published.reason };
        if (published.sections !== undefined) {
          analysisMarkdown = renderSections(published.sections).join("\n");
          report.write("analysis.md", analysisMarkdown);
        }
        await closeForwarder();
        await closeGateway();
        // publish.ts may give a short analysis instead, posted to output.notify.
        if (published.message !== undefined) {
          const analysis =
            published.message === "render"
              ? message
              : {
                  text: published.message.text,
                  blocks: [
                    ...published.message.blocks,
                    footerBlock({
                      runUrl: workflowRunUrl(env),
                      job: config.name,
                      model: config.model,
                    }),
                  ],
                  unfurl_links: false as const,
                  unfurl_media: false as const,
                };
          if (analysis === undefined)
            return finish(
              `${jobFile(config.name, "publish.ts")} asks to post the message of render.ts, but the job has none`,
            );
          const runUrl = workflowRunUrl(env);
          const posted = await timed("analysis", () =>
            postAnalysis({
              job: config.name,
              output: config.output as Extract<
                typeof config.output,
                { kind: "pr" }
              >,
              mode: config.mode,
              stub,
              message: analysis,
              ...(loaded.job.prNotify === undefined
                ? {}
                : { notify: loaded.job.prNotify }),
              ...(runUrl === undefined ? {} : { runUrl }),
              untrusted: result.untrustedInput!,
              report,
              openPoster: options.poster ?? (() => openSlackPoster(env)),
            }),
          );
          result.analysis = posted.record;
          if (posted.failure !== undefined) return finish(posted.failure);
        }
        return finish();
      }
      const offList = sectionLinkProblems(
        published.sections ?? [],
        loaded.job.links,
      );
      if (offList.length > 0)
        return finish(
          `${jobFile(config.name, "publish.ts")} wrote a section link the kit does not allow: ${offList[0]}`,
        );
      result.publish = { publish: true };
      deliverable = published.answer;
      sections = published.sections;
    }

    // j. A pull request job: the PR checker, the untrusted-input gate, the second check, then delivery.
    if (config.output.kind === "pr") {
      // The second check is the same kind of run in a fresh data directory: no tools, no shell, only the review input.
      // A proposal too big for one review is reviewed one page at a time: each call gets its own name and report folder.
      let reviews = 0;
      const review = async (
        reviewInput: ReviewInput,
      ): Promise<{ verdict: ReviewVerdict } | { error: string }> => {
        reviews += 1;
        // A second check on another model gets its own forwarder on the same socket, once the writer's box is done.
        if (
          reviews === 1 &&
          reviewOn !== undefined &&
          forwarder !== undefined &&
          client !== undefined &&
          runKey !== undefined
        ) {
          writerForwarder = forwarder;
          forwarder = undefined;
          try {
            await writerForwarder.stop();
            forwarder = await startModelForwarder({
              socketPath: join(socketDir, MODEL_SOCKET),
              client,
              key: runKey.key,
              model: gatewayModelName(reviewOn.model),
              maxTokens: config.limits.tokens_per_run,
              now,
            });
          } catch (err) {
            return {
              error: `the second check's model could not be reached: ${firstLine(err)}`,
            };
          }
        }
        const suffix = reviews === 1 ? "" : `-${reviews}`;
        const at = reviewFolder(reviews);
        const reviewName = `${name}-review${suffix}`;
        const rdirs = createRunDirs(
          dirs.root,
          `${config.name}-review${suffix}`,
          who,
        );
        writeDataFiles(rdirs.data, {
          prompt: reviewPrompt(
            config.output.kind === "pr" && config.output.code_fix === true,
          ),
          input: reviewInput,
          schema: REVIEW_SCHEMA,
        });
        report.writeJson(`${at}/input.json`, reviewInput);
        const entries = socketEntriesProblem(
          socketDir,
          who.uid,
          forwarder === undefined ? [] : [MODEL_SOCKET],
        );
        if (entries !== undefined)
          return {
            error: `the socket directory is not as lbx needs it: ${entries}`,
          };
        const argv = buildLbxArgv({
          lbx,
          network: { socketDir },
          dataDir: rdirs.data,
          timeoutSeconds: REVIEW_TIMEOUT_SECONDS,
          runName: reviewName,
          command:
            reviewOn === undefined
              ? piCommand(piModel(model), config.thinking)
              : piCommand(piModel(reviewOn.model), reviewOn.thinking),
        });
        report.writeJson(`${at}/argv.json`, argv);
        const reviewLauncher =
          options.reviewLauncher ??
          (stub ? new StubLauncher(STUB_REVIEW_ANSWER) : launcher);
        const reviewAnswer = join(rdirs.data, DATA_FILES.answer);
        const ran: LaunchResult = await timed("review", () =>
          reviewLauncher.launch({
            argv,
            env: {
              ...lbxEnv,
              LLMBOX_CONFIG: writeLbxConfig(
                rdirs.lbx,
                box?.image ?? STUB_IMAGE,
              ),
              LLMBOX_STATE_DIR: rdirs.state,
            },
            stateDir: rdirs.state,
            runName: reviewName,
            answerPath: reviewAnswer,
          }),
        );
        for (const file of sessionFiles(
          join(rdirs.data, DATA_FILES.sessions),
        ).slice(0, MAX_TRANSCRIPT_FILES)) {
          const text = readUntrusted(
            join(rdirs.data, DATA_FILES.sessions, file),
            MAX_TRANSCRIPT_BYTES,
          );
          if ("text" in text)
            report.write(`${at}/transcript/${file}`, text.text);
        }
        const rawReview = readUntrusted(reviewAnswer, MAX_ANSWER_BYTES);
        if ("text" in rawReview)
          report.write(`${at}/answer.txt`, rawReview.text);
        const s = ran.status;
        if (s === undefined || s.status !== "exited" || s.code !== 0)
          return {
            error:
              s === undefined
                ? `lbx ended with exit code ${ran.exitCode} and no status`
                : `the second check ended with status=${s.status} code=${s.code}`,
          };
        if (s.cleanupIncomplete === true)
          return {
            error: "lbx could not remove everything the second check created",
          };
        if ("error" in rawReview)
          return { error: `the second check's answer file ${rawReview.error}` };
        return parseVerdict(rawReview.text);
      };
      // Another second check runs only while the run's key has enough left (anotherReviewProblem).
      const reviewBudget = async (): Promise<string | undefined> => {
        if (client === undefined || runKey === undefined) return undefined;
        try {
          const spent = await keySpendUsd(client, runKey.id);
          // A static provider reports no spend, so nothing says another second check is over the run's reserve.
          if (spent === undefined) return undefined;
          return anotherReviewProblem(spent, budget.reserveUsd);
        } catch (err) {
          return `the run's spend could not be read: ${firstLine(err)}`;
        }
      };
      const prOutput = config.output as Extract<
        typeof config.output,
        { kind: "pr" }
      >;
      const runUrl = workflowRunUrl(env);
      const cited =
        options.readCitedFile !== undefined
          ? {
              read: options.readCitedFile,
              json: options.readGithub,
              close: async () => undefined,
            }
          : stub || !env[READER_APP_ID_ENV] || !env[READER_PRIVATE_KEY_ENV]
            ? undefined
            : citedFileReader(env, (secret) => report.addSecrets([secret]));
      const stage = await timed("deliver", () =>
        runPrStage({
          job: config.name,
          previews: loaded.job.previews,
          repoCode: loaded.job.repoCode,
          output: prOutput,
          mode: config.mode,
          stub,
          answer: deliverable,
          ...(result.publish?.publish === true ? { published: true } : {}),
          input: input.value,
          jobPrompt: loaded.job.prompt,
          untrusted: result.untrustedInput!,
          model: config.model,
          runName: name,
          ...(runUrl === undefined ? {} : { runUrl }),
          report,
          now: now(),
          review,
          // Model access closes once the second check is done, before delivery reads what the run spent.
          reviewDone: async () => {
            await closeForwarder();
            await closeGateway();
          },
          ...(prOutput.drop_refused_changes === true &&
          result.publish?.publish === true
            ? {
                dropRefused: (refused) =>
                  timed("publish", async () => {
                    const rebuilt = await runPublishScript({
                      root: options.root,
                      name: config.name,
                      answer,
                      input: input.value,
                      env,
                      refused,
                    });
                    const off = rebuilt.publish
                      ? sectionLinkProblems(
                          rebuilt.sections ?? [],
                          loaded.job.links,
                        )
                      : [];
                    if (off.length > 0)
                      throw new Error(
                        `${jobFile(config.name, "publish.ts")} wrote a section link the kit does not allow: ${off[0]}`,
                      );
                    return rebuilt;
                  }),
                reviewBudget: () => reviewBudget(),
              }
            : {}),
          ...(cited === undefined ? {} : { readCitedFile: cited.read }),
          ...(cited?.json === undefined ? {} : { readGithub: cited.json }),
          costUsd: () => gatewayRecord.spendUsd,
          ...(branchKey === undefined ? {} : { branchKey }),
          ...(sections === undefined ? {} : { sections }),
          ...(prOutput.pages_on_demand === undefined
            ? {}
            : {
                pagesOnDemand: {
                  paths: prOutput.pages_on_demand.paths,
                  ...(cited === undefined ? {} : { read: cited.read }),
                  ...(cited?.json === undefined ? {} : { json: cited.json }),
                },
              }),
          ...(prOutput.tool_citations === true
            ? {
                toolQuotes: {
                  tools: config.tools,
                  ...(stub ? {} : { results: tools?.server.results ?? [] }),
                },
              }
            : {}),
          ...(loaded.job.prNotify === undefined
            ? {}
            : {
                notify: loaded.job.prNotify,
                openPoster: options.poster ?? (() => openSlackPoster(env)),
              }),
          ...(media === undefined || config.media?.pr_paths === undefined
            ? {}
            : {
                media: {
                  dir: media.dir,
                  manifest: media.manifest,
                  paths: config.media.pr_paths,
                },
              }),
          openWriter:
            revisionWriter !== undefined
              ? () =>
                  Promise.resolve({
                    writer: revisionWriter!.writer,
                    secrets: [],
                    close: () => Promise.resolve(),
                  })
              : (options.writer ?? ((repos) => openGithubWriter(env, repos))),
          ...(revisionRound === undefined || revisionInput === undefined
            ? {}
            : {
                revision: {
                  branch: String(
                    (revisionInput.revision as { branch: string }).branch,
                  ),
                  round: revisionRound.round,
                },
              }),
        }),
      );
      await cited?.close();
      result.delivery = stage.record;
      if (stage.failure !== undefined) return finish(stage.failure);
    }

    // k. A slack job: the message rules, the untrusted-input gate, then one post.
    if (config.output.kind === "slack") {
      const runUrl = workflowRunUrl(env);
      const stage = await timed("deliver", () =>
        runSlackStage({
          job: config.name,
          output: config.output as Extract<
            typeof config.output,
            { kind: "slack" }
          >,
          channel: loaded.job.slack!.channel,
          ...(loaded.job.slack!.shadow === undefined
            ? {}
            : { shadowChannel: loaded.job.slack!.shadow }),
          links: loaded.job.slack!.links,
          mode: config.mode,
          stub,
          message: message!,
          ...(runUrl === undefined ? {} : { runUrl }),
          untrusted: result.untrustedInput!,
          report,
          openPoster: options.poster ?? (() => openSlackPoster(env)),
        }),
      );
      result.slack = {
        ...result.slack!,
        posted: stage.record.outcome === "delivered",
        delivery: stage.record,
      };
      if (stage.failure !== undefined) return finish(stage.failure);
    }
    return finish();
  } catch (err) {
    return finish(firstLine(err));
  }
}

/**
 * Reads files at a commit, and commits and pull requests as JSON, with one
 * installation token of the reader app, made on the first read and revoked
 * by close(), for the second check's cited files and credited commits.
 */
export function citedFileReader(
  env: NodeJS.ProcessEnv,
  addSecret: (secret: string) => void,
  fetchFn: typeof fetch = fetch,
  makeToken: () => Promise<{ token: string; revoke(): Promise<void> }> = () =>
    createInstallationToken({
      appId: env[READER_APP_ID_ENV] ?? "",
      privateKey: env[READER_PRIVATE_KEY_ENV] ?? "",
    }),
): {
  read: CitedFileReader;
  json: GithubJsonReader;
  close(): Promise<void>;
} {
  let token: Promise<{ token: string; revoke(): Promise<void> }> | undefined;
  const tokenFor = () =>
    (token ??= makeToken().then((t) => {
      addSecret(t.token);
      return t;
    }));
  return {
    async read(repo, commit, path) {
      const [owner, name] = repo.split("/");
      const t = await tokenFor();
      const res = await fetchFn(
        `${GITHUB_API}/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(commit)}`,
        {
          headers: {
            accept: "application/vnd.github.raw+json",
            authorization: `token ${t.token}`,
            "x-github-api-version": "2022-11-28",
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (res.status === 404) {
        await res.body?.cancel();
        return undefined;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`GitHub answered ${res.status}`);
      }
      return res.text();
    },
    async json(path) {
      if (!path.startsWith("/repos/"))
        throw new Error(`${path} is not a repository path`);
      const t = await tokenFor();
      const res = await fetchFn(`${GITHUB_API}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `token ${t.token}`,
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      });
      // 422: GitHub knows no commit by that sha.
      if (res.status === 404 || res.status === 422) {
        await res.body?.cancel();
        return undefined;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`GitHub answered ${res.status}`);
      }
      return JSON.parse(
        (await readCapped(res, MAX_COMPARE_BYTES)).toString("utf8"),
      ) as unknown;
    },
    async close() {
      if (token === undefined) return;
      await (await token).revoke().catch(() => undefined);
    },
  };
}

/** The branch key of a job with output.branch_key, read from the input or the answer, or why there is none. */
export function branchKeyOf(
  source: unknown,
  from: BranchKey,
): { key: string } | { error: string } {
  const value =
    typeof source === "object" && source !== null && !Array.isArray(source)
      ? (source as Record<string, unknown>)[from.field]
      : undefined;
  if (typeof value !== "string" || !isBranchKey(value))
    return {
      error: `the ${from.from}'s ${from.field} is not a branch key (output.branch_key): two to eight groups of lowercase letters and digits joined by hyphens, at most 64 characters, never a date`,
    };
  return { key: value };
}
