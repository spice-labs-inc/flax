import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PostChannel, ShadowChannel } from "../lib/allowlists.ts";
import {
  MEDIA_MANIFEST,
  readMediaFile,
  type MediaManifest,
} from "../lib/media.ts";
import { firstLine } from "../lib/problem.ts";
import {
  alertMessage,
  checkData,
  countChecks,
  failureAlertMessage,
  readIndex,
  RESULTS_INDEX,
  transitions,
  type ResultsIndex,
} from "../deliver/check-results.ts";
import {
  cleanMessage,
  postProblem,
  shadowMessage,
} from "../deliver/slack-message.ts";
import type { OpenedPoster, PostedMessage } from "../deliver/slack-poster.ts";
import type { ReportWriter } from "./report.ts";
import type { SlackMessage } from "./slack-render.ts";

/**
 * The workflow artifact a check job's run leaves its results in, one name
 * per environment, and shadow runs under names of their own, so a live run
 * never compares with a shadow one.
 */
export function resultsArtifact(
  job: string,
  mode: "shadow" | "live",
  env: string,
): string {
  return `${job}${mode === "shadow" ? "-shadow" : ""}-${env}`;
}

/** A run's id in its index: the workflow run and attempt, or local. */
export function resultsRunId(env: NodeJS.ProcessEnv): string {
  const id = env.GITHUB_RUN_ID;
  if (id === undefined || !/^\d{1,20}$/.test(id)) return "local";
  const attempt = /^\d{1,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? "")
    ? env.GITHUB_RUN_ATTEMPT
    : "1";
  return `${id}-${attempt}`;
}

/** What a check job's run left for the next one, and what it told. */
export interface ResultsDeliveryRecord {
  /** stub: planned only; written: the results are in the directory the workflow uploads. */
  outcome: "stub" | "written";
  env: string;
  shadow: boolean;
  artifact: string;
  /** The files the artifact holds. */
  files: string[];
  /** The run the previous index named; null when there was none to compare with. */
  previous: { id: string; at: string } | null;
  failing: string[];
  recovered: string[];
  alert?: {
    channel: { name: string; id?: string };
    shadow?: true;
    outcome: "posted" | "not_posted";
    reason?: string;
    posted?: PostedMessage;
  };
  reason?: string;
}

export interface ResultsStageOptions {
  job: string;
  env: string;
  mode: "shadow" | "live";
  stub: boolean;
  runId: string;
  runUrl?: string;
  reason?: string;
  /** What started the run, as an alert names it. */
  trigger?: string;
  report: ReportWriter;
  now: Date;
  /** Where the workflow put the previous run's results artifact; none when there was no previous run. */
  previousDir?: string;
  /** Where the results go for the workflow to upload; a stub run writes none. */
  outDir?: string;
  /** The channel alerts go to live; none when the job has no alert. */
  alert?: PostChannel;
  /** Where shadow runs post their alert; without it they post nothing. */
  shadowChannel?: ShadowChannel;
  links: readonly string[];
  openPoster(): Promise<OpenedPoster>;
}

export interface ResultsStageResult {
  record: ResultsDeliveryRecord;
  failure?: string;
}

function hasSecret(data: Buffer, secrets: readonly string[]): boolean {
  return secrets.some((s) => data.includes(s));
}

/** The previous run's index, from the artifact the workflow downloaded; a note when one was there but unreadable. */
function previousIndex(dir: string | undefined): {
  index?: ResultsIndex;
  note?: string;
} {
  // The workflow downloads nothing when there was no previous run.
  if (dir === undefined || !existsSync(dir)) return {};
  const path = join(dir, RESULTS_INDEX);
  if (!existsSync(path))
    return {
      note: `the previous run's results have no ${RESULTS_INDEX}, so nothing was compared`,
    };
  const index = readIndex(readFileSync(path, "utf8"));
  return index === undefined
    ? {
        note: `the previous run's ${RESULTS_INDEX} is not one this kit writes, so nothing was compared`,
      }
    : { index };
}

type AlertOptions = Pick<
  ResultsStageOptions,
  | "job"
  | "mode"
  | "alert"
  | "shadowChannel"
  | "links"
  | "runUrl"
  | "report"
  | "openPoster"
>;

/**
 * Holds an alert to the kit's message rules, marks a shadow run's, notes
 * the channel in the record and keeps the exact post in
 * delivery/results-alert.json. Undefined when the job has no alert; a
 * string when the message cannot be posted.
 */
