import { appendFileSync, chmodSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { scratchBase } from "./data-dir.ts";
import {
  openGithubWriter,
  WRITER_SECRET_ENV,
} from "../deliver/github-writer.ts";
import {
  openSlackPoster,
  SLACK_POST_TOKEN_ENV,
} from "../deliver/slack-poster.ts";
import { readDocsState } from "../deliver/video-map.ts";
import { readVideoHistory } from "../deliver/video-history.ts";
import { openYouTube, YOUTUBE_SECRET_ENV } from "../deliver/youtube.ts";
import { modelKeyEnv } from "../lib/gateway.ts";
import {
  EDITION_HEAP,
  jobEnvs,
  TARGET_ENV_ENV,
  mediaPart,
  monthlyBudgetUsd,
  NO_MODEL,
  partStage,
  type MediaStage,
} from "../lib/job.ts";
import { loadLinkHosts } from "../lib/link-hosts.ts";
import {
  EDITION_HEAP_ENV,
  MEDIA_DIR,
  MEDIA_DISPATCH_TOKEN_ENV,
  MEDIA_INPUTS_ENV,
  MEDIA_MANIFEST,
  MEDIA_ORG_READ_ENV,
  MEDIA_PART_ENV,
  MEDIA_READ_TOKEN_ENV,
  mediaPartArtifact,
  readMediaManifest,
  type MediaManifest,
} from "../lib/media.ts";
import {
  leavePartFailure,
  leavePartMedia,
  mergeMediaParts,
} from "./media-parts.ts";
import { firstLine } from "../lib/problem.ts";
import {
  READER_APP_ID_ENV,
  READER_PRIVATE_KEY_ENV,
} from "../revise/original.ts";
import { runName as makeRunName } from "./argv.ts";
import type { NoModelJob } from "./load.ts";
import {
  appendStepSummary,
  redact,
  ReportWriter,
  secretValues,
  summaryMarkdown,
  type RunReport,
  type Timing,
} from "./report.ts";
import { keepMedia, runMediaStage } from "./media.ts";
import {
  MEDIA_FORWARDER_FILE,
  openMediaModel,
  type OpenedMediaModel,
} from "./media-model.ts";
import {
  checkReserve,
  noopLedger,
  type BudgetDecision,
  type Ledger,
} from "./budget.ts";
import { GatewayClient, gatewayLedger } from "./gateway.ts";
import { socketDirBases } from "./socket-dir.ts";
import { runNoModelPrStage } from "./no-model-pr.ts";
import type { RunOptions, RunResult } from "./run.ts";
import { runTrigger } from "../deliver/check-results.ts";
import { workflowRunUrl } from "./slack-render.ts";
import { runYouTubeStage } from "./youtube-output.ts";
import {
  resultsArtifact,
  resultsRunId,
  runResultsFailure,
  runResultsStage,
} from "./results-output.ts";
import { PREVIOUS_TOKEN_ENV, previousResultsRun } from "./previous-results.ts";

/** What --reason takes: one line of printable ASCII, at most 200 characters. */
export const REASON = /^[\x20-\x7e]{1,200}$/;
import { runYouTubeTidy } from "./youtube-tidy.ts";

function missing(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  return names.filter((n) => (env[n] ?? "").trim() === "");
}

/**
 * Runs a job with model: none: no box and no model of its own; only a
 * media.model gets a gateway key, for the media stage, with its budget. The
 * kit builds the answer from the media manifest (for output kind youtube,
 * from the scenarios; for output kind pr, the pages and answer media.ts
 * built in data.pr), then the same checks and delivery as for a model's
 * answer, and the same report. Output kind file delivers nothing: the
 * report keeps the media stage's manifest and files.
 */
export async function runNoModelJob(
  options: RunOptions,
  job: NoModelJob,
  timings: Timing[],
  timed: <T>(step: string, fn: () => T | Promise<T>) => Promise<T>,
): Promise<RunResult> {
  const env = options.env ?? process.env;
  const stub = options.stub ?? false;
  const now = options.now ?? (() => new Date());
  const { config } = job;
  const output = config.output;
  const fail = (...messages: string[]): RunResult => ({ ok: false, messages });
  if (options.revise !== undefined)
    return fail(
      `${config.name} opens no pull requests (output kind ${output.kind}), so it has none to revise`,
    );
  const prPaths = config.media?.pr_paths;
  if (
    output.kind !== "youtube" &&
    output.kind !== "file" &&
    output.kind !== "results" &&
    (output.kind !== "pr" || prPaths === undefined)
  )
    return fail(
      `${config.name}: a job with model: ${NO_MODEL} needs output kind youtube, results, output kind pr with media.pr_paths, or output kind file, whose answer its media stage builds`,
    );
  // A check job checks one environment a run; a stub run takes the first.
  const envs = jobEnvs(config);
  let target: string | undefined;
  if (output.kind === "results") {
    target = options.targetEnv ?? (stub ? envs[0] : undefined);
    if (target === undefined)
      return fail(
        `${config.name} checks one environment a run; pass --env with one of ${envs.join(", ")}`,
      );
    if (!(envs as string[]).includes(target))
      return fail(
        `--env: "${target}" is not one of the environments ${config.name} checks (${envs.join(", ")})`,
      );
    if (options.reason !== undefined && !REASON.test(options.reason))
      return fail(
        "--reason takes one line of printable ASCII, at most 200 characters",
      );
  } else if (options.targetEnv !== undefined || options.reason !== undefined)
    return fail(
      `--env and --reason are for a check job (output kind results); ${config.name} delivers ${output.kind}`,
    );
  const results = output.kind === "results" ? job.results : undefined;
  if (options.findPrevious === true) {
    if (results === undefined || target === undefined)
      return fail("--find-previous is for a check job (output kind results)");
    return findPrevious(options, env, config.name, config.mode, target);
  }
  if (
    (options.previous !== undefined || options.resultsOut !== undefined) &&
    results === undefined
  )
    return fail(
      "--previous and --results-out are for a check job (output kind results)",
    );
  const parts = config.media?.parts;
  const part =
    options.part === undefined ? undefined : mediaPart(config, options.part);
  if (
    (options.part !== undefined || options.mediaParts !== undefined) &&
    parts === undefined
  )
    return fail(`${config.name}: its media stage has no parts`);
  if (options.part !== undefined && part === undefined)
    return fail(
      `${config.name}: ${options.part} is not one of its media parts (${parts!.map((p) => p.id).join(", ")})`,
    );
  if (options.part !== undefined && options.mediaParts !== undefined)
    return fail("--part records one part; --media-parts delivers them all");
  if (options.editionHeap !== undefined) {
    if (part?.edition_heap !== true)
      return fail(
        `--edition-heap is only for a part with edition_heap: true in job.yml`,
      );
    if (!EDITION_HEAP.test(options.editionHeap))
      return fail(
        `--edition-heap takes a size java's -Xmx takes, such as 8g or 4096m, not "${options.editionHeap}"`,
      );
  }
  const inputNames = (config.media?.inputs ?? []).map((i) => i.name);
  for (const name of options.mediaInputs ?? [])
    if (!inputNames.includes(name))
      return fail(
        inputNames.length === 0
          ? `${config.name}: --media-input ${name}: its media stage has no inputs`
          : `${config.name}: --media-input ${name} is not one of its media inputs (${inputNames.join(", ")})`,
      );
  if (options.unlistOnly === true) {
    if (output.kind !== "youtube" || output.unlist_replaced === undefined)
      return fail(
        `${config.name}: --unlist-only is for a youtube job with output.unlist_replaced`,
      );
    if (
      options.part !== undefined ||
      options.mediaParts !== undefined ||
      options.mediaDir !== undefined
    )
      return fail(
        "--unlist-only records and uploads nothing; it takes no part or media",
      );
    if (options.preflight)
      return {
        ok: true,
        messages: [
          `${config.name}: ready to unlist replaced videos (unlist_replaced mode ${output.unlist_replaced.mode}).`,
        ],
      };
    return runUnlistOnly(options, job, output, timings, timed);
  }
  // A part run records and delivers nothing; the delivery run records nothing.
  const recording = options.mediaParts === undefined;
  const delivering = part === undefined;
  const stage: MediaStage | undefined =
    part === undefined || config.media === undefined
      ? config.media
      : partStage(config.media, part);
  if (options.preflight)
    return {
      ok: true,
      messages: [
        `${config.name}: ready to run (mode ${config.mode}, no model${part === undefined ? "" : `, part ${part.id}`}${target === undefined ? "" : `, env ${target}`}).`,
      ],
    };

  // A media stage with media.model gets a key of its own; the runner holds the issuer key.
  const usesMediaModel =
    !stub &&
    recording &&
    options.mediaDir === undefined &&
    job.mediaModel !== undefined &&
    stage?.model !== undefined;
  if (!stub) {
    const needed = [
      ...(recording && options.mediaDir === undefined
        ? (stage?.secrets ?? [])
        : []),
      ...(usesMediaModel ? [modelKeyEnv()] : []),
      ...(recording &&
      options.mediaDir === undefined &&
      (stage?.read_repos ?? []).length > 0
        ? [MEDIA_READ_TOKEN_ENV]
        : []),
      ...(recording &&
      options.mediaDir === undefined &&
      stage?.org_read === true
        ? [MEDIA_ORG_READ_ENV]
        : []),
      ...(recording &&
      options.mediaDir === undefined &&
      (stage?.dispatch_repos ?? []).length > 0
        ? [MEDIA_DISPATCH_TOKEN_ENV]
        : []),
      ...(delivering &&
      output.kind === "youtube" &&
      options.readDocs === undefined
        ? [READER_APP_ID_ENV, READER_PRIVATE_KEY_ENV]
        : []),
      ...(delivering && config.mode === "live"
        ? [
            ...(output.kind === "youtube" && options.youtube === undefined
              ? YOUTUBE_SECRET_ENV
              : []),
            ...(options.writer === undefined && output.kind !== "results"
              ? WRITER_SECRET_ENV
              : []),
            ...(output.kind === "youtube" &&
            output.notify !== undefined &&
            options.poster === undefined
              ? [SLACK_POST_TOKEN_ENV]
              : []),
          ]
        : []),
      ...(delivering &&
      config.mode === "shadow" &&
      job.youtube?.shadow !== undefined &&
      options.poster === undefined
        ? [SLACK_POST_TOKEN_ENV]
        : []),
      ...(delivering &&
      job.prNotify !== undefined &&
      (config.mode === "live" || job.prNotify.shadow !== undefined) &&
      options.poster === undefined
        ? [SLACK_POST_TOKEN_ENV]
        : []),
      ...(delivering &&
      results?.alert !== undefined &&
      (config.mode === "live" || results.shadow !== undefined) &&
      options.poster === undefined
        ? [SLACK_POST_TOKEN_ENV]
        : []),
    ];
    const absent = missing(env, needed);
    if (absent.length > 0)
      return fail(
        `${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} not set; a ${config.mode} ${output.kind} job needs ${absent.length === 1 ? "it" : "them"}`,
      );
  }

  const chosen = scratchBase(options.scratch, env);
  if ("error" in chosen) return fail(chosen.error);
  const root = mkdtempSync(join(chosen.base, `job-${config.name}-`));
  chmodSync(root, 0o700);
  // The media key's budget must fit the job's month and the shared month before anything starts.
  let client: GatewayClient | undefined;
  let ledger: Ledger = noopLedger;
  let budget: Extract<BudgetDecision, { ok: true }> | undefined;
  if (usesMediaModel) {
    const { gateway, gatewayCa } = job.mediaModel!;
    client = new GatewayClient({
      gateway,
      ...(gatewayCa === undefined ? {} : { ca: gatewayCa }),
      issuerKey: env[modelKeyEnv()] ?? "",
      ...(options.gateway?.baseUrl === undefined
        ? {}
        : { baseUrl: options.gateway.baseUrl }),
      ...(options.gateway?.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.gateway.timeoutMs }),
    });
    ledger = options.ledger ?? gatewayLedger(client);
    let decision: BudgetDecision;
    try {
      decision = await timed("budget", () =>
        checkReserve(
          config.name,
          monthlyBudgetUsd(config),
          stage!.model!.usd_per_run,
          ledger,
          now(),
        ),
      );
    } catch (err) {
      return fail(`${firstLine(err)}; the job did not start`);
    }
    if (decision.ok) budget = decision;
    // An optional media model the month cannot hold: media.ts runs without its socket this time.
    else if (stage!.model!.optional === true)
      options.log?.(
        `${config.name}: ${decision.reason}; media.ts runs without its model this time`,
      );
    else return fail(decision.reason);
  }

  const report = new ReportWriter(
    options.out ?? join(root, "report"),
    secretValues(env),
  );
  const name = makeRunName(config.name, env, now());
  const result: RunReport = {
    job: config.name,
    mode: config.mode,
    launcher: "none",
    runName: name,
    model: NO_MODEL,
    inputSource: "media",
    ...(part === undefined ? {} : { part: part.id }),
    ...(target === undefined ? {} : { targetEnv: target }),
    ok: false,
    answerProblems: [],
    argv: [],
    timings,
    budget:
      budget === undefined
        ? {
            month: now().toISOString().slice(0, 7),
            spentUsd: 0,
            reserveUsd: 0,
            ledger: "none",
          }
        : {
            month: budget.month,
            spentUsd: budget.spentUsd,
            reserveUsd: budget.reserveUsd,
            ledger: ledger.durable ? "durable" : "none",
            ...(budget.shared === undefined ? {} : { shared: budget.shared }),
          },
  };
  // The results stage's settings, the same for a run with results and one without.
  const resultsOptions = (runUrl: string | undefined) => ({
    job: config.name,
    env: target!,
    mode: config.mode,
    stub,
    runId: resultsRunId(env),
    ...(runUrl === undefined ? {} : { runUrl }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    trigger: runTrigger(env, options.reason),
    report,
    now: now(),
    ...(options.previous === undefined
      ? {}
      : { previousDir: options.previous }),
    ...(options.resultsOut === undefined ? {} : { outDir: options.resultsOut }),
    ...(results!.alert === undefined ? {} : { alert: results!.alert }),
    ...(results!.shadow === undefined
      ? {}
      : { shadowChannel: results!.shadow }),
    links: results!.links,
    openPoster: options.poster ?? (() => openSlackPoster(env)),
  });
  let failure: string | undefined;
  try {
    let media: { dir: string; manifest: MediaManifest } | undefined;
    if (options.mediaDir !== undefined) {
      const dir = options.mediaDir;
      media = {
        dir,
        manifest: readMediaManifest(join(dir, MEDIA_MANIFEST), dir),
      };
      report.writeJson(`${MEDIA_DIR}/${MEDIA_MANIFEST}`, media.manifest);
    } else if (options.mediaParts !== undefined) {
      const from = options.mediaParts;
      const dir = join(root, MEDIA_DIR);
      const merged = await timed("merge-media", () =>
        mergeMediaParts(
          parts!.map((p) => p.id),
          (id) => join(from, mediaPartArtifact(config.name, id)),
          dir,
        ),
      );
      media = { dir, manifest: merged.manifest };
      result.media = {
        source: "parts",
        network: config.media!.network,
        files: merged.manifest.files.length,
        bytes: merged.manifest.files.reduce((sum, f) => sum + f.bytes, 0),
        hash: merged.manifest.hash,
        ...keepMedia(report, dir, merged.manifest),
      };
    } else {
      if (config.media === undefined || stage === undefined)
        throw new Error(
          `a job with model: ${NO_MODEL} needs media in job.yml: its media.ts makes what the job delivers`,
        );
      let mediaModel: OpenedMediaModel | undefined;
      if (client !== undefined && budget !== undefined) {
        try {
          mediaModel = await timed("media-key", () =>
            openMediaModel({
              client: client!,
              model: job.mediaModel!.model,
              ...(job.mediaModel!.fallback === undefined
                ? {}
                : { fallback: job.mediaModel!.fallback }),
              config: stage!.model!,
              stage: stage!,
              job: config.name,
              month: budget!.month,
              runName: name,
              socketBases: options.socketBases ?? socketDirBases(env, root),
              ...(env.GITHUB_RUN_ID === undefined
                ? {}
                : { metadata: { github_run_id: env.GITHUB_RUN_ID } }),
              ...(options.gateway?.settleMs === undefined
                ? {}
                : { settleMs: options.gateway.settleMs }),
            }),
          );
        } catch (err) {
          throw new Error(
            `the media stage's model key could not be issued: ${firstLine(err)}`,
          );
        }
        report.addSecrets([mediaModel.key]);
        result.mediaModel = mediaModel.record;
      }
      const extraEnv: Record<string, string> = {
        ...(mediaModel === undefined ? {} : mediaModel.env),
        ...(part === undefined ? {} : { [MEDIA_PART_ENV]: part.id }),
        ...(options.editionHeap === undefined
          ? {}
          : { [EDITION_HEAP_ENV]: options.editionHeap }),
        ...(target === undefined ? {} : { [TARGET_ENV_ENV]: target }),
        ...((options.mediaInputs ?? []).length === 0
          ? {}
          : {
              [MEDIA_INPUTS_ENV]: [...new Set(options.mediaInputs)]
                .sort()
                .join(","),
            }),
      };
      let ran: Awaited<ReturnType<typeof runMediaStage>>;
      try {
        ran = await timed("media", () =>
          runMediaStage({
            root: options.root,
            config: { ...config, media: stage },
            runRoot: root,
            env,
            stub,
            report,
            ...(Object.keys(extraEnv).length === 0 ? {} : { extraEnv }),
          }),
        );
      } finally {
        if (mediaModel !== undefined)
          report.writeJson(MEDIA_FORWARDER_FILE, await mediaModel.close());
      }
      result.media = ran.record;
      if (ran.failure !== undefined && output.kind === "results") {
        // A check run with no results still tells the alert channel, once per outage.
        const runUrl = workflowRunUrl(env);
        const stage = await timed("deliver", () =>
          runResultsFailure({
            ...resultsOptions(runUrl),
            failure: redact(ran.failure!, report.secretList).text,
          }),
        );
        result.results = stage.record;
        throw new Error(
          stage.failure === undefined
            ? ran.failure!
            : `${ran.failure!}; ${stage.failure}`,
        );
      }
      if (ran.failure !== undefined) throw new Error(ran.failure);
      if (part !== undefined) {
        // A part delivers nothing: it leaves its media for the delivery job.
        if (ran.media !== undefined && options.mediaOut !== undefined)
          leavePartMedia(ran.media.dir, options.mediaOut);
      } else if (ran.media === undefined)
        throw new Error(
          "a stub run without fixtures/media.json has no media to deliver",
        );
      else media = { dir: ran.media.dir, manifest: ran.media.manifest };
    }
    const runUrl = workflowRunUrl(env);
    if (media === undefined) {
      // A part run: the delivery job delivers.
    } else if (output.kind === "pr") {
      const stage = await timed("deliver", () =>
        runNoModelPrStage({
          job: config.name,
          output,
          mediaPaths: prPaths ?? [],
          mode: config.mode,
          stub,
          runName: name,
          ...(runUrl === undefined ? {} : { runUrl }),
          report,
          now: now(),
          media,
          previews: job.previews,
          openWriter:
            options.writer ?? ((repos) => openGithubWriter(env, repos)),
          ...(job.prNotify === undefined
            ? {}
            : {
                notify: job.prNotify,
                openPoster: options.poster ?? (() => openSlackPoster(env)),
              }),
        }),
      );
      result.delivery = stage.record;
      failure = stage.failure;
    } else if (output.kind === "youtube") {
      const hosts = loadLinkHosts(options.root).hosts;
      if (hosts === undefined) throw new Error("link-hosts.yml did not load");
      const readDocs =
        options.readDocs ??
        (stub
          ? undefined
          : (repo: string, path: string, jobName: string) =>
              readDocsState(repo, path, jobName, {
                appId: env[READER_APP_ID_ENV] ?? "",
                privateKey: env[READER_PRIVATE_KEY_ENV] ?? "",
              }));
      const stage = await timed("deliver", () =>
        runYouTubeStage({
          job: config.name,
          output,
          ...(job.previews[output.docs_repo] === undefined
            ? {}
            : { preview: job.previews[output.docs_repo] }),
          mode: config.mode,
          stub,
          runName: name,
          ...(runUrl === undefined ? {} : { runUrl }),
          report,
          now: now(),
          media,
          linkHosts: hosts,
          ...(job.youtube?.notify === undefined
            ? {}
            : { notify: job.youtube.notify }),
          ...(job.youtube?.shadow === undefined
            ? {}
            : { shadowChannel: job.youtube.shadow }),
          slackLinks: job.youtube?.links ?? [],
          ...(readDocs === undefined
            ? {}
            : {
                readDocs: () =>
                  readDocs(output.docs_repo, output.map_path, config.name),
              }),
          openYouTube: options.youtube ?? (() => openYouTube(env)),
          openWriter:
            options.writer ?? ((repos) => openGithubWriter(env, repos)),
          openPoster: options.poster ?? (() => openSlackPoster(env)),
        }),
      );
      result.youtube = stage.record;
      failure = stage.failure;
    } else if (output.kind === "results") {
      const stage = await timed("deliver", () =>
        runResultsStage({ ...resultsOptions(runUrl), media }),
      );
      result.results = stage.record;
      failure = stage.failure;
    }
  } catch (err) {
    failure = firstLine(err);
    // The delivery job names the part with this reason.
    if (part !== undefined && options.mediaOut !== undefined)
      leavePartFailure(
        options.mediaOut,
        part.id,
        redact(failure, report.secretList).text,
      );
  }

  if (failure !== undefined) result.failure = failure;
  result.ok = failure === undefined;
  report.writeJson("timings.json", timings);
  const status = () =>
    report.writeJson("status.json", {
      ...result,
      argv: undefined,
      timings: undefined,
    });
  status();
  if (report.secretHits > 0) {
    result.ok = false;
    result.failure =
      "a secret value appeared in the run's output; it was replaced with [redacted] in the report. Rotate the key.";
    status();
  }
  const summary = summaryMarkdown(result);
  report.write("summary.md", summary);
  appendStepSummary(env, summary, report.secretList);
  return {
    ok: result.ok,
    messages: [
      result.ok
        ? part === undefined
          ? `${config.name}: delivered without a model.`
          : `${config.name}: part ${part.id} recorded; the delivery job delivers it.`
        : `${config.name}: ${result.failure}`,
      `Report: ${report.dir}`,
    ],
    outDir: report.dir,
    report: result,
  };
}

/**
 * The tidy run of a youtube job with unlist_replaced: no media and no
 * upload; reads the map and the job's map pull requests with the reader
 * app, the replaced videos' state with the YouTube grant when the job has
 * it, and in live mode unlists them (runYouTubeTidy).
 */
async function runUnlistOnly(
  options: RunOptions,
  job: NoModelJob,
  output: Extract<NoModelJob["config"]["output"], { kind: "youtube" }>,
  timings: Timing[],
  timed: <T>(step: string, fn: () => T | Promise<T>) => Promise<T>,
): Promise<RunResult> {
  const env = options.env ?? process.env;
  const stub = options.stub ?? false;
  const now = options.now ?? (() => new Date());
  const { config } = job;
  const tidy = output.unlist_replaced!;
  const fail = (...messages: string[]): RunResult => ({ ok: false, messages });
  const hasGrant = config.mode === "live";
  if (!stub) {
    const needed = [
      ...(options.readHistory === undefined
        ? [READER_APP_ID_ENV, READER_PRIVATE_KEY_ENV]
        : []),
      ...(hasGrant && options.youtube === undefined ? YOUTUBE_SECRET_ENV : []),
      ...(tidy.mode === "live" &&
      output.notify !== undefined &&
      options.poster === undefined
        ? [SLACK_POST_TOKEN_ENV]
        : []),
    ];
    const absent = missing(env, needed);
    if (absent.length > 0)
      return fail(
        `${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} not set; unlisting replaced videos needs ${absent.length === 1 ? "it" : "them"}`,
      );
  }
  const chosen = scratchBase(options.scratch, env);
  if ("error" in chosen) return fail(chosen.error);
  const root = mkdtempSync(join(chosen.base, `job-${config.name}-`));
  chmodSync(root, 0o700);
  const report = new ReportWriter(
    options.out ?? join(root, "report"),
    secretValues(env),
  );
  const result: RunReport = {
    job: config.name,
    mode: config.mode,
    launcher: "none",
    runName: makeRunName(config.name, env, now()),
    model: NO_MODEL,
    inputSource: "map",
    ok: false,
    answerProblems: [],
    argv: [],
    timings,
    budget: {
      month: now().toISOString().slice(0, 7),
      spentUsd: 0,
      reserveUsd: 0,
      ledger: "none",
    },
  };
  const readHistory =
    options.readHistory ??
    (stub
      ? undefined
      : (repo: string, path: string, jobName: string) =>
          readVideoHistory(repo, path, jobName, {
            appId: env[READER_APP_ID_ENV] ?? "",
            privateKey: env[READER_PRIVATE_KEY_ENV] ?? "",
          }));
  const runUrl = workflowRunUrl(env);
  let failure: string | undefined;
  try {
    const stage = await timed("unlist", () =>
      runYouTubeTidy({
        job: config.name,
        tidy,
        docsRepo: output.docs_repo,
        mapPath: output.map_path,
        stub,
        ...(runUrl === undefined ? {} : { runUrl }),
        report,
        ...(readHistory === undefined
          ? {}
          : {
              readHistory: () =>
                readHistory(output.docs_repo, output.map_path, config.name),
            }),
        ...(hasGrant
          ? { openYouTube: options.youtube ?? (() => openYouTube(env)) }
          : {}),
        ...(job.youtube?.notify === undefined
          ? {}
          : { notify: job.youtube.notify }),
        slackLinks: job.youtube?.links ?? [],
        openPoster: options.poster ?? (() => openSlackPoster(env)),
      }),
    );
    result.youtubeTidy = stage.record;
    failure = stage.failure;
  } catch (err) {
    failure = firstLine(err);
  }
  if (failure !== undefined) result.failure = failure;
  result.ok = failure === undefined;
  report.writeJson("timings.json", timings);
  const status = () =>
    report.writeJson("status.json", {
      ...result,
      argv: undefined,
      timings: undefined,
    });
  status();
  if (report.secretHits > 0) {
    result.ok = false;
    result.failure =
      "a secret value appeared in the run's output; it was replaced with [redacted] in the report. Rotate the key.";
    status();
  }
  const summary = summaryMarkdown(result);
  report.write("summary.md", summary);
  appendStepSummary(env, summary, report.secretList);
  return {
    ok: result.ok,
    messages: [
      result.ok
        ? `${config.name}: replaced videos checked (unlist_replaced mode ${tidy.mode}).`
        : `${config.name}: ${result.failure}`,
      `Report: ${report.dir}`,
    ],
    outDir: report.dir,
    report: result,
  };
}

/**
 * Before a check job's run: finds the workflow run that left the newest
 * results artifact of this environment and mode, with the workflow's own
 * token (actions: read), and writes it as run_id to the step's outputs
 * for the step that downloads it. An empty run_id: no previous run.
 */
async function findPrevious(
  options: RunOptions,
  env: NodeJS.ProcessEnv,
  job: string,
  mode: "shadow" | "live",
  target: string,
): Promise<RunResult> {
  const token = (env[PREVIOUS_TOKEN_ENV] ?? "").trim();
  const repo = env.GITHUB_REPOSITORY ?? "";
  if (token === "" || repo === "")
    return {
      ok: false,
      messages: [
        `${PREVIOUS_TOKEN_ENV} and GITHUB_REPOSITORY must be set to find the previous results`,
      ],
    };
  const artifact = resultsArtifact(job, mode, target);
  let run: number | undefined;
  try {
    run = await previousResultsRun({
      repo,
      artifact,
      token,
      ...(env.GITHUB_RUN_ID === undefined
        ? {}
        : { currentRunId: env.GITHUB_RUN_ID }),
      ...(env.GITHUB_API_URL === undefined
        ? {}
        : { apiUrl: env.GITHUB_API_URL }),
      ...(options.githubFetch === undefined
        ? {}
        : { fetch: options.githubFetch }),
    });
  } catch (err) {
    return { ok: false, messages: [`${job}: ${firstLine(err)}`] };
  }
  const out = env.GITHUB_OUTPUT;
  if (out !== undefined && out !== "")
    appendFileSync(out, `run_id=${run ?? ""}\n`);
  return {
    ok: true,
    messages: [
      run === undefined
        ? `${job}: no earlier ${artifact} results; this run compares with nothing.`
        : `${job}: the previous ${artifact} results are in run ${run}.`,
    ],
  };
}
