import { readFileSync, writeFileSync } from "node:fs";

/** Names the mailbox of the tools server that serves collect.ts, in the environment collect.ts gets. */
export const COLLECT_MAILBOX_ENV = "FLAX_AGENTS_COLLECT_MAILBOX";

/** Holds the job's settings from job.yml, as JSON, in the environment collect.ts gets. */
export const JOB_SETTINGS_ENV = "FLAX_AGENTS_JOB_SETTINGS";

/** The settings job.yml gives collect.ts; empty when it gives none. */
export function jobSettings(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, boolean | number | string> {
  const text = env[JOB_SETTINGS_ENV];
  if (text === undefined || text === "") return {};
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${JOB_SETTINGS_ENV} is not a JSON object`);
  return value as Record<string, boolean | number | string>;
}

/** The directory in the run directory, outside the data directory, that holds that mailbox. */
export const COLLECT_DIR = "collect";

/** Holds the collect inputs filled in for this run (collect_inputs in job.yml), as a JSON object of name to value, in the environment collect.ts gets; unset when none is. */
export const COLLECT_INPUTS_ENV = "FLAX_AGENTS_COLLECT_INPUTS";

/** The collect inputs filled in for this run, by name; empty for a scheduled run or one started by hand with none filled in. Each value matched its pattern in job.yml. */
export function collectInputs(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const text = env[COLLECT_INPUTS_ENV];
  if (text === undefined || text === "") return {};
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.values(value).every((v) => typeof v === "string")
  )
    throw new Error(`${COLLECT_INPUTS_ENV} is not a JSON object of strings`);
  return value as Record<string, string>;
}

/** The top-level input field by which collect.ts says the run has nothing to do. */
export const NOTHING_TO_DO = "nothing_to_do";

/** What collect.ts prints when the run has nothing to do: the run calls no model, records the reason and passes. One line, at most 500 characters. */
export function nothingToDo(reason: string): { nothing_to_do: string } {
  return { [NOTHING_TO_DO]: reason } as { nothing_to_do: string };
}

/** Where the previous run's ledger is (ledger: true in job.yml), in the environment collect.ts gets; unset when there is none yet. */
export const LEDGER_IN_ENV = "FLAX_AGENTS_LEDGER_IN";

/** Where collect.ts writes the ledger the next run reads, in the environment collect.ts gets; unset for a job without a ledger. */
export const LEDGER_OUT_ENV = "FLAX_AGENTS_LEDGER_OUT";

/** The previous run's ledger, a JSON object; undefined when there is none yet or the job keeps none. */
export function readLedger(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | undefined {
  const path = env[LEDGER_IN_ENV];
  if (path === undefined || path === "") return undefined;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`the ledger at ${LEDGER_IN_ENV} is not a JSON object`);
  return value as Record<string, unknown>;
}

/** Writes the ledger the next run reads; does nothing for a job without one (a stub run, or locally without the flags). */
export function writeLedger(
  ledger: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = env[LEDGER_OUT_ENV];
  if (path === undefined || path === "") return;
  writeFileSync(path, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
}
