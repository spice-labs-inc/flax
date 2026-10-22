import type { PostChannel, ShadowChannel } from "../lib/allowlists.ts";
import type { Output } from "../lib/job.ts";
import { firstLine } from "../lib/problem.ts";
import {
  cleanMessage,
  postProblem,
  shadowMessage,
  type LinkPolicy,
} from "../deliver/slack-message.ts";
import type { OpenedPoster, PostedMessage } from "../deliver/slack-poster.ts";
import { untrustedToolList, type UntrustedInputRecord } from "./input-gate.ts";
import type { ReportWriter } from "./report.ts";
import type { SlackMessage } from "./slack-render.ts";

/** What happened to a slack job's message after the answer passed its schema and its quotes. */
export interface SlackDeliveryRecord {
  /**
   * report_only: kept in the report because the model saw untrusted text
   * or the message breaks the rules. shadow: a stub run, or a shadow run
   * with no shadow channel, which posts nothing. delivered: posted, to the
   * job's channel or, for a shadow run, to the shadow channel.
   */
  outcome: "report_only" | "shadow" | "delivered";
  reason?: string;
  /** The channel the message is posted to, or would be. */
  channel: { name: string; id?: string };
  /** Set when that is the shadow channel, in place of the job's own. */
  shadow?: true;
  /** What the kit changed in the rendered message to keep its rules; empty when it posts as rendered. */
  changes: string[];
  posted?: PostedMessage;
}

export interface SlackStageOptions {
  job: string;
  output: Extract<Output, { kind: "slack" }>;
  channel: PostChannel;
  /** Where shadow runs post; without it they post nothing. */
  shadowChannel?: ShadowChannel;
  links: readonly string[];
  mode: "shadow" | "live";
  stub: boolean;
  /** The message render.ts made (or the plain one), with the footer. */
  message: SlackMessage;
  runUrl?: string;
  untrusted: UntrustedInputRecord;
  report: ReportWriter;
  /** Makes the poster; stub runs never call it. */
  openPoster(): Promise<OpenedPoster>;
}

export type SlackStageResult = {
  record: SlackDeliveryRecord;
  failure?: string;
};

/**
 * The steps after a slack job's answer passed its schema and its quotes:
 * the kit's message rules (links, mentions, limits), the untrusted-input
 * gate, then one post. A live run posts to the job's channel. A shadow run
 * posts the same message to the shadow channel, under a line that says it
 * is a shadow run, or nothing when channels.yml gives the shadow channel no
 * id. A stub run goes through every step but the post. delivery/slack.json
 * keeps the exact chat.postMessage body the run sends, or would send.
 */
export async function runSlackStage(
  o: SlackStageOptions,
): Promise<SlackStageResult> {
  const policy: LinkPolicy = {
    prefixes: o.links,
    exact: o.runUrl === undefined ? [] : [o.runUrl],
  };
  const cleaned = cleanMessage(o.message, policy);
  const toShadow = o.mode === "shadow" && o.shadowChannel !== undefined;
  const message = toShadow
    ? shadowMessage(cleaned.message, o.job, o.channel.name)
    : cleaned.message;
  const record: SlackDeliveryRecord = {
    outcome: "report_only",
    channel: toShadow ? { ...o.shadowChannel! } : { ...o.channel },
    ...(toShadow ? { shadow: true as const } : {}),
    changes: cleaned.changes,
  };
  o.report.writeJson("delivery/slack.json", {
    channel: record.channel.id ?? null,
    text: message.text,
    blocks: message.blocks,
    link_names: false,
    unfurl_links: false,
    unfurl_media: false,
  });
  const problem = postProblem(message);
  if (problem !== undefined) {
    record.reason = `the message breaks Slack's or the kit's limits: ${problem}`;
    return {
      record,
      failure: `the Slack message cannot be posted: ${problem}`,
    };
  }

  if (o.untrusted.seen && o.output.untrusted_input === "report_only") {
    record.reason = `the model saw untrusted text (from ${untrustedToolList(o.untrusted).join(", ")}) and the job delivers such runs as a report (untrusted_input: report_only)`;
    return { record };
  }

  if (o.stub || (o.mode === "shadow" && !toShadow)) {
    record.outcome = "shadow";
    record.reason = o.stub
      ? "a stub run posts nothing"
      : "the shadow channel has no id in channels.yml, so a shadow run posts nothing; delivery/slack.json holds what it would post";
    return { record };
  }

  const channelId = record.channel.id;
  if (channelId === undefined) {
    record.reason = `#${record.channel.name} has no id in channels.yml`;
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
    record.posted = await opened.poster.post(channelId, message);
    record.outcome = "delivered";
    delete record.reason;
    return { record };
  } catch (err) {
    record.reason = firstLine(err);
    return {
      record,
      failure: `posting to #${record.channel.name} failed: ${firstLine(err)}`,
    };
  }
}
