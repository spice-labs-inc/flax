/**
 * When a GitHub REST call is tried again. GitHub answers some writes with a
 * transient 5xx (a docs map pull request once failed on a 500 from
 * git/blobs after its videos were uploaded); these calls are retried with
 * backoff, the rest fail at once.
 */

/** Waits between attempts: three retries after the first try. */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

/** A Retry-After longer than this is not waited for: the call fails instead. */
export const MAX_RETRY_AFTER_MS = 60_000;

const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);

/** A GitHub REST call that failed: the status, or undefined when no answer came (reset, timeout). */
export class GithubCallError extends Error {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(
    message: string,
    status: number | undefined,
    retryAfterMs?: number,
  ) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Whether repeating `method path` leaves the same result as doing it once:
 * reads; PUT, PATCH and DELETE, which set state; and the git object writes,
 * which are content-addressed (delivery's commits carry their own author and
 * committer dates, so a repeat makes the same commit). Creating a ref or a
 * pull request, comments, check runs and GraphQL are not: their callers
 * check what exists before trying again, or do not try again.
 */
export function safeToRepeat(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "PUT" || m === "PATCH") return true;
  if (m === "DELETE") return true;
  if (m !== "POST") return false;
  const p = path.split("?")[0]!;
  return (
    /\/git\/(blobs|trees|commits)$/.test(p) ||
    /\/pulls\/\d+\/requested_reviewers$/.test(p)
  );
}

/** Retry-After as milliseconds: seconds or an HTTP date. */
export function retryAfterMs(
  header: string | null,
  now = Date.now(),
): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Whether an answer is worth another try: a transient 5xx, or a secondary
 * rate limit (429, or 403 with Retry-After) that asks for a short wait.
 */
export function isTransient(
  status: number | undefined,
  retryAfter?: number,
): boolean {
  if (status === undefined) return true;
  if (TRANSIENT_STATUS.has(status)) return true;
  if (status === 429 || status === 403)
    return retryAfter !== undefined && retryAfter <= MAX_RETRY_AFTER_MS;
  return false;
}

/** The wait before retry number `attempt` (0-based): Retry-After when GitHub gave one, the schedule otherwise. */
export function delayFor(
  attempt: number,
  retryAfter: number | undefined,
  delays: readonly number[] = RETRY_DELAYS_MS,
): number {
  return retryAfter ?? delays[attempt]!;
}

export const sleepMs = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
