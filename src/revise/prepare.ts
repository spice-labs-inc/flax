import type { PrWriter } from "../deliver/writer.ts";
import type { PrPolicy } from "../output-check/pr.ts";
import { buildRevisionInput } from "./input.ts";
import { originalRunId } from "./original.ts";
import { decide, type RevisionRequest } from "./requests.ts";
import type { PullThread } from "./thread.ts";

/** Where a revision target is written on the command line and in the workflow input: owner/name#number. */
const TARGET =
  /^([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,8})$/;

export function parseRevisionTarget(
  text: string,
): { repo: string; number: number } | undefined {
  const m = TARGET.exec(text);
  return m === null ? undefined : { repo: m[1]!, number: Number(m[2]) };
}

export type PreparedRevision =
  /** Nothing to do: the pull request is closed, not the job's, or has no request waiting. */
  | { kind: "nothing"; reason: string; thread: PullThread }
  /** The round limit is reached: the limit comment is all there is to do. */
  | { kind: "limit"; thread: PullThread; requests: RevisionRequest[] }
  /** A round that cannot run, though requests are waiting: the reply comment says why. */
  | {
      kind: "failed";
      error: string;
      thread: PullThread;
      requests: RevisionRequest[];
      round: number;
    }
  | {
      kind: "revise";
      thread: PullThread;
      requests: RevisionRequest[];
      round: number;
      originalRunId: number;
      input: Record<string, unknown>;
    };

export interface PrepareOptions {
  job: string;
  repo: string;
  number: number;
  policy: PrPolicy;
  writer: PrWriter;
  /** The input of the run that opened the pull request. */
  readOriginal(job: string, runId: number): Promise<unknown>;
}

/**
 * Reads the pull request with the writer, decides whether a round is due,
 * and builds the round's input from the original run's input and the
 * pages at the pull request's head.
 */
export async function prepareRevision(
  o: PrepareOptions,
): Promise<PreparedRevision> {
  const thread = await o.writer.readPullThread(o.repo, o.number);
  const decision = decide(thread, o.job);
  if (decision.action === "none")
    return { kind: "nothing", reason: decision.reason, thread };
  if (decision.action === "limit")
    return { kind: "limit", thread, requests: decision.requests };
  const { requests, round } = decision;
  const failed = (error: string): PreparedRevision => ({
    kind: "failed",
    error,
    thread,
    requests,
    round,
  });
  const runId = originalRunId(thread.pull.body);
  if (runId === undefined)
    return failed(
      "the pull request body names no agents run, so the run that opened it cannot be read",
    );
  let original: unknown;
  try {
    original = await o.readOriginal(o.job, runId);
  } catch (err) {
    return failed(
      `the input of run ${runId}, which opened this pull request, could not be read: ${(err as Error).message}`,
    );
  }
  const built = await buildRevisionInput({
    original,
    thread,
    requests,
    round,
    policy: o.policy,
    readFile: (path, commit) => o.writer.readFile(o.repo, commit, path),
  });
  if ("error" in built) return failed(built.error);
  return {
    kind: "revise",
    thread,
    requests,
    round,
    originalRunId: runId,
    input: built.input,
  };
}
