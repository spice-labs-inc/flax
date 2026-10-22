import { createAjv, describeErrors } from "../lib/ajv.ts";
import { firstLine } from "../lib/problem.ts";

export const MAX_ANSWER_BYTES = 1024 * 1024;

const FENCED = /^```[A-Za-z]*\n([\s\S]*?)\n```$/;

/** Every ```json (or unlabeled) block in a reply, wherever it sits. */
const JSON_BLOCK = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;

/** How much of the ignored text the warning quotes. */
const IGNORED_QUOTE_CHARS = 40;

/**
 * Parses the model's final message as JSON. A reply wrapped in one code
 * fence is accepted too, and so is prose with exactly one ```json block in
 * it, or prose followed by JSON that starts on its own line and runs to the
 * end: models add these often enough that failing the run would only add
 * noise. A message that starts with one complete JSON object or array and
 * goes on with text that holds no second one (a broken leftover fragment,
 * or prose) gives that first value, with a warning saying what was
 * ignored. A second complete value after the first (the rest on its own,
 * or one that starts a line of it), JSON written inline in a sentence, or
 * two blocks, is refused: which one is the answer would be a guess.
 */
export function parseAnswer(
  text: string,
): { value: unknown; warning?: string } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { error: "the answer is empty" };
  const body = FENCED.exec(trimmed)?.[1] ?? trimmed;
  try {
    return { value: JSON.parse(body) };
  } catch (err) {
    const leading = leadingJson(trimmed);
    if (leading !== undefined) {
      if (holdsJson(leading.rest))
        return {
          error:
            "the answer is two JSON values, one after the other: which one is the answer would be a guess",
        };
      const chars = [...leading.rest];
      return {
        value: leading.value,
        warning: `text after the answer was ignored: ${chars.length} characters, starting ${JSON.stringify(chars.slice(0, IGNORED_QUOTE_CHARS).join(""))}`,
      };
    }
    const blocks = [...trimmed.matchAll(JSON_BLOCK)];
    if (blocks.length === 1)
      try {
        return { value: JSON.parse(blocks[0]![1]!) };
      } catch {
        // The one block is not JSON either; report the whole answer's error.
      }
    const trailing = trailingJson(trimmed);
    if (trailing !== undefined) return { value: trailing };
    return { error: `the answer is not JSON: ${firstLine(err)}` };
  }
}

/**
 * The JSON that starts at the beginning of a line after the first and runs
 * to the end of `text`, if any, and only when no line before it is JSON on
 * its own (then there would be two answers).
 */
function trailingJson(text: string): unknown {
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (!/^[{[]/.test(lines[i]!)) continue;
    if (isJson(lines[i]!) && i < lines.length - 1) return undefined;
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {
      // Not where the answer starts; try the next line.
    }
  }
  return undefined;
}

/** The complete JSON object or array `text` starts with, and the trimmed text after it. */
function leadingJson(
  text: string,
): { value: unknown; rest: string } | undefined {
  const end = valueEnd(text, 0);
  if (end === undefined) return undefined;
  try {
    return {
      value: JSON.parse(text.slice(0, end)),
      rest: text.slice(end).trim(),
    };
  } catch {
    return undefined;
  }
}

/** Whether `text` is JSON, or a line of it starts a complete JSON object or array. */
function holdsJson(text: string): boolean {
  if (isJson(text)) return true;
  let at = 0;
  for (;;) {
    const end = valueEnd(text, at);
    if (end !== undefined && isJson(text.slice(at, end))) return true;
    const newline = text.indexOf("\n", at);
    if (newline === -1) return false;
    at = newline + 1;
  }
}

/** The index just past the object or array that starts at `from`, by its brackets outside strings; undefined when none starts there or it never closes. */
function valueEnd(text: string, from: number): number | undefined {
  if (text[from] !== "{" && text[from] !== "[") return undefined;
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Problems with the answer against the job's output.json, one line each; empty when it matches. */
export function answerProblems(value: unknown, schema: object): string[] {
  const validate = createAjv().compile(schema);
  if (validate(value)) return [];
  return describeErrors(validate.errors).map((e) =>
    e.field === undefined ? e.message : `${e.field}: ${e.message}`,
  );
}
