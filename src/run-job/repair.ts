import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createAjv } from "../lib/ajv.ts";
import { SESSION_FILE } from "./argv.ts";

/** The most a repair turn may run; it also only gets what is left of the run's own time limit (limits.turns). */
export const REPAIR_TIMEOUT_SECONDS = 600;
/** Below this much time left, no repair turn starts. */
export const MIN_REPAIR_SECONDS = 120;

/** Seconds the repair turn may run: what the writer left of the run's time limit, at most REPAIR_TIMEOUT_SECONDS; 0 when that is under MIN_REPAIR_SECONDS. */
export function repairSeconds(limitSeconds: number, usedMs: number): number {
  const left = Math.min(
    REPAIR_TIMEOUT_SECONDS,
    limitSeconds - Math.ceil(usedMs / 1000),
  );
  return left < MIN_REPAIR_SECONDS ? 0 : left;
}

/** Problems the repair request lists; a longer list is cut with a count of the rest. */
export const MAX_REPAIR_PROBLEMS = 40;

/** What the repair turn did, for status.json and summary.md. */
export interface RepairRecord {
  /** What was wrong with the first answer: why it is not JSON, or each way it does not match the schema. */
  problems: string[];
  /** repaired: the new answer matches; failed: the turn ran and did not fix it; skipped: it could not run. */
  outcome: "repaired" | "failed" | "skipped";
  reason?: string;
  /** What is still wrong after the repair turn. */
  problemsAfter?: string[];
}

/**
 * The Pi session the run left to continue: the newest regular file with a
 * session file name directly in the sessions directory, or undefined.
 * The box wrote the directory, so links and odd names are passed over.
 */
export function sessionToContinue(dir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { name: string; mtime: number } | undefined;
  for (const name of names) {
    if (!SESSION_FILE.test(name)) continue;
    const stat = lstatSync(join(dir, name), { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) continue;
    if (
      best === undefined ||
      stat.mtimeMs > best.mtime ||
      (stat.mtimeMs === best.mtime && name > best.name)
    )
      best = { name, mtime: stat.mtimeMs };
  }
  return best?.name;
}

const SIZE_KEYWORDS = new Set([
  "maxLength",
  "minLength",
  "maxItems",
  "minItems",
]);

/** The actual size of each value that breaks a length or count limit, so the model knows by how much. */
export function sizeNotes(value: unknown, schema: object): string[] {
  const validate = createAjv().compile(schema);
  if (validate(value)) return [];
  const notes = new Set<string>();
  for (const e of validate.errors ?? []) {
    if (!SIZE_KEYWORDS.has(e.keyword)) continue;
    const field =
      e.instancePath === ""
        ? "the answer"
        : e.instancePath
            .split("/")
            .slice(1)
            .map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"))
            .reduce(
              (path, part) =>
                /^\d+$/.test(part)
                  ? `${path}[${part}]`
                  : path === ""
                    ? part
                    : `${path}.${part}`,
              "",
            );
    if (typeof e.data === "string")
      notes.add(`${field} has ${[...e.data].length} characters`);
    else if (Array.isArray(e.data))
      notes.add(`${field} has ${e.data.length} items`);
  }
  return [...notes];
}

/** What the model is told when its final answer is refused: what is wrong, exactly, and what to send instead. */
export function repairPrompt(o: {
  notJson: boolean;
  problems: readonly string[];
  sizes: readonly string[];
}): string {
  const listed = o.problems.slice(0, MAX_REPAIR_PROBLEMS);
  const more = o.problems.length - listed.length;
  return [
    "Your final answer was not accepted, and nothing has been delivered.",
    o.notJson
      ? "It could not be read as one JSON object:"
      : "It does not match the output schema (output.schema.json, given at the start of this session):",
    "",
    ...listed.map((p) => `- ${p}`),
    ...(more > 0 ? [`- and ${more} more`] : []),
    ...(o.sizes.length === 0
      ? []
      : ["", "Sizes as sent:", "", ...o.sizes.map((s) => `- ${s}`)]),
    "",
    "Send the corrected final answer as your final message: the complete JSON object, nothing before or after it, matching the schema, with only what these problems need changed.",
    "A value over a length or count limit must become smaller by changing or saying less, never by cutting it off part way: a cut patch or sentence is wrong.",
    "This is the only correction the run allows. If this answer does not match the schema either, the run fails.",
    "",
  ].join("\n");
}
