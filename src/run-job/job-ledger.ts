import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { LEDGER_IN_ENV, LEDGER_OUT_ENV } from "../collect/env.ts";
import { firstLine } from "../lib/problem.ts";
import { PREVIOUS_TOKEN_ENV, previousResultsRun } from "./previous-results.ts";

/**
 * A job's ledger (ledger: true in job.yml): one small JSON object its
 * collect.ts writes on every run and reads on the next, kept between runs
 * as the workflow artifact job-<name>-ledger, such as which crashes it
 * already investigated. Only collect.ts reads or writes it; it never
 * reaches the model unless collect.ts puts part of it in the input.
 */

/** The file a ledger is kept in, in the artifact and in the run's report. */
export const LEDGER_FILE = "ledger.json";
/** The most a ledger may weigh. */
export const MAX_LEDGER_BYTES = 256 * 1024;

/** The artifact a job's ledger is kept in between runs, in shadow and live alike. */
export function ledgerArtifact(job: string): string {
  return `job-${job}-ledger`;
}

/** Why text is not a ledger: a JSON object of at most MAX_LEDGER_BYTES; undefined when it is. */
export function ledgerProblem(text: string): string | undefined {
  if (Buffer.byteLength(text) > MAX_LEDGER_BYTES)
    return `it is over ${MAX_LEDGER_BYTES} bytes`;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return `it is not JSON: ${firstLine(err)}`;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "it is not a JSON object";
  return undefined;
}

/** What a run did with its ledger, for status.json. */
export interface LedgerRecord {
  /** The previous run's ledger was there and read. */
  read: boolean;
  /** Why the previous run's ledger was not used, when one was there. */
  ignored?: string;
  /** collect.ts wrote a ledger, kept for the next run. */
  written: boolean;
  bytes?: number;
}

/**
 * Before collect.ts: the previous ledger, from the directory the workflow
 * downloaded it to, copied into the run's own directory; and the
 * environment that tells collect.ts where it is and where to write the
 * next one. A ledger that is not one is ignored, with the reason.
 */
export function prepareLedger(
  runDir: string,
  previousDir: string | undefined,
): { env: Record<string, string>; record: LedgerRecord; next: string } {
  const dir = join(runDir, "ledger");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const next = join(dir, "next.json");
  const env: Record<string, string> = { [LEDGER_OUT_ENV]: next };
  const record: LedgerRecord = { read: false, written: false };
  const from =
    previousDir === undefined ? undefined : join(previousDir, LEDGER_FILE);
  if (from !== undefined && existsSync(from)) {
    const stat = lstatSync(from);
    const text = stat.isFile() ? readFileSync(from, "utf8") : "";
    const problem = stat.isFile()
      ? ledgerProblem(text)
      : "it is not a plain file";
    if (problem === undefined) {
      const copy = join(dir, "previous.json");
      copyFileSync(from, copy);
      env[LEDGER_IN_ENV] = copy;
      record.read = true;
    } else record.ignored = problem;
  }
  return { env, record, next };
}

/**
 * After collect.ts: the ledger it wrote, checked, as the next run's
 * ledger in the directory the workflow uploads, and its text for the
 * report. A ledger that is not one fails the run: the job's own code
 * wrote it.
 */
export function keepLedger(
  next: string,
  outDir: string | undefined,
  record: LedgerRecord,
): { text?: string; error?: string } {
  if (!existsSync(next)) return {};
  const text = readFileSync(next, "utf8");
  const problem = ledgerProblem(text);
  if (problem !== undefined)
    return {
      error: `collect.ts wrote a ledger the kit cannot keep: ${problem}`,
    };
  record.written = true;
  record.bytes = Buffer.byteLength(text);
  if (outDir !== undefined) {
    mkdirSync(outDir, { recursive: true });
    copyFileSync(next, join(outDir, LEDGER_FILE));
  }
  return { text };
}

/**
 * Before a run of a job with a ledger: finds the workflow run that left
 * the newest ledger artifact, other than this one, with the workflow's
 * own token (actions: read), and writes it as run_id to the step's
 * outputs for the step that downloads it. An empty run_id: no ledger yet.
 */
export async function findLedgerRun(o: {
  job: string;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}): Promise<{ ok: boolean; message: string }> {
  const token = (o.env[PREVIOUS_TOKEN_ENV] ?? "").trim();
  const repo = o.env.GITHUB_REPOSITORY ?? "";
  if (token === "" || repo === "")
    return {
      ok: false,
      message: `${PREVIOUS_TOKEN_ENV} and GITHUB_REPOSITORY must be set to find the previous ledger`,
    };
  const artifact = ledgerArtifact(o.job);
  let run: number | undefined;
  try {
    run = await previousResultsRun({
      repo,
      artifact,
      token,
      ...(o.env.GITHUB_RUN_ID === undefined
        ? {}
        : { currentRunId: o.env.GITHUB_RUN_ID }),
      ...(o.env.GITHUB_API_URL === undefined
        ? {}
        : { apiUrl: o.env.GITHUB_API_URL }),
      ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    });
  } catch (err) {
    return { ok: false, message: `${o.job}: ${firstLine(err)}` };
  }
  const out = o.env.GITHUB_OUTPUT;
  if (out !== undefined && out !== "")
    appendFileSync(out, `run_id=${run ?? ""}\n`);
  return {
    ok: true,
    message:
      run === undefined
        ? `${o.job}: no earlier ${artifact}; collect.ts starts with none.`
        : `${o.job}: the previous ${artifact} is in run ${run}.`,
  };
}
