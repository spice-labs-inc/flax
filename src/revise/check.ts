import { workspace } from "../lib/workspace.ts";
import { plainText } from "../deliver/pr-text.ts";
import {
  checkName,
  writeCheck,
  type CheckFields,
  type CheckRecord,
} from "../deliver/checks.ts";
import { firstLine } from "../lib/problem.ts";
import type { PrWriter } from "../deliver/writer.ts";
import { MAX_ROUNDS } from "./requests.ts";

/** What the poller's writer token may do: put a queued check on a job branch's head (contents read, to see the branch is there), nothing else. */
export const QUEUE_CHECK_PERMISSIONS: Readonly<
  Record<string, "read" | "write">
> = {
  checks: "write",
  contents: "read",
  metadata: "read",
};

/** A revision's check run sits on the pull request's head commit, on the job's branch. */
export interface RevisionCheckTarget {
  repo: string;
  job: string;
  branch: string;
  head: string;
}

const link = (runUrl?: string) =>
  runUrl === undefined ? {} : { detailsUrl: runUrl };

/** The poller saw a trusted request and started a revision run. */
export function queuedCheck(login: string, requests: number): CheckFields {
  return {
    status: "queued",
    title: `Revision requested by @${login}`,
    summary: `${requests} request${requests === 1 ? "" : "s"} waiting; a revision run was started and answers on the pull request.`,
  };
}

/** The revision run is answering. */
export function inProgressCheck(
  round: number,
  requests: number,
  runUrl?: string,
): CheckFields {
  return {
    status: "in_progress",
    title: `Revision round ${round} of ${MAX_ROUNDS} in progress`,
    summary: `Answering ${requests} request${requests === 1 ? "" : "s"}. The reply comment and any new commit follow on the pull request.`,
    ...link(runUrl),
  };
}

/** How a revision round ended, as its check run shows it. */
export function endedCheck(
  outcome:
    | { kind: "revised"; commit: string; round: number }
    | { kind: "answered"; round: number }
    | { kind: "failed"; reason: string }
    | { kind: "limit" }
    | { kind: "nothing"; reason: string },
  runUrl?: string,
): CheckFields {
  switch (outcome.kind) {
    case "revised":
      return {
        status: "completed",
        conclusion: "success",
        title: `Revised in ${outcome.commit.slice(0, 7)}, round ${outcome.round} of ${MAX_ROUNDS}`,
        summary:
          `The new commit is on the pull request with its own check; the ${workspace().displayName} replied in each thread and left a summary comment.`,
        ...link(runUrl),
      };
    case "answered":
      return {
        status: "completed",
        conclusion: "success",
        title: `Answered, no change, round ${outcome.round} of ${MAX_ROUNDS}`,
        summary:
          `No page changed; the ${workspace().displayName} replied in each thread saying why.`,
        ...link(runUrl),
      };
    case "failed":
      return {
        status: "completed",
        conclusion: "failure",
        title: `Revision failed: ${firstLine(outcome.reason)}`,
        summary: `The revision run did not change the pull request. ${plainText(firstLine(outcome.reason))}`,
        ...link(runUrl),
      };
    case "limit":
      return {
        status: "completed",
        conclusion: "neutral",
        title: `Revision limit reached: ${MAX_ROUNDS} rounds used`,
        summary:
          "No more revision rounds run on this pull request; a person takes it from here.",
        ...link(runUrl),
      };
    case "nothing":
      return {
        status: "completed",
        conclusion: "neutral",
        title: `Nothing to revise: ${firstLine(outcome.reason)}`,
        summary: plainText(firstLine(outcome.reason)),
        ...link(runUrl),
      };
  }
}

/** The queued or running check of this job on the head commit, when the poller or an earlier attempt made one. */
async function openCheck(
  writer: PrWriter,
  t: RevisionCheckTarget,
): Promise<number | undefined> {
  try {
    const found = await writer.findChecks(t.repo, t.head, checkName(t.job));
    return found.find((c) => c.status !== "completed")?.id;
  } catch {
    return undefined;
  }
}

/** Moves the poller's queued check to in progress, or makes one in progress; never throws. */
export async function startRevisionCheck(
  writer: PrWriter,
  t: RevisionCheckTarget,
  fields: CheckFields,
): Promise<CheckRecord> {
  return writeCheck(writer, t, fields, await openCheck(writer, t));
}

/** Completes the revision's check, or makes a completed one when there is none to complete; never throws. */
export async function endRevisionCheck(
  writer: PrWriter,
  t: RevisionCheckTarget,
  fields: CheckFields,
  started?: CheckRecord,
  createIfNone = true,
): Promise<CheckRecord | undefined> {
  const id = started?.id ?? (await openCheck(writer, t));
  if (id === undefined && !createIfNone) return undefined;
  return writeCheck(writer, t, fields, id);
}
