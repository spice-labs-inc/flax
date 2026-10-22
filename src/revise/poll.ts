import { workspace } from "../lib/workspace.ts";
import { READ_PERMISSIONS } from "../tools-server/github.ts";
import { usesModel, type JobConfig } from "../lib/job.ts";
import { decide, isJobPull } from "./requests.ts";
import { asPullInfo, readPullThread, type GithubGet } from "./thread.ts";

/**
 * The poller's token also reads organization members: without it GitHub
 * marks a member whose membership is private as a contributor, and their
 * review would not count as trusted.
 */
export const POLL_PERMISSIONS: Readonly<Record<string, "read">> = {
  ...READ_PERMISSIONS,
  members: "read",
};

/** A run of a job's workflow, as much as the poller needs of it. */
export interface WorkflowRun {
  /** queued, waiting, pending, requested, in_progress or completed. */
  status: string;
  /** success, failure, cancelled, ...; null until the run completes. */
  conclusion: string | null;
  /** The run's display title: its run name, which names a revision's target. */
  title: string;
  createdAt: string;
}

export interface PollOptions {
  jobs: readonly JobConfig[];
  /** GitHub REST reads of the target repositories. */
  get: GithubGet;
  /** The recent runs of a job's workflow, newest first, including any queued or running. */
  runs: (job: string) => Promise<WorkflowRun[]>;
  /** Starts a revision run of the job's workflow for the target, owner/name#number. */
  dispatch: (job: string, target: string) => Promise<void>;
  /**
   * Puts a queued ${workspace().displayName} check on the pull request's head commit once
   * its revision run is started. A refusal is a line in the outcome, never
   * a failure of the poll.
   */
  queueCheck?: (request: QueuedRevision) => Promise<void>;
}

/** A pull request whose revision run the poller just started. */
export interface QueuedRevision {
  job: string;
  repo: string;
  number: number;
  branch: string;
  headSha: string;
  /** Who made the newest waiting request. */
  login: string;
  requests: number;
}

export interface PollOutcome {
  /** One plain line per thing looked at, dispatched or skipped. */
  lines: string[];
  /** Repositories listed and pull requests read. */
  reads: number;
  /** Repositories or pull requests that could not be read. */
  readFailures: number;
  /** Jobs that needed a dispatch and did not get one because GitHub failed: listing runs or dispatching. */
  dispatchFailures: number;
}

/** Statuses of a run that has not started; one such run means a dispatch would cancel or queue behind it. */
export const WAITING_STATUSES = ["queued", "waiting", "pending", "requested"];

/** The jobs whose pull requests can be revised: live pull request jobs. */
export function revisableJobs(jobs: readonly JobConfig[]): JobConfig[] {
  return jobs.filter(
    (j) => j.mode === "live" && j.output.kind === "pr" && usesModel(j),
  );
}

