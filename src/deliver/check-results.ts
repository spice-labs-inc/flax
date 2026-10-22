import type { MediaManifest } from "../lib/media.ts";
import { byCodePoint } from "../lib/sort.ts";
import {
  escapeMrkdwn,
  footerBlock,
  MAX_HEADER_CHARS,
  MAX_JOB_FALLBACK_CHARS,
  type Block,
  type SlackMessage,
} from "../run-job/slack-render.ts";

/** What a check's result counts as: skipped is neither a pass nor a failure. */
export const CHECK_STATUSES = ["passed", "failed", "skipped"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface CheckResult {
  name: string;
  status: CheckStatus;
  /** Why it failed, one line. */
  detail?: string;
  /** The step that failed, one line. */
  step?: string;
  /** How many screenshots the run's results hold for it. */
  screenshots?: number;
}

/**
 * What a check job's media.ts says about its run in media.json data:
 * every check by a stable id, and the builds it ran against.
 */
export interface CheckData {
  checks: Record<string, CheckResult>;
  builds: Record<string, string>;
}

export const MAX_CHECKS = 5000;
const MAX_ID_CHARS = 300;
const MAX_NAME_CHARS = 300;
const MAX_DETAIL_CHARS = 500;
const MAX_STEP_CHARS = 300;
const MAX_SCREENSHOTS = 1000;
const MAX_BUILDS = 20;
const MAX_BUILD_CHARS = 200;
const PRINTABLE = /^[^\u0000-\u001f\u007f]*$/;
const TERMINAL_COLOR = /\u001b\[[0-9;?]*[A-Za-z]/g;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function line(text: string, max: number): string {
  return text
    .replace(TERMINAL_COLOR, "")
    .replace(/[\s\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Reads data.checks and data.builds of a check job's manifest, refusing
 * anything but the shape: at most 5,000 checks, each with a printable id
 * and name and a status of passed, failed or skipped; a detail is cut to
 * one line of 500 characters and a failed step to one of 300, and a
 * screenshot count is a whole number. builds is optional, at most 20
 * short strings.
 */
export function checkData(manifest: MediaManifest): CheckData {
  const data = manifest.data;
  if (!isObject(data) || !isObject(data.checks))
    throw new Error(
      "media.json has no data.checks: a check job's media.ts lists every check's result there",
    );
  const entries = Object.entries(data.checks);
  if (entries.length > MAX_CHECKS)
    throw new Error(
      `data.checks has ${entries.length} checks; at most ${MAX_CHECKS}`,
    );
  const checks: Record<string, CheckResult> = {};
  for (const [id, value] of entries) {
    if (id === "" || id.length > MAX_ID_CHARS || !PRINTABLE.test(id))
      throw new Error(
        `data.checks: ${JSON.stringify(id.slice(0, 40))} is not a check id of 1 to ${MAX_ID_CHARS} printable characters`,
      );
    if (
      !isObject(value) ||
      typeof value.name !== "string" ||
      value.name.trim() === "" ||
      !(CHECK_STATUSES as readonly unknown[]).includes(value.status) ||
      (value.detail !== undefined && typeof value.detail !== "string") ||
      (value.step !== undefined && typeof value.step !== "string")
    )
      throw new Error(
        `data.checks[${JSON.stringify(id)}] needs a name and a status of ${CHECK_STATUSES.join(", ")}`,
      );
    if (
      value.screenshots !== undefined &&
      (!Number.isInteger(value.screenshots) ||
        (value.screenshots as number) < 0 ||
        (value.screenshots as number) > MAX_SCREENSHOTS)
    )
      throw new Error(
        `data.checks[${JSON.stringify(id)}].screenshots must be a whole number from 0 to ${MAX_SCREENSHOTS}`,
      );
    const detail =
      typeof value.detail === "string"
        ? line(value.detail, MAX_DETAIL_CHARS)
        : "";
    const step =
      typeof value.step === "string" ? line(value.step, MAX_STEP_CHARS) : "";
    const screenshots = (value.screenshots as number | undefined) ?? 0;
    checks[id] = {
      name: line(value.name, MAX_NAME_CHARS),
      status: value.status as CheckStatus,
      ...(detail === "" ? {} : { detail }),
      ...(step === "" ? {} : { step }),
      ...(screenshots === 0 ? {} : { screenshots }),
    };
  }
  const builds: Record<string, string> = {};
  if (data.builds !== undefined) {
    if (!isObject(data.builds))
      throw new Error("data.builds must be an object of strings");
    const list = Object.entries(data.builds);
    if (list.length > MAX_BUILDS)
      throw new Error(`data.builds has more than ${MAX_BUILDS} entries`);
    for (const [k, v] of list) {
      if (typeof v !== "string" || k.length > 100 || !PRINTABLE.test(k))
        throw new Error(`data.builds[${JSON.stringify(k)}] must be a string`);
      builds[k] = line(v, MAX_BUILD_CHARS);
    }
  }
  return { checks, builds };
}

/** The file in each run's results artifact that says how every check ended, which the next run of the environment compares with. */
export const RESULTS_INDEX = "index.json";

/** A check run's index.json: the run, the builds it checked and every check's result. */
export interface ResultsIndex {
  version: 1;
  job: string;
  env: string;
  shadow: boolean;
  run: {
    /** The workflow run id and attempt, such as 1234567890-1, or local. */
    id: string;
    at: string;
    workflowRun?: string;
    reason?: string;
    /** Why the run has no results of its own, one line; its checks are then the last run's that had. */
    failure?: string;
  };
  /** The run whose checks these are, when it is not this one. */
  checksFrom?: string;
  builds: Record<string, string>;
  counts: Record<CheckStatus, number>;
  checks: Record<string, CheckResult>;
}

/** A previous index.json, when it is one this kit wrote; undefined for anything else. */
export function readIndex(text: string): ResultsIndex | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !isObject(value) ||
    value.version !== 1 ||
    !isObject(value.run) ||
    typeof value.run.id !== "string" ||
    typeof value.run.at !== "string" ||
    !isObject(value.checks)
  )
    return undefined;
  for (const c of Object.values(value.checks))
    if (
      !isObject(c) ||
      typeof c.name !== "string" ||
      !(CHECK_STATUSES as readonly unknown[]).includes(c.status)
    )
      return undefined;
  return value as unknown as ResultsIndex;
}

export function countChecks(
  checks: Record<string, CheckResult>,
): Record<CheckStatus, number> {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const c of Object.values(checks)) counts[c.status] += 1;
  return counts;
}

/** Checks that passed in the previous run and fail now, and the reverse, by id. */
export interface Transitions {
  failing: string[];
  recovered: string[];
}

export function transitions(
  previous: Record<string, CheckResult> | undefined,
  current: Record<string, CheckResult>,
): Transitions {
  const failing: string[] = [];
  const recovered: string[] = [];
  if (previous === undefined) return { failing, recovered };
  for (const id of Object.keys(current).sort(byCodePoint)) {
    const before = previous[id]?.status;
    const now = current[id]!.status;
    if (before === "passed" && now === "failed") failing.push(id);
    if (before === "failed" && now === "passed") recovered.push(id);
  }
  return { failing, recovered };
}

const MAX_LIST_CHARS = 2800;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Bullet lines up to the section's room; the rest is counted on a last line. */
function bullets(lines: readonly string[]): string {
  const out: string[] = [];
  let size = 0;
  for (const [i, l] of lines.entries()) {
    const rest = lines.length - i;
    if (size + l.length + 1 > MAX_LIST_CHARS - 60) {
      out.push(`and ${rest} more, in the run's index.json`);
      break;
    }
    out.push(l);
    size += l.length + 1;
  }
  return out.join("\n");
}

const COMMIT = /^[0-9a-f]{40}$/;
const MAX_ALERT_DETAIL_CHARS = 400;

/** What started a run, as an alert names it: a scheduled run, a manual run (with the reason it was given), or a local one. */
export function runTrigger(
  env: NodeJS.ProcessEnv,
  reason: string | undefined,
): string {
  const event = env.GITHUB_EVENT_NAME;
  if (event === "schedule") return "scheduled run";
  if (event === undefined) return "local run";
  const why = reason === undefined ? "" : line(reason, 120);
  return why === "" ? "manual run" : `manual run (${why})`;
}

/** One failing check in an alert: its name and id, the step that failed, the error and whether the results hold a screenshot of it. */
function failingEntry(id: string, c: CheckResult): string {
  const lines = [`• *${escapeMrkdwn(c.name)}* \`${id.replaceAll("`", "'")}\``];
  if (c.step !== undefined) lines.push(`   Step: ${escapeMrkdwn(c.step)}`);
  if (c.detail !== undefined)
    lines.push(
      `   ${c.step === undefined ? "" : "Error: "}${escapeMrkdwn(c.detail.slice(0, MAX_ALERT_DETAIL_CHARS))}`,
    );
  if (c.screenshots !== undefined)
    lines.push(
      `   ${plural(c.screenshots, "screenshot", "screenshots")} in the run's results`,
    );
  return lines.join("\n");
}

/**
 * The alert a check job posts when checks changed between two runs of
 * one environment: a header naming the environment and the first check
 * that fails now, what started the run, each check that fails now and
 * passed before (its id, the step that failed, the error and its
 * screenshots), what passes again, links to the run and its results, the
 * builds the run checked, and the footer. Every text from the run is
 * escaped and kept to one line.
 */
export function alertMessage(o: {
  job: string;
  env: string;
  checks: Record<string, CheckResult>;
  moved: Transitions;
  builds: Record<string, string>;
  runUrl: string | undefined;
  trigger?: string;
  artifact?: string;
}): SlackMessage {
  const parts = [
    ...(o.moved.failing.length === 0
      ? []
      : [
          `${plural(o.moved.failing.length, "check", "checks")} that passed in the previous run ${o.moved.failing.length === 1 ? "fails" : "fail"} now`,
        ]),
    ...(o.moved.recovered.length === 0
      ? []
      : [
          `${plural(o.moved.recovered.length, "check", "checks")} ${o.moved.recovered.length === 1 ? "passes" : "pass"} again`,
        ]),
  ];
  const what = parts.join(", ");
  const first = o.moved.failing[0];
  const title =
    first === undefined
      ? `${o.env}: ${what}`
      : `${o.env}: ${o.checks[first]!.name}${o.moved.failing.length > 1 ? ` (+${o.moved.failing.length - 1} more)` : ""}`;
  const trigger = o.trigger === undefined ? "" : `, ${o.trigger}`;
  const blocks: Block[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text:
          title.length > MAX_HEADER_CHARS
            ? `${title.slice(0, MAX_HEADER_CHARS - 1)}…`
            : title,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${o.job}* on *${o.env}*${escapeMrkdwn(trigger)}: ${what}.`,
      },
    },
  ];
  if (o.moved.failing.length > 0)
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Failing now*\n${bullets(
          o.moved.failing.map((id) => failingEntry(id, o.checks[id]!)),
        )}`,
      },
    });
  if (o.moved.recovered.length > 0)
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Passing again*\n${bullets(
          o.moved.recovered.map(
            (id) => `• ${escapeMrkdwn(o.checks[id]!.name)}`,
          ),
        )}`,
      },
    });
  if (o.runUrl !== undefined) {
    const shots = o.moved.failing.some(
      (id) => (o.checks[id]!.screenshots ?? 0) > 0,
    );
    const artifact =
      o.artifact === undefined
        ? ""
        : ` (artifact \`${escapeMrkdwn(o.artifact)}\`)`;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${o.runUrl}|View run> · <${o.runUrl}#artifacts|${shots ? "Results and screenshots" : "Results"}>${artifact}`,
      },
    });
  }
  const builds = Object.entries(o.builds)
    .slice(0, 10)
    .map(
      ([k, v]) =>
        `${escapeMrkdwn(k)} ${escapeMrkdwn(COMMIT.test(v) ? v.slice(0, 12) : v)}`,
    );
  if (builds.length > 0)
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Builds: ${builds.join(" · ")}` }],
    });
  blocks.push(footerBlock({ runUrl: o.runUrl, job: o.job, model: "none" }));
  return {
    text: `${o.job} on ${o.env}${trigger}: ${what}`.slice(
      0,
      MAX_JOB_FALLBACK_CHARS,
    ),
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  };
}

/**
 * The alert a check job posts when a run could not check anything (its
 * media stage failed after its own retries) and the previous run of the
 * environment did: one line of why, escaped, and the footer.
 */
export function failureAlertMessage(o: {
  job: string;
  env: string;
  failure: string;
  runUrl: string | undefined;
  trigger?: string;
}): SlackMessage {
  const what = "the run could not check anything";
  const trigger = o.trigger === undefined ? "" : `, ${o.trigger}`;
  return {
    text: `${o.job} on ${o.env}${trigger}: ${what}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${o.job}* on *${o.env}*${escapeMrkdwn(trigger)}: ${what}; the previous run could. Until a run completes, each run's index.json keeps the last results.`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Why*\n${escapeMrkdwn(line(o.failure, 500))}`,
        },
      },
      footerBlock({ runUrl: o.runUrl, job: o.job, model: "none" }),
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}
