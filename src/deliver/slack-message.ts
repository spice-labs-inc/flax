import {
  blockProblem,
  MAX_BLOCKS,
  MAX_FALLBACK_CHARS,
  type Block,
  type SlackMessage,
} from "../run-job/slack-render.ts";

/** The kit's ceiling on the JSON of a posted message's text and blocks. */
export const MAX_POST_BYTES = 40_000;

/** Where a posted message may link: the prefixes in channels.yml, and exact URLs the kit adds itself (the workflow run). */
export interface LinkPolicy {
  prefixes: readonly string[];
  exact: readonly string[];
}

const SAFE_URL = /^https:\/\/[^\s<>|"]+$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const TOKEN = /<([^<>]*)>/g;
const SPECIAL_MENTION = /(^|[^A-Za-z0-9_@])@(here|channel|everyone)\b/gi;
const WORD_JOINER = "\u2060";
const BARE_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>|]+/gi;

export function linkAllowed(url: string, policy: LinkPolicy): boolean {
  if (!SAFE_URL.test(url)) return false;
  if (policy.exact.includes(url)) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  return policy.prefixes.some(
    (p) => url.startsWith(p) && parsed.href.startsWith(p),
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url.slice(0, 40);
  } catch {
    return url.slice(0, 40);
  }
}

/** Mrkdwn with every link off the list turned into text, every mention or special token shown as text, and @here, @channel and @everyone broken. */
function cleanMrkdwn(
  text: string,
  policy: LinkPolicy,
  note: (what: string) => void,
) {
  const tokens = text.replace(TOKEN, (whole, inner: string) => {
    const bar = inner.indexOf("|");
    const target = bar === -1 ? inner : inner.slice(0, bar);
    if (SCHEME.test(target)) {
      if (linkAllowed(target, policy)) return whole;
      note(
        `a link to ${hostOf(target)}, which channels.yml does not list, became text`,
      );
      return bar === -1 ? target : inner.slice(bar + 1);
    }
    note(`<${inner.slice(0, 40)}> became text`);
    return `&lt;${inner}&gt;`;
  });
  return tokens.replace(
    SPECIAL_MENTION,
    (_whole, before: string, word: string) => {
      note(`@${word} became text`);
      return `${before}@${WORD_JOINER}${word}`;
    },
  );
}

/** Cleans one mrkdwn text object in place, and turns off Slack's own linking in it. */
function cleanTextObject(
  value: Record<string, unknown>,
  policy: LinkPolicy,
  note: (what: string) => void,
): void {
  if (value.type !== "mrkdwn" || typeof value.text !== "string") return;
  value.text = cleanMrkdwn(value.text, policy, note);
  value.verbatim = true;
}

/** The fallback text gets no verbatim, so a bare URL off the list is taken out. */
function cleanFallback(
  text: string,
  policy: LinkPolicy,
  note: (what: string) => void,
): string {
  return cleanMrkdwn(text, policy, note).replace(BARE_URL, (url) => {
    if (linkAllowed(url, policy)) return url;
    note(`a bare link to ${hostOf(url)} was taken out`);
    return "(link removed)";
  });
}

/**
 * The message as it is posted: the same blocks and words, with only what
 * breaks the kit's rules changed, so a message that keeps them looks
 * exactly as rendered. Every mrkdwn text gets verbatim, so Slack links
 * nothing by itself (no bare URL, domain, channel name or mention becomes
 * a link); only explicit <url|label> links are links. In mrkdwn text, a
 * link whose URL does not start with a prefix in channels.yml becomes its
 * label (or its URL, as plain text), any other <...> token (user, channel
 * and group mentions, @here, @channel, @everyone, dates) is shown as text,
 * and bare @here, @channel and @everyone are broken with a word joiner.
 * The fallback text, which cannot take verbatim, loses bare URLs off the
 * list too. Headers are plain_text, which Slack does not parse. Each
 * change but verbatim is named in changes.
 */
export function cleanMessage(
  message: SlackMessage,
  policy: LinkPolicy,
): { message: SlackMessage; changes: string[] } {
  const out = structuredClone(message);
  const changes: string[] = [];
  out.text = cleanFallback(out.text, policy, (what) =>
    changes.push(`fallback text: ${what}`),
  );
  for (const [i, block] of out.blocks.entries()) {
    const note = (what: string) => changes.push(`block ${i + 1}: ${what}`);
    if (block.type === "section" && typeof block.text === "object")
      cleanTextObject(block.text as Record<string, unknown>, policy, note);
    if (block.type === "context" && Array.isArray(block.elements))
      for (const e of block.elements as unknown[])
        if (typeof e === "object" && e !== null)
          cleanTextObject(e as Record<string, unknown>, policy, note);
  }
  return { message: out, changes };
}

/** Why Slack or the kit would not take this message as one post, or undefined when it would. */
export function postProblem(message: SlackMessage): string | undefined {
  if (typeof message.text !== "string" || message.text.trim() === "")
    return "its fallback text is empty";
  if (message.text.length > MAX_FALLBACK_CHARS)
    return `its fallback text is over ${MAX_FALLBACK_CHARS} characters`;
  if (message.blocks.length === 0) return "it has no blocks";
  if (message.blocks.length > MAX_BLOCKS)
    return `it has ${message.blocks.length} blocks; Slack takes at most ${MAX_BLOCKS}`;
  for (const [i, block] of message.blocks.entries()) {
    const problem = blockProblem(block as Block, i);
    if (problem !== undefined) return problem;
  }
  const bytes = Buffer.byteLength(
    JSON.stringify({ text: message.text, blocks: message.blocks }),
  );
  if (bytes > MAX_POST_BYTES)
    return `its text and blocks are ${bytes} bytes of JSON, over the kit's ${MAX_POST_BYTES} byte ceiling`;
  return undefined;
}

/**
 * A shadow run's post: the cleaned message under one context line naming
 * the job and saying it is a shadow run, with the same words leading the
 * fallback text, so the post is never taken for a live one.
 */
export function shadowMessage(
  message: SlackMessage,
  job: string,
  liveChannel: string,
): SlackMessage {
  const line: Block = {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Shadow run of ${job}, not a live post. Live, it posts to #${liveChannel}.`,
        verbatim: true,
      },
    ],
  };
  return {
    ...message,
    text: `Shadow run of ${job}, not a live post. ${message.text}`,
    blocks: [line, ...message.blocks],
  };
}