function prepareAlert(
  o: AlertOptions,
  record: ResultsDeliveryRecord,
  message: SlackMessage,
): SlackMessage | string | undefined {
  if (o.alert === undefined) return undefined;
  const toShadow = o.mode === "shadow" && o.shadowChannel !== undefined;
  const cleaned = cleanMessage(message, {
    prefixes: o.links,
    exact: o.runUrl === undefined ? [] : [o.runUrl],
  });
  const post = toShadow
    ? shadowMessage(cleaned.message, o.job, o.alert.name)
    : cleaned.message;
  const channel = toShadow ? { ...o.shadowChannel! } : { ...o.alert };
  record.alert = {
    channel,
    ...(toShadow ? { shadow: true as const } : {}),
    outcome: "not_posted",
  };
  o.report.writeJson("delivery/results-alert.json", {
    channel: channel.id ?? null,
    text: post.text,
    blocks: post.blocks,
    link_names: false,
    unfurl_links: false,
    unfurl_media: false,
  });
  const problem = postProblem(post);
  return problem === undefined
    ? post
    : `the alert breaks Slack's or the kit's limits: ${problem}`;
}

/** Posts a prepared alert once: live to the alert channel, shadow to the shadow channel or nowhere. Returns why it failed. */
async function sendAlert(
  o: AlertOptions,
  record: ResultsDeliveryRecord,
  post: SlackMessage,
): Promise<string | undefined> {
  const alert = record.alert!;
  if (o.mode === "shadow" && alert.shadow !== true) {
    alert.reason =
      "the shadow channel has no id in channels.yml, so a shadow run posts nothing; delivery/results-alert.json holds what it would post";
    return undefined;
  }
  let failure: string | undefined;
  if (alert.channel.id === undefined)
    failure = `#${alert.channel.name} has no id in channels.yml`;
  else
    try {
      const poster = await o.openPoster();
      o.report.addSecrets(poster.secrets);
      alert.posted = await poster.poster.post(alert.channel.id, post);
      alert.outcome = "posted";
    } catch (err) {
      failure = `posting the alert to #${alert.channel.name} failed: ${firstLine(err)}`;
    }
  if (failure !== undefined) alert.reason = failure;
  return failure;
}

function indexText(index: ResultsIndex): Buffer {
  return Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
}

/**
 * The results output kind, after the media stage: the checks in
 * media.json data are compared with the previous run's index.json (the
 * workflow downloads the environment's last results artifact first), and
 * a check that passed there and fails now, or the reverse, is posted to
 * the alert channel (a shadow run's to the shadow channel). Then the
 * manifest's files, media.json and this run's index.json go into the
 * directory the workflow uploads as the environment's artifact, each
 * checked against its sha256 and refused if it holds a secret value. When
 * the alert cannot be posted, the index keeps the previous run's checks,
 * so the next run alerts again rather than never. A stub run plans it all
 * and writes nothing.
 */
