import type { SlackMessage } from "../run-job/slack-render.ts";

/** The bot token that posts, by the repository secret that holds it. It has chat:write and nothing else. */
export const SLACK_POST_TOKEN_ENV = "SLACK_AGENTS_POST_TOKEN";

/** The only scope the posting token may have. */
export const POST_SCOPES = ["chat:write"] as const;

export const SLACK_API = "https://slack.com/api";
const MAX_ATTEMPTS = 3;
/** The longest Retry-After a post waits out; a longer one fails the delivery. */
export const MAX_RETRY_AFTER_SECONDS = 30;
const CHANNEL_ID = /^C[A-Z0-9]{8,12}$/;
const TS = /^\d{9,12}\.\d{6}$/;
const WORKSPACE_URL = /^https:\/\/[a-z0-9-]+\.slack\.com\/$/;
const ERROR_CODE = /^[a-z0-9_]{1,60}$/;

/** A message Slack took. */
export interface PostedMessage {
  channel: string;
  ts: string;
  permalink: string;
}

/** What delivery may do in Slack, and nothing more: post one message to one channel, as the app's own bot. */
export interface SlackPoster {
  post(channelId: string, message: SlackMessage): Promise<PostedMessage>;
}

export interface SlackPosterOptions {
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  /** Waits out a rate limit; a real timer by default. */
  sleep?: (ms: number) => Promise<void>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Slack's Web API with the posting token. Every request body is built here
 * from fixed fields: no username or icon (the app's own bot identity), no
 * automatic linking of names, no unfurling. It posts at most once, and
 * retries only a post Slack refused with a rate limit (HTTP 429), which
 * Slack did not take; any other failure is not retried, since the message
 * may have been posted.
 */
export class SlackApiPoster implements SlackPoster {
  private readonly token: string;
  private readonly api: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private posted = false;
  /** The workspace's address, such as https://example.slack.com/, from auth.test. */
  workspaceUrl: string | undefined;

  constructor(options: SlackPosterOptions) {
    this.token = options.token;
    this.api = options.apiUrl ?? SLACK_API;
    this.fetchFn = options.fetch ?? fetch;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown>; headers: Headers }> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchFn(`${this.api}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) {
        await res.body?.cancel();
        const after = Number(res.headers.get("retry-after") ?? "1");
        const seconds = Number.isFinite(after) && after >= 0 ? after : 1;
        if (attempt >= MAX_ATTEMPTS || seconds > MAX_RETRY_AFTER_SECONDS)
          throw new Error(
            `${method} was rate limited ${attempt} time${attempt === 1 ? "" : "s"} (retry after ${seconds} s); nothing was posted`,
          );
        await this.sleep(seconds * 1000);
        continue;
      }
      if (!res.ok) {
        // The body can echo the request; the status is enough to act on.
        await res.body?.cancel();
        throw new Error(`${method} returned HTTP ${res.status}`);
      }
      const data: unknown = await res.json();
      if (!isObject(data)) throw new Error(`${method} returned no object`);
      if (data.ok !== true) {
        const code =
          typeof data.error === "string" && ERROR_CODE.test(data.error)
            ? data.error
            : "unknown_error";
        throw new Error(`${method} failed: ${code}`);
      }
      return { data, headers: res.headers };
    }
  }

  /** Checks the token: it must work, belong to a bot, and have exactly POST_SCOPES. */
  async checkToken(): Promise<{ botId: string; userId: string }> {
    const { data, headers } = await this.call("auth.test", {});
    const scopes = (headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .sort();
    if (scopes.length === 0)
      throw new Error(
        "auth.test did not say which scopes the posting token has, so it is not used",
      );
    const extra = scopes.filter(
      (s) => !(POST_SCOPES as readonly string[]).includes(s),
    );
    if (extra.length > 0)
      throw new Error(
        `the posting token has more than ${POST_SCOPES.join(", ")} (${extra.join(", ")}), so it is not used; give the posting app only ${POST_SCOPES.join(", ")}`,
      );
    if (!scopes.includes("chat:write"))
      throw new Error("the posting token lacks chat:write");
    if (typeof data.bot_id !== "string" || data.bot_id === "")
      throw new Error("the posting token is not a bot token");
    if (typeof data.url !== "string" || !WORKSPACE_URL.test(data.url))
      throw new Error("auth.test named no workspace address");
    this.workspaceUrl = data.url;
    return {
      botId: data.bot_id,
      userId: typeof data.user_id === "string" ? data.user_id : "",
    };
  }

  async post(channelId: string, message: SlackMessage): Promise<PostedMessage> {
    if (!CHANNEL_ID.test(channelId))
      throw new Error(`${channelId} is not a channel id`);
    if (this.posted)
      throw new Error("a run posts one message; this one already posted");
    if (this.workspaceUrl === undefined)
      throw new Error("the posting token was not checked");
    this.posted = true;
    let data: Record<string, unknown>;
    try {
      ({ data } = await this.call("chat.postMessage", {
        channel: channelId,
        text: message.text,
        blocks: message.blocks,
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
      }));
    } catch (err) {
      const name = (err as Error).name;
      if (name === "TimeoutError" || name === "TypeError")
        throw new Error(
          `chat.postMessage got no answer (${(err as Error).message}); the message may have been posted, so check the channel before running the job again`,
        );
      throw err;
    }
    const ts = data.ts;
    if (data.channel !== channelId || typeof ts !== "string" || !TS.test(ts))
      throw new Error(
        "chat.postMessage answered without the channel and timestamp of the message",
      );
    return {
      channel: channelId,
      ts,
      permalink: `${this.workspaceUrl}archives/${channelId}/p${ts.replace(".", "")}`,
    };
  }
}

export interface OpenedPoster {
  poster: SlackPoster;
  /** Values to scrub from every report file: the posting token. */
  secrets: string[];
}

/** Makes the poster from the posting token and checks the token before anything is posted. */
export async function openSlackPoster(
  env: NodeJS.ProcessEnv,
  options: Omit<SlackPosterOptions, "token"> = {},
): Promise<OpenedPoster> {
  const token = env[SLACK_POST_TOKEN_ENV] ?? "";
  if (token === "")
    throw new Error(`${SLACK_POST_TOKEN_ENV} must be set to post to Slack`);
  const poster = new SlackApiPoster({ token, ...options });
  await poster.checkToken();
  return { poster, secrets: [token] };
}
