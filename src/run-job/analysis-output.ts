import type { Output } from "../lib/job.ts";
import { firstLine } from "../lib/problem.ts";
import {
  cleanMessage,
  postProblem,
  shadowMessage,
} from "../deliver/slack-message.ts";
import type { OpenedPoster, PostedMessage } from "../deliver/slack-poster.ts";
import { scrub } from "../tools-server/scrub.ts";
import { untrustedToolList, type UntrustedInputRecord } from "./input-gate.ts";
import type { PrNotify } from "./load.ts";
import type { ReportWriter } from "./report.ts";
import type { SlackMessage } from "./slack-render.ts";

/** Where the analysis of a run that published nothing goes, as chat.postMessage takes it. */
export const ANALYSIS_FILE = "delivery/analysis.json";

/** What happened to the analysis a pull request job's publish.ts gave when it published nothing. */
export interface AnalysisRecord {
  /**
   * report_only: kept in the report (no output.notify, untrusted input the
   * job reports only, or a message that breaks the limits). shadow: a stub
   * run, or a shadow run with no shadow channel id. delivered: posted to
   * output.notify, or, for a shadow run, to the shadow channel.
   */
  outcome: "report_only" | "shadow" | "delivered";
  reason?: string;
  /** The channel it is posted to, or would be. */
  channel?: { name: string; id?: string };
  /** Set when that is the shadow channel, in place of output.notify. */
  shadow?: true;
  /** What the kit changed in the message to keep its rules; empty when it posts as written. */
  changes: string[];
  posted?: PostedMessage;
}

/** Every string of the message with credentials, secret-shaped text and UUIDs taken out, as tool results are. */
function scrubbed<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") return scrub(value, secrets) as T;
  if (Array.isArray(value))
    return value.map((v: unknown) => scrubbed(v, secrets)) as T;
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, scrubbed(v, secrets)]),
    ) as T;
  return value;
}

/**
 * Posts the short analysis of a pull request job's run that publishes
 * nothing, through the same rules as a slack job's message: secrets and
 * UUIDs scrubbed, links off channels.yml's list turned into text,
 * mentions broken, Slack's limits kept, and the untrusted-input gate of
 * output.untrusted_input. A live run posts to output.notify, a shadow run
 * to the shadow channel under the shadow line, a stub run nothing.
 * delivery/analysis.json keeps the exact body.
 */
export async function postAnalysis(o: {
  job: string;
  output: Extract<Output, { kind: "pr" }>;
  mode: "shadow" | "live";
  stub: boolean;
  /** The analysis with the footer. */
  message: SlackMessage;
  notify?: PrNotify;
  runUrl?: string;
  untrusted: UntrustedInputRecord;
  report: ReportWriter;
  openPoster?(): Promise<OpenedPoster>;
}): Promise<{ record: AnalysisRecord; failure?: string }> {
  const notify = o.notify;
  const cleaned = cleanMessage(scrubbed(o.message, o.report.secretList), {
    prefixes: notify?.links ?? [],
    exact: o.runUrl === undefined ? [] : [o.runUrl],
  });
  const shadow = o.mode === "shadow";
  const message =
    shadow && notify !== undefined
      ? shadowMessage(cleaned.message, o.job, notify.channel.name)
      : cleaned.message;
  const channel =
    notify === undefined ? undefined : shadow ? notify.shadow : notify.channel;
  const record: AnalysisRecord = {
    outcome: "report_only",
    ...(channel === undefined ? {} : { channel: { ...channel } }),
    ...(shadow && channel !== undefined ? { shadow: true as const } : {}),
    changes: cleaned.changes,
  };
  o.report.writeJson(ANALYSIS_FILE, {
    channel: channel?.id ?? null,
    text: message.text,
    blocks: message.blocks,
    link_names: false,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (notify === undefined) {
    record.reason =
      "the job has no output.notify, so the analysis stays in the report";
    return { record };
  }
  const problem = postProblem(message);
  if (problem !== undefined) {
    record.reason = `the analysis breaks Slack's or the kit's limits: ${problem}`;
    return {
      record,
      failure: `the analysis cannot be posted: ${problem}`,
    };
  }
  if (o.untrusted.seen && o.output.untrusted_input === "report_only") {
    record.reason = `the model saw untrusted text (from ${untrustedToolList(o.untrusted).join(", ")}) and the job delivers such runs as a report (untrusted_input: report_only)`;
    return { record };
  }
  if (o.stub || (shadow && channel?.id === undefined)) {
    record.outcome = "shadow";
    record.reason = o.stub
      ? "a stub run posts nothing"
      : "channels.yml gives the shadow channel no id, so a shadow run posts nothing; delivery/analysis.json holds what it would post";
    return { record };
  }
  if (channel?.id === undefined) {
    record.reason = `#${notify.channel.name} has no id in channels.yml`;
    return { record, failure: record.reason };
  }
  if (o.openPoster === undefined) {
    record.reason = `no Slack poster for the analysis to #${channel.name}`;
    return { record, failure: record.reason };
  }
  let opened: OpenedPoster;
  try {
    opened = await o.openPoster();
  } catch (err) {
    record.reason = firstLine(err);
    return {
      record,
      failure: `the Slack poster could not start: ${firstLine(err)}`,
    };
  }
  o.report.addSecrets(opened.secrets);
  try {
    record.posted = await opened.poster.post(channel.id, message);
    record.outcome = "delivered";
    return { record };
  } catch (err) {
    record.reason = firstLine(err);
    return {
      record,
      failure: `posting the analysis to #${channel.name} failed: ${firstLine(err)}`,
    };
  }
}