export async function runResultsStage(
  o: ResultsStageOptions & { media: { dir: string; manifest: MediaManifest } },
): Promise<ResultsStageResult> {
  const shadow = o.mode === "shadow";
  const files = o.media.manifest.files;
  const record: ResultsDeliveryRecord = {
    outcome: "stub",
    env: o.env,
    shadow,
    artifact: resultsArtifact(o.job, o.mode, o.env),
    files: [...files.map((f) => f.path), MEDIA_MANIFEST, RESULTS_INDEX],
    previous: null,
    failing: [],
    recovered: [],
  };
  const fail = (failure: string): ResultsStageResult => {
    record.reason = failure;
    return { record, failure };
  };
  let data;
  try {
    data = checkData(o.media.manifest);
  } catch (err) {
    return fail(firstLine(err));
  }
  if (files.some((f) => f.path === MEDIA_MANIFEST || f.path === RESULTS_INDEX))
    return fail(
      `the manifest lists ${MEDIA_MANIFEST} or ${RESULTS_INDEX}, which the kit writes`,
    );
  const previous = previousIndex(o.previousDir);
  if (previous.note !== undefined) record.reason = previous.note;
  if (previous.index !== undefined)
    record.previous = {
      id: previous.index.run.id,
      at: previous.index.run.at,
    };
  const moved = transitions(previous.index?.checks, data.checks);
  record.failing = moved.failing;
  record.recovered = moved.recovered;

  const index: ResultsIndex = {
    version: 1,
    job: o.job,
    env: o.env,
    shadow,
    run: {
      id: o.runId,
      at: o.now.toISOString(),
      ...(o.runUrl === undefined ? {} : { workflowRun: o.runUrl }),
      ...(o.reason === undefined ? {} : { reason: o.reason }),
    },
    builds: data.builds,
    counts: countChecks(data.checks),
    checks: data.checks,
  };

  const post =
    moved.failing.length > 0 || moved.recovered.length > 0
      ? prepareAlert(
          o,
          record,
          alertMessage({
            job: o.job,
            env: o.env,
            checks: data.checks,
            moved,
            builds: data.builds,
            runUrl: o.runUrl,
            ...(o.trigger === undefined ? {} : { trigger: o.trigger }),
            artifact: record.artifact,
          }),
        )
      : undefined;
  if (typeof post === "string") return fail(post);

  if (o.stub || o.outDir === undefined) {
    o.report.writeJson(`delivery/${RESULTS_INDEX}`, index);
    if (record.alert !== undefined)
      record.alert.reason = "a stub run posts nothing";
    record.reason ??= "a stub run writes no results";
    return { record };
  }

  const alertFailure =
    post === undefined ? undefined : await sendAlert(o, record, post);
  const prior = previous.index;
  // A lost alert would never come again: keep the previous checks so the next run tells it.
  const written: ResultsIndex =
    alertFailure === undefined || prior === undefined
      ? index
      : {
          ...index,
          run: { ...index.run, failure: alertFailure },
          checksFrom: prior.checksFrom ?? prior.run.id,
          builds: prior.builds,
          counts: countChecks(prior.checks),
          checks: prior.checks,
        };
  o.report.writeJson(`delivery/${RESULTS_INDEX}`, written);

  try {
    mkdirSync(o.outDir, { recursive: true, mode: 0o700 });
    const out: [string, Buffer][] = files.map((file) => [
      file.path,
      readMediaFile(o.media.dir, file),
    ]);
    out.push([MEDIA_MANIFEST, readFileSync(join(o.media.dir, MEDIA_MANIFEST))]);
    out.push([RESULTS_INDEX, indexText(written)]);
    for (const [path, body] of out)
      if (hasSecret(body, o.report.secretList))
        return fail(
          `${path} holds a secret value, so no results were written; rotate the key`,
        );
    for (const [path, body] of out) {
      mkdirSync(join(o.outDir, path, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(join(o.outDir, path), body, { mode: 0o600 });
    }
  } catch (err) {
    return fail(`writing the results failed: ${firstLine(err)}`);
  }
  record.outcome = "written";
  if (alertFailure !== undefined) return fail(alertFailure);
  return { record };
}

/**
 * A check job whose media stage failed, after its own retries, so the run
 * has no results: index.json names this run with its failure and keeps
 * the previous run's checks (checksFrom), so the next run compares with
 * real results. When the previous run had results of its own, the alert
 * channel is told once (a shadow run's goes to the shadow channel); a run
 * after another such run tells no one. A stub run writes and posts
 * nothing; the run fails either way.
 */
export async function runResultsFailure(
  o: ResultsStageOptions & { failure: string },
): Promise<ResultsStageResult> {
  const shadow = o.mode === "shadow";
  const record: ResultsDeliveryRecord = {
    outcome: "stub",
    env: o.env,
    shadow,
    artifact: resultsArtifact(o.job, o.mode, o.env),
    files: [RESULTS_INDEX],
    previous: null,
    failing: [],
    recovered: [],
    reason: "the media stage failed, so the run has no results",
  };
  if (o.stub || o.outDir === undefined) return { record };
  const fail = (failure: string): ResultsStageResult => {
    record.reason = `the media stage failed, and then ${failure}`;
    return { record, failure: record.reason };
  };
  const previous = previousIndex(o.previousDir).index;
  if (previous !== undefined)
    record.previous = { id: previous.run.id, at: previous.run.at };
  const index: ResultsIndex = {
    version: 1,
    job: o.job,
    env: o.env,
    shadow,
    run: {
      id: o.runId,
      at: o.now.toISOString(),
      ...(o.runUrl === undefined ? {} : { workflowRun: o.runUrl }),
      ...(o.reason === undefined ? {} : { reason: o.reason }),
      failure: o.failure.replace(/\s+/g, " ").slice(0, 500),
    },
    ...(previous === undefined
      ? {}
      : { checksFrom: previous.checksFrom ?? previous.run.id }),
    builds: previous?.builds ?? {},
    counts: countChecks(previous?.checks ?? {}),
    checks: previous?.checks ?? {},
  };
  o.report.writeJson(`delivery/${RESULTS_INDEX}`, index);
  let alertFailure: string | undefined;
  if (previous !== undefined && previous.run.failure === undefined) {
    const post = prepareAlert(
      o,
      record,
      failureAlertMessage({
        job: o.job,
        env: o.env,
        failure: o.failure,
        runUrl: o.runUrl,
        ...(o.trigger === undefined ? {} : { trigger: o.trigger }),
      }),
    );
    if (typeof post === "string") return fail(post);
    if (post !== undefined) alertFailure = await sendAlert(o, record, post);
  }
  const text = indexText(index);
  if (hasSecret(text, o.report.secretList))
    return fail(
      `${RESULTS_INDEX} would hold a secret value, so it was not written`,
    );
  try {
    mkdirSync(o.outDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(o.outDir, RESULTS_INDEX), text, { mode: 0o600 });
  } catch (err) {
    return fail(`writing ${RESULTS_INDEX} failed: ${firstLine(err)}`);
  }
  record.outcome = "written";
  return alertFailure === undefined ? { record } : fail(alertFailure);
}
