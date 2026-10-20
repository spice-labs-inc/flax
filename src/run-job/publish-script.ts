import { existsSync } from "node:fs";
import { join } from "node:path";
import { jobFile } from "../lib/paths.ts";
import { runJobScript } from "./input.ts";
import type { RefusedChange } from "./pr-output.ts";
import { prSectionsProblem, type PrSection } from "../deliver/pr-sections.ts";
import { checkRendered, type Block } from "./slack-render.ts";

const PUBLISH_TIMEOUT_MS = 60_000;
const MAX_PUBLISH_BYTES = 4 * 1024 * 1024;
export const MAX_PUBLISH_REASON_CHARS = 500;

/**
 * The short analysis a run that publishes nothing posts to output.notify:
 * a message as render.ts prints one (text and blocks), or "render" for the
 * message the job's render.ts made of the answer.
 */
export type AnalysisMessage = { text: string; blocks: Block[] } | "render";

/** What a job's publish.ts decided: the patch set to deliver, with sections for the pull request body, or nothing and why, with an analysis to post and its full text as sections for the report. */
export type Published =
  | {
      publish: true;
      answer: Record<string, unknown>;
      record?: unknown;
      sections?: PrSection[];
    }
  | {
      publish: false;
      reason: string;
      record?: unknown;
      message?: AnalysisMessage;
      /** The full analysis, kept in the report as analysis.md and shown on the run's page. */
      sections?: PrSection[];
    };

export function hasPublish(root: string, name: string): boolean {
  return existsSync(join(root, jobFile(name, "publish.ts")));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks what publish.ts printed: publish true with the answer to deliver, or publish false with a one-line reason. */
export function checkPublished(value: unknown): Published | { error: string } {
  if (!isObject(value)) return { error: "it is not a JSON object" };
  const extra = Object.keys(value).find(
    (k) =>
      ![
        "publish",
        "answer",
        "reason",
        "record",
        "sections",
        "message",
      ].includes(k),
  );
  if (extra !== undefined) return { error: `it has the key ${extra}` };
  const record = "record" in value ? { record: value.record } : {};
  if (value.publish === true) {
    if (!isObject(value.answer))
      return { error: "publish is true but answer is not an object" };
    if ("reason" in value)
      return { error: "publish is true, so it takes no reason" };
    if ("message" in value)
      return {
        error:
          "publish is true, so it takes no message; the pull request is the news",
      };
    if (!("sections" in value))
      return { publish: true, answer: value.answer, ...record };
    const problem = prSectionsProblem(value.sections);
    if (problem !== undefined) return { error: problem };
    return {
      publish: true,
      answer: value.answer,
      ...record,
      sections: value.sections as PrSection[],
    };
  }
  if (value.publish === false) {
    if ("answer" in value)
      return { error: "publish is false, so it takes no answer" };
    const reason = value.reason;
    if (typeof reason !== "string" || reason.trim() === "")
      return { error: "publish is false but there is no reason" };
    if (reason.includes("\n") || reason.length > MAX_PUBLISH_REASON_CHARS)
      return {
        error: `the reason must be one line of at most ${MAX_PUBLISH_REASON_CHARS} characters`,
      };
    let sections: { sections?: PrSection[] } = {};
    if ("sections" in value) {
      const problem = prSectionsProblem(value.sections);
      if (problem !== undefined) return { error: problem };
      sections = { sections: value.sections as PrSection[] };
    }
    if (!("message" in value))
      return { publish: false, reason, ...record, ...sections };
    if (value.message === "render")
      return {
        publish: false,
        reason,
        ...record,
        message: "render",
        ...sections,
      };
    const message = checkRendered(value.message);
    if ("error" in message) return { error: `message: ${message.error}` };
    return { publish: false, reason, ...record, message, ...sections };
  }
  return { error: "publish is not true or false" };
}

/**
 * Runs the job's publish.ts on the accepted answer and the run's input, as
 * its own process without any credential, and checks what it printed.
 * With refused (output.drop_refused_changes), it runs again after the
 * second check refused those changes of what it printed before, to print
 * the answer without them, or nothing.
 */
export async function runPublishScript(options: {
  root: string;
  name: string;
  answer: unknown;
  input: unknown;
  env: NodeJS.ProcessEnv;
  refused?: readonly RefusedChange[];
}): Promise<Published> {
  const printed = await runJobScript(
    options.root,
    options.name,
    "publish.ts",
    options.env,
    {
      stdin: JSON.stringify({
        answer: options.answer,
        input: options.input,
        ...(options.refused === undefined ? {} : { refused: options.refused }),
      }),
      timeoutMs: PUBLISH_TIMEOUT_MS,
      maxBytes: MAX_PUBLISH_BYTES,
    },
  );
  const checked = checkPublished(printed);
  if ("error" in checked)
    throw new Error(
      `${jobFile(options.name, "publish.ts")} printed what the run cannot use: ${checked.error}`,
    );
  return checked;
}