/** The pull request a revision run takes, and its run name carries: owner/name#number. */
export function reviseTarget(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/** The run's name says it revises this target. */
export function namesTarget(title: string, target: string): boolean {
  const words = title.trim().split(/\s+/);
  return words.some((w, i) => w === "revise" && words[i + 1] === target);
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

interface Candidate {
  target: string;
  queued: QueuedRevision;
  /** When its oldest waiting request was made. */
  oldest: string;
  /** When its newest waiting request was made. */
  newest: string;
}

/**
 * Finds the open pull requests of live pull request jobs with a request
 * no revision has answered, and starts at most one revision run per job:
 * the pull request whose oldest request is oldest. A job with a run that
 * has not started yet is left alone, since the job's concurrency group
 * keeps one pending run and a newer one cancels it.
 */
export async function pollRevisions(
  options: PollOptions,
): Promise<PollOutcome> {
  const out: PollOutcome = {
    lines: [],
    reads: 0,
    readFailures: 0,
    dispatchFailures: 0,
  };
  const say = (line: string) => out.lines.push(line);
  for (const job of revisableJobs(options.jobs)) {
    if (job.output.kind !== "pr") continue;
    const candidates: Candidate[] = [];
    for (const repo of job.output.repos) {
      let listed: unknown;
      try {
        listed = await options.get(
          `/repos/${repo}/pulls?state=open&per_page=100`,
        );
        if (!Array.isArray(listed))
          throw new Error("GitHub returned no list of pull requests");
      } catch (err) {
        out.readFailures++;
        say(
          `${job.name}: could not list the pull requests of ${repo}: ${message(err)}`,
        );
        continue;
      }
      out.reads++;
      const numbers: number[] = [];
      for (const item of listed) {
        try {
          const pull = asPullInfo(repo, item);
          if (isJobPull(pull, job.name)) numbers.push(pull.number);
        } catch (err) {
          out.readFailures++;
          say(`${job.name}: ${message(err)}`);
        }
      }
      say(
        `${job.name}: ${repo} has ${numbers.length} open pull request${numbers.length === 1 ? "" : "s"} of the job`,
      );
      for (const number of numbers) {
        const target = reviseTarget(repo, number);
        let decision;
        let thread;
        try {
          thread = await readPullThread(options.get, repo, number);
          decision = decide(thread, job.name);
        } catch (err) {
          out.readFailures++;
          say(`${target}: could not be read: ${message(err)}`);
          continue;
        }
        out.reads++;
        if (decision.action === "none") {
          say(`${target}: nothing to do, ${decision.reason}`);
          continue;
        }
        const n = decision.requests.length;
        const waiting = `${n} request${n === 1 ? "" : "s"} waiting`;
        say(
          decision.action === "limit"
            ? `${target}: ${waiting}, but its revision rounds are used up; a run will say a person needs to take it from here`
            : `${target}: ${waiting}, round ${decision.round} would answer ${n === 1 ? "it" : "them"}`,
        );
        candidates.push({
          target,
          queued: {
            job: job.name,
            repo,
            number,
            branch: thread.pull.branch,
            headSha: thread.pull.headSha,
            login: decision.requests.at(-1)!.author,
            requests: n,
          },
          oldest: decision.requests[0]!.at,
          newest: decision.requests.at(-1)!.at,
        });
      }
    }
    if (candidates.length === 0) continue;

    let runs: WorkflowRun[];
    try {
      runs = await options.runs(job.name);
    } catch (err) {
      out.dispatchFailures++;
      say(
        `${job.name}: dispatched nothing, its workflow runs could not be listed: ${message(err)}`,
      );
      continue;
    }
    const waitingRun = runs.find((r) => WAITING_STATUSES.includes(r.status));
    if (waitingRun !== undefined) {
      say(
        `${job.name}: dispatched nothing, a run of the job is ${waitingRun.status} ("${waitingRun.title}"); the next poll tries again`,
      );
      continue;
    }
    const ready: Candidate[] = [];
    for (const c of candidates) {
      const mine = runs.filter((r) => namesTarget(r.title, c.target));
      if (mine.some((r) => r.status === "in_progress")) {
        say(`${c.target}: skipped, a revision run of it is in progress`);
        continue;
      }
      // A run started after the newest request read them all; one that ended without answering is not retried until someone asks again.
      const failed = mine.find(
        (r) =>
          r.status === "completed" &&
          r.conclusion !== "cancelled" &&
          r.createdAt > c.newest,
      );
      if (failed !== undefined) {
        say(
          `${c.target}: skipped, a revision run started after its newest request ended ${failed.conclusion ?? "without a conclusion"} without answering; a new request starts another`,
        );
        continue;
      }
      ready.push(c);
    }
    const next = ready.sort((a, b) =>
      a.oldest < b.oldest ? -1 : a.oldest > b.oldest ? 1 : 0,
    )[0];
    if (next === undefined) continue;
    try {
      await options.dispatch(job.name, next.target);
    } catch (err) {
      out.dispatchFailures++;
      say(
        `${job.name}: could not dispatch revise ${next.target}: ${message(err)}`,
      );
      continue;
    }
    say(
      `${job.name}: dispatched revise ${next.target}${ready.length > 1 ? `; ${ready.length - 1} more wait for later polls` : ""}`,
    );
    if (options.queueCheck !== undefined)
      try {
        await options.queueCheck(next.queued);
        say(`${next.target}: queued its ${workspace().displayName} check`);
      } catch (err) {
        say(
          `${next.target}: its ${workspace().displayName} check was not queued: ${message(err)}`,
        );
      }
  }
  return out;
}
