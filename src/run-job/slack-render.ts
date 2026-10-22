import { existsSync } from "node:fs";
import { join } from "node:path";
import { jobFile } from "../lib/paths.ts";
import { runJobScript } from "./input.ts";

/** Slack takes at most 50 blocks per message; one is kept for the footer and one for the line that marks a shadow run's post. */
export const MAX_BLOCKS = 50;
export const MAX_JOB_BLOCKS = MAX_BLOCKS - 2;
export const MAX_SECTION_CHARS = 3000;
export const MAX_HEADER_CHARS = 150;
export const MAX_CONTEXT_ELEMENTS = 10;
export const MAX_FALLBACK_CHARS = 3000;
/** The fallback text a job may print; the rest is kept for the words that mark a shadow run's post. */
export const MAX_JOB_FALLBACK_CHARS = MAX_FALLBACK_CHARS - 100;
const RENDER_TIMEOUT_MS = 60_000;
const MAX_RENDER_BYTES = 1024 * 1024;

/** The block types a job's render.ts may use: the ones a report needs, nothing interactive. */
export const BLOCK_TYPES = ["header", "section", "divider", "context"] as const;

export type Block = Record<string, unknown> & { type: string };

/** A message as chat.postMessage takes it, without the channel. */
export interface SlackMessage {
  text: string;
  blocks: Block[];
  unfurl_links: false;
  unfurl_media: false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
  return isObject(value) && typeof value.text === "string"
    ? value.text
    : undefined;
}

/** The keys each block type may have: nothing interactive, no images, no accessories. */
const BLOCK_KEYS: Record<string, readonly string[]> = {
  header: ["type", "text", "block_id"],
  section: ["type", "text", "block_id"],
  divider: ["type", "block_id"],
  context: ["type", "elements", "block_id"],
};
const TEXT_KEYS = ["type", "text", "emoji", "verbatim"];

/** Why a text object is not plain_text or mrkdwn text with only the usual keys. */
function textObjectProblem(
  value: unknown,
  types: readonly string[],
): string | undefined {
  if (!isObject(value)) return "is not a text object";
  if (typeof value.type !== "string" || !types.includes(value.type))
    return `has a text of type ${String(value.type)}; it takes ${types.join(" or ")}`;
  const extra = Object.keys(value).find((k) => !TEXT_KEYS.includes(k));
  if (extra !== undefined) return `has a text with the key ${extra}`;
  return undefined;
}

/** Why a block is not one a report message may carry, or undefined when it is fine. */
export function blockProblem(block: unknown, i: number): string | undefined {
  const at = `block ${i + 1}`;
  if (!isObject(block) || typeof block.type !== "string")
    return `${at} is not an object with a type`;
  const keys = BLOCK_KEYS[block.type];
  if (keys !== undefined) {
    const extra = Object.keys(block).find((k) => !keys.includes(k));
    if (extra !== undefined)
      return `${at} (${block.type}) has the key ${extra}; a report block has only ${keys.join(", ")}`;
  }
  switch (block.type) {
    case "divider":
      return undefined;
    case "header": {
      const text = textOf(block.text);
      if (text === undefined) return `${at} (header) has no text`;
      const kind = textObjectProblem(block.text, ["plain_text"]);
      if (kind !== undefined) return `${at} (header) ${kind}`;
      if (text.length > MAX_HEADER_CHARS)
        return `${at} (header) is over ${MAX_HEADER_CHARS} characters`;
      return undefined;
    }
    case "section": {
      const text = textOf(block.text);
      if (text === undefined) return `${at} (section) has no text`;
      const kind = textObjectProblem(block.text, ["mrkdwn"]);
      if (kind !== undefined) return `${at} (section) ${kind}`;
      if (text.length > MAX_SECTION_CHARS)
        return `${at} (section) is over ${MAX_SECTION_CHARS} characters`;
      return undefined;
    }
    case "context": {
      const elements = block.elements;
      if (!Array.isArray(elements) || elements.length === 0)
        return `${at} (context) has no elements`;
      if (elements.length > MAX_CONTEXT_ELEMENTS)
        return `${at} (context) has more than ${MAX_CONTEXT_ELEMENTS} elements`;
      if (elements.some((e) => textOf(e) === undefined))
        return `${at} (context) has an element without text`;
      for (const e of elements) {
        const kind = textObjectProblem(e, ["mrkdwn"]);
        if (kind !== undefined) return `${at} (context) ${kind}`;
      }
      return undefined;
    }
    default:
      return `${at} has type ${block.type}; a report uses only ${BLOCK_TYPES.join(", ")}`;
  }
}

/** Checks what render.ts printed: a fallback text and the blocks of one Slack message. */
export function checkRendered(
  value: unknown,
): { text: string; blocks: Block[] } | { error: string } {
  if (!isObject(value)) return { error: "it is not a JSON object" };
  const { text, blocks } = value;
  if (typeof text !== "string" || text.trim() === "")
    return { error: "text is not a non-empty string" };
  if (text.length > MAX_JOB_FALLBACK_CHARS)
    return {
      error: `text is over ${MAX_JOB_FALLBACK_CHARS} characters; the rest is kept for marking a shadow run's post`,
    };
  if (!Array.isArray(blocks) || blocks.length === 0)
    return { error: "blocks is not a non-empty array" };
  if (blocks.length > MAX_JOB_BLOCKS)
    return {
      error: `it has ${blocks.length} blocks; at most ${MAX_JOB_BLOCKS} leave room for the footer and the shadow-run line`,
    };
  for (const [i, block] of blocks.entries()) {
    const problem = blockProblem(block, i);
    if (problem !== undefined) return { error: problem };
  }
  return { text, blocks: blocks as Block[] };
}

