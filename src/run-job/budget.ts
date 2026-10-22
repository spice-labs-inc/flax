import type { Model } from "../lib/allowlists.ts";
import type { ModelJobConfig } from "../lib/job.ts";

export interface LedgerEntry {
  job: string;
  /** Calendar month in UTC, as YYYY-MM. */
  month: string;
  runName: string;
  usd: number;
}

/** Spend shared by every job, with the cap on it when the ledger knows one. */
export interface SharedSpend {
  who: string;
  spentUsd: number;
  limitUsd?: number;
}

/**
 * Where month-to-date spend per job is kept. Runs start on fresh VMs, so a
 * real ledger needs storage outside the runner: the model gateway
 * (gatewayLedger in gateway.ts). Runs that reach no gateway (stub runs and
 * --preflight) use noopLedger, which enforces only the per-run worst case.
 */
export interface Ledger {
  readonly durable: boolean;
  spentUsd(job: string, month: string): Promise<number>;
  /** The spend of all jobs this month, for a ledger that knows it. */
  sharedSpend?(month: string): Promise<SharedSpend>;
  record(entry: LedgerEntry): Promise<void>;
}

/** Remembers nothing: every month starts, and stays, at zero. */
export const noopLedger: Ledger = {
  durable: false,
  spentUsd: () => Promise.resolve(0),
  record: () => Promise.resolve(),
};

/** An in-memory ledger, for tests. */
export function memoryLedger(entries: LedgerEntry[] = []): Ledger & {
  entries: LedgerEntry[];
} {
  return {
    durable: false,
    entries,
    spentUsd: (job, month) =>
      Promise.resolve(
        entries
          .filter((e) => e.job === job && e.month === month)
          .reduce((sum, e) => sum + e.usd, 0),
      ),
    record: (entry) => {
      entries.push(entry);
      return Promise.resolve();
    },
  };
}

export function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/**
 * The most one run can cost: every token of the per-run limit billed at
 * the model's higher price. This is what a run reserves and, without the
 * gateway, records; with the gateway it is also the run key's budget, which
 * the gateway enforces on every call.
 */
/** A model's dearer per-million price, input or output: what a run reserves at. */
export function dearest(model: Model): number {
  return Math.max(model.usd_per_million_input, model.usd_per_million_output);
}

export function worstCaseUsd(job: ModelJobConfig, model: Model): number {
  const perToken = dearest(model) / 1e6;
  return job.limits.tokens_per_run * perToken;
}

export type BudgetDecision =
  | {
      ok: true;
      spentUsd: number;
      reserveUsd: number;
      month: string;
      shared?: SharedSpend;
    }
  | { ok: false; reason: string };

/**
 * Whether a run of a model job may start: the model's worst case plus
 * mediaReserveUsd (its media key's budget, when the media stage gets one)
 * must fit the job's month and the shared month.
 */
export function checkMonthlyBudget(
  job: ModelJobConfig,
  model: Model,
  ledger: Ledger,
  now: Date,
  mediaReserveUsd = 0,
): Promise<BudgetDecision> {
  return checkReserve(
    job.name,
    job.limits.usd_per_month,
    worstCaseUsd(job, model) + mediaReserveUsd,
    ledger,
    now,
  );
}

/** Whether a run that may spend reserveUsd fits the job's limitUsd this month and the shared month. */
export async function checkReserve(
  name: string,
  limit: number,
  reserveUsd: number,
  ledger: Ledger,
  now: Date,
): Promise<BudgetDecision> {
  const month = monthOf(now);
  const spentUsd = await ledger.spentUsd(name, month);
  if (spentUsd + reserveUsd > limit) {
    return {
      ok: false,
      reason: `${name} has spent $${spentUsd.toFixed(2)} of its $${limit} in ${month}; a run can cost up to $${reserveUsd.toFixed(2)}`,
    };
  }
  const shared = await ledger.sharedSpend?.(month);
  if (
    shared?.limitUsd !== undefined &&
    shared.spentUsd + reserveUsd > shared.limitUsd
  ) {
    return {
      ok: false,
      reason: `${shared.who} have spent $${shared.spentUsd.toFixed(2)} of $${shared.limitUsd} in ${month}; a run of ${name} can cost up to $${reserveUsd.toFixed(2)}`,
    };
  }
  return {
    ok: true,
    spentUsd,
    reserveUsd,
    month,
    ...(shared === undefined ? {} : { shared }),
  };
}

/**
 * Why a run cannot pay for another second check, or undefined when it can:
 * its key must have at least as much left as the run has spent so far,
 * since one second check costs less than the writer and the first check
 * together.
 */
export function anotherReviewProblem(
  spentUsd: number,
  limitUsd: number,
): string | undefined {
  return limitUsd - spentUsd >= spentUsd
    ? undefined
    : `the run has spent $${spentUsd.toFixed(4)} of its $${limitUsd.toFixed(2)}, too little for another second check`;
}
