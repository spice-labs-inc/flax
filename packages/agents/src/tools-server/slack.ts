import type { WebClient } from "@slack/web-api";
import type { ReadChannel } from "../lib/allowlists.ts";
import { UPSTREAM_OPERATIONS } from "../lib/tools.ts";
import type { Upstream } from "./upstreams.ts";

export const SLACK_OPERATIONS = UPSTREAM_OPERATIONS.slack!;

/** The most messages one call may return, and how far back it may reach. */
export const SLACK_MAX_MESSAGES = 100;
export const SLACK_MAX_HOURS = 24;

interface SlackMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  subtype?: string;
  text?: string;
  reply_count?: number;
  attachments?: { title?: string; text?: string; fallback?: string }[];
}

/** The fields of a message worth reading; blocks repeat the text, and the rest is presentation. */
function message(m: SlackMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { ts: m.ts };
  for (const key of [
    "thread_ts",
    "user",
    "bot_id",
    "username",
    "subtype",
    "text",
    "reply_count",
  ] as const)
    if (m[key] !== undefined && m[key] !== "") out[key] = m[key];
  const attachments = (m.attachments ?? [])
    .map((a) => ({
      ...(a.title ? { title: a.title } : {}),
      ...(a.text || a.fallback ? { text: a.text || a.fallback } : {}),
    }))
    .filter((a) => Object.keys(a).length > 0);
  if (attachments.length > 0) out.attachments = attachments;
  return out;
}

/**
 * Slack, read through the agents app's bot token with @slack/web-api, not
 * an MCP server. It calls conversations.history and conversations.replies
 * only, on channels listed for reading in channels.yml, for at most
 * SLACK_MAX_MESSAGES messages from at most SLACK_MAX_HOURS back. It checks
 * all of that itself, whatever the tool asked for.
 */
export class SlackUpstream implements Upstream {
  private readonly client: WebClient;
  private readonly channels: ReadonlyMap<string, string>;
  private readonly now: () => Date;

  constructor(
    client: WebClient,
    channels: readonly ReadChannel[],
    now: () => Date = () => new Date(),
  ) {
    this.client = client;
    this.channels = new Map(channels.map((c) => [c.id, c.name]));
    this.now = now;
  }

  async call(
    operation: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    if (!SLACK_OPERATIONS.includes(operation))
      throw new Error(`"${operation}" is not an allowed operation`);
    const channel = args.channel;
    if (typeof channel !== "string" || !this.channels.has(channel))
      throw new Error(`channel ${String(channel)} is not listed for reading`);
    const limit = args.limit;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > SLACK_MAX_MESSAGES
    )
      throw new Error(`limit must be 1 to ${SLACK_MAX_MESSAGES}`);
    const oldest = Number(args.oldest);
    const earliest = this.now().getTime() / 1000 - SLACK_MAX_HOURS * 3600 - 60;
    if (typeof args.oldest !== "string" || !(oldest >= earliest))
      throw new Error(
        `oldest must be within the last ${SLACK_MAX_HOURS} hours`,
      );
    signal.throwIfAborted();
    const common = { channel, oldest: args.oldest, limit, inclusive: true };
    let result: { messages?: SlackMessage[]; has_more?: boolean };
    if (operation === "conversations.replies") {
      if (typeof args.ts !== "string")
        throw new Error("conversations.replies needs a thread ts");
      result = await this.client.conversations.replies({
        ...common,
        ts: args.ts,
      });
    } else {
      result = await this.client.conversations.history(common);
    }
    signal.throwIfAborted();
    return JSON.stringify({
      channel: `#${this.channels.get(channel)}`,
      messages: (result.messages ?? []).slice(0, limit).map(message),
      has_more: result.has_more === true,
    });
  }
}