/** The workflow run's page, when the run is one; built from the variables GitHub Actions sets. */
export function workflowRunUrl(env: NodeJS.ProcessEnv): string | undefined {
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const id = env.GITHUB_RUN_ID;
  if (
    server === undefined ||
    !/^https:\/\/[A-Za-z0-9.-]+$/.test(server) ||
    repo === undefined ||
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) ||
    id === undefined ||
    !/^\d+$/.test(id)
  )
    return undefined;
  return `${server}/${repo}/actions/runs/${id}`;
}

/** The small context line that ends every agent message: the run that made it, the job and the model. */
export function footerBlock(options: {
  runUrl: string | undefined;
  job: string;
  model: string;
}): Block {
  const run =
    options.runUrl === undefined
      ? "Local run, no workflow run to link"
      : `<${options.runUrl}|Workflow run ${options.runUrl.slice(options.runUrl.lastIndexOf("/") + 1)}>`;
  return {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${run} · job ${options.job} · model ${options.model}`,
      },
    ],
  };
}

/** Slack mrkdwn as Markdown: links, bold, bullets and the three escapes. */
export function mrkdwnToMarkdown(text: string): string {
  return text
    .replace(/<([^<>|]+)\|([^<>]+)>/g, "[$2]($1)")
    .replace(/<(https?:[^<>|]+)>/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,:;!?])/g, "$1**$2**")
    .replace(/^• /gm, "- ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** A readable copy of the message, for the run report. */
export function slackMarkdown(message: SlackMessage): string {
  const parts: string[] = [];
  for (const block of message.blocks) {
    switch (block.type) {
      case "header":
        parts.push(`## ${textOf(block.text) ?? ""}`);
        break;
      case "section":
        parts.push(
          mrkdwnToMarkdown(textOf(block.text) ?? "")
            .split("\n")
            .join("  \n"),
        );
        break;
      case "divider":
        parts.push("---");
        break;
      case "context":
        parts.push(
          `<sub>${(block.elements as unknown[])
            .map((e) => mrkdwnToMarkdown(textOf(e) ?? ""))
            .join(" ")}</sub>`,
        );
        break;
    }
  }
  return `${parts.join("\n\n")}\n`;
}

export function hasRender(root: string, name: string): boolean {
  return existsSync(join(root, jobFile(name, "render.ts")));
}

/**
 * Runs the job's render.ts on the answer, as its own process without any
 * credential, checks the message it prints, and ends it with the footer.
 * Nothing is posted: the message is kept in the run report.
 */
export async function renderSlackMessage(options: {
  root: string;
  name: string;
  answer: unknown;
  env: NodeJS.ProcessEnv;
  model: string;
}): Promise<SlackMessage> {
  const printed = await runJobScript(
    options.root,
    options.name,
    "render.ts",
    options.env,
    {
      stdin: JSON.stringify(options.answer),
      timeoutMs: RENDER_TIMEOUT_MS,
      maxBytes: MAX_RENDER_BYTES,
    },
  );
  const checked = checkRendered(printed);
  if ("error" in checked)
    throw new Error(
      `${jobFile(options.name, "render.ts")} printed a message Slack would not take: ${checked.error}`,
    );
  return {
    text: checked.text,
    blocks: [
      ...checked.blocks,
      footerBlock({
        runUrl: workflowRunUrl(options.env),
        job: options.name,
        model: options.model,
      }),
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

/** The answer fields a message without render.ts takes its one line from, first found first. */
export const PLAIN_LINE_FIELDS = [
  "headline",
  "summary",
  "title",
  "text",
  "message",
] as const;
export const MAX_PLAIN_LINE_CHARS = 300;

/** Escapes what Slack's mrkdwn treats as markup. */
export function escapeMrkdwn(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function plainLine(answer: unknown): string {
  if (isObject(answer))
    for (const field of PLAIN_LINE_FIELDS) {
      const value = answer[field];
      if (typeof value !== "string") continue;
      const line = value.replace(/\s+/g, " ").trim();
      if (line !== "") return line.slice(0, MAX_PLAIN_LINE_CHARS);
    }
  return "finished; the answer is in the run's report";
}

/**
 * The message of a job without render.ts: one line naming the job, like the
 * release notifications, taken from the answer's first non-empty field of
 * PLAIN_LINE_FIELDS, then the footer.
 */
export function plainSlackMessage(options: {
  name: string;
  answer: unknown;
  env: NodeJS.ProcessEnv;
  model: string;
}): SlackMessage {
  const line = plainLine(options.answer);
  return {
    text: `${options.name}: ${line}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${options.name}*: ${escapeMrkdwn(line)}`,
        },
      },
      footerBlock({
        runUrl: workflowRunUrl(options.env),
        job: options.name,
        model: options.model,
      }),
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}
