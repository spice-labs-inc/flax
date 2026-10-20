import type { ValidateFunction } from "ajv/dist/2020.js";
import { createAjv, describeErrors } from "./ajv.ts";

/** The answer key the runner adds to every job's schema for the notes. */
export const MAINTAINER_NOTES_KEY = "maintainer_notes";

/** The report file the notes are kept in, and the only file of the notes artifact. */
export const MAINTAINER_NOTES_FILE = "maintainer-notes.json";

/** The workflow artifact that holds a run's maintainer-notes.json alone. */
export function notesArtifact(job: string): string {
  return `job-${job}-maintainer-notes`;
}

export const NOTE_KINDS = [
  "missing_data",
  "missing_tool",
  "unclear_prompt",
  "limit_hit",
] as const;

export type NoteKind = (typeof NOTE_KINDS)[number];

export interface MaintainerNote {
  kind: NoteKind;
  text: string;
}

export const MAX_NOTES = 5;
export const MAX_NOTE_CHARS = 300;

/** What the model is given under maintainer_notes: a few short items, each with a kind. */
export const MAINTAINER_NOTES_SCHEMA = {
  description:
    "Optional. Notes for the people who maintain this job, never shown to its readers and never delivered. Leave it out or empty when nothing got in your way.",
  type: "array",
  maxItems: MAX_NOTES,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "text"],
    properties: {
      kind: {
        description:
          "missing_data: data the input or the tools did not have; missing_tool: a tool that would have helped; unclear_prompt: instructions that were unclear or conflicting; limit_hit: a limit you hit (turns, tool calls, time, tokens).",
        type: "string",
        enum: [...NOTE_KINDS],
      },
      text: {
        description: "One or two plain sentences.",
        type: "string",
        minLength: 1,
        maxLength: MAX_NOTE_CHARS,
      },
    },
  },
} as const;

let validator: ValidateFunction | undefined;

/** Problems with a notes value, one line each; empty when it matches. */
export function maintainerNotesProblems(value: unknown): string[] {
  validator ??= createAjv().compile(MAINTAINER_NOTES_SCHEMA);
  if (validator(value)) return [];
  return describeErrors(validator.errors).map((e) =>
    e.field === undefined ? e.message : `${e.field}: ${e.message}`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The schema Pi is given: the job's output.json with maintainer_notes added as an optional property. */
export function withMaintainerNotes(schema: object): object {
  const s = schema as { properties?: Record<string, unknown> };
  return {
    ...schema,
    properties: {
      ...(s.properties ?? {}),
      [MAINTAINER_NOTES_KEY]: MAINTAINER_NOTES_SCHEMA,
    },
  };
}

/** Why a job's output.json cannot take the notes, or undefined when it can. */
export function notesSchemaProblem(schema: unknown): string | undefined {
  if (!isPlainObject(schema) || schema.type !== "object")
    return `must have type: object at the top, so the runner can add ${MAINTAINER_NOTES_KEY} to it`;
  if (
    isPlainObject(schema.properties) &&
    Object.hasOwn(schema.properties, MAINTAINER_NOTES_KEY)
  )
    return `${MAINTAINER_NOTES_KEY} is reserved for the runner's maintainer notes`;
  return undefined;
}

export interface SplitAnswer {
  /** The answer without maintainer_notes, for the job's output check and everything after it. */
  answer: unknown;
  notes: MaintainerNote[];
  /** Set when the notes were there but malformed, and so dropped. */
  warning?: string;
}

/**
 * Takes maintainer_notes off the answer. Notes that do not match the notes
 * schema are dropped with a warning; they never fail the run.
 */
export function splitMaintainerNotes(value: unknown): SplitAnswer {
  if (!isPlainObject(value) || !Object.hasOwn(value, MAINTAINER_NOTES_KEY))
    return { answer: value, notes: [] };
  const { [MAINTAINER_NOTES_KEY]: notes, ...answer } = value;
  const problems = maintainerNotesProblems(notes);
  if (problems.length === 0)
    return { answer, notes: notes as MaintainerNote[] };
  const first = problems[0]!;
  return {
    answer,
    notes: [],
    warning: `${MAINTAINER_NOTES_KEY} was dropped: ${first.length > 200 ? `${first.slice(0, 200)}...` : first}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""}`,
  };
}

/** Model text as plain Markdown: one line, no control characters, every Markdown and HTML character escaped. */
export function plainMarkdown(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_{}[\]()#+\-.!|<>~:&"'=]/g, (c) => `\\${c}`);
}
