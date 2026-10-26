import { workspace } from "../lib/workspace.ts";
import type { PullThread } from "../revise/thread.ts";
import type { CheckFields } from "./checks.ts";

/** A file as it is in a repository at one commit. */
export interface RepoFile {
  text: string;
  /** The git file mode, such as 100644; kept when the file is written back. */
  mode: string;
}

/** An open pull request, as much as delivery needs to know of it. */
export interface OpenPull {
  number: number;
  url: string;
  /** The head branch. */
  branch: string;
  /** The head branch is in the repository itself, not a fork. */
  sameRepo: boolean;
  /** Opened by a GitHub App (a bot account), as the writer app's pull requests are. */
  byBot: boolean;
}

/** A file a commit writes: text, or bytes for a media file. */
export type CommitFile =
  | { path: string; text: string; mode: string }
  | { path: string; bytes: Buffer; mode: string };

export interface CommitRequest {
  /** The commit the new commit is made on; the pages were read and checked at it. */
  base: string;
  /** An agent branch; created, or moved to the new commit when it exists. */
  branch: string;
  message: string;
  author: { name: string; email: string };
  date: Date;
  files: readonly CommitFile[];
  /**
   * A revision: the branch must exist and be at this commit (the pull
   * request's head, which is also base), and it only moves forward; if
   * anyone pushed to it since, nothing is written.
   */
  fastForwardFrom?: string;
}

/**
 * What delivery may do in a repository, and nothing more: read a file at a
 * commit, write a commit to an agent branch, and open, update or close its
 * pull requests, and write check runs on its own branches' head commits.
 * There is no way to merge, approve, or write any branch but an agent
 * branch; the GitHub implementation refuses those
 * itself, whatever the caller asks.
 */
export interface PrWriter {
  defaultBranch(repo: string): Promise<string>;
  readFile(
    repo: string,
    commit: string,
    path: string,
  ): Promise<RepoFile | undefined>;
  /** Returns the new commit. */
  commitFiles(repo: string, request: CommitRequest): Promise<string>;
  openPulls(repo: string): Promise<OpenPull[]>;
  openPull(
    repo: string,
    pull: {
      branch: string;
      base: string;
      title: string;
      body: string;
      /** Open it as a draft (output.draft). */
      draft?: boolean;
    },
  ): Promise<{ number: number; url: string }>;
  updatePull(
    repo: string,
    number: number,
    pull: { title: string; body: string },
  ): Promise<void>;
  /** Comments on the pull request, then closes it. */
  closePull(repo: string, number: number, comment: string): Promise<void>;
  /** A pull request with its changed files, reviews and comments. */
  readPullThread(repo: string, number: number): Promise<PullThread>;
  /** Posts a comment on a pull request. */
  comment(repo: string, number: number, body: string): Promise<void>;
  /** Replies in the thread of a review comment on a pull request. */
  replyToReviewComment(
    repo: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<void>;
  /** Asks people or teams (by slug) of the organization to review a pull request; throws when GitHub refuses. */
  requestReviewers(
    repo: string,
    number: number,
    who: { reviewers?: readonly string[]; teamReviewers?: readonly string[] },
  ): Promise<void>;
  deleteBranch(repo: string, branch: string): Promise<void>;
  /** Squash-merges an open pull request while its head is still `head`; throws when GitHub refuses. */
  mergePull(
    repo: string,
    number: number,
    head: string,
  ): Promise<{ sha: string }>;
  /** Creates a check run on the head commit of an agent branch, which must be at headSha; returns its id. */
  createCheck(
    repo: string,
    check: CheckFields & { name: string; branch: string; headSha: string },
  ): Promise<number>;
  /** Updates a check run the writer made. */
  updateCheck(repo: string, id: number, fields: CheckFields): Promise<void>;
  /** The check runs of this name on a commit, newest first. */
  findChecks(
    repo: string,
    headSha: string,
    name: string,
  ): Promise<{ id: number; status: string }[]>;
}

/** Every branch an agent writes starts with this. */
export const AGENT_BRANCH_PREFIX = "agent/";

/** The author and committer of every agent commit. */
export function commitAuthor(): { name: string; email: string } {
  return workspace().commitAuthor;
}

/** The branches of one job: agent/<job>/. */
export function jobBranchPrefix(job: string): string {
  return `${AGENT_BRANCH_PREFIX}${job}/`;
}

/** The branch of one job's delivery on one day (UTC): agent/<job>/<YYYY-MM-DD>. */
export function deliveryBranch(job: string, now: Date): string {
  return `${jobBranchPrefix(job)}${now.toISOString().slice(0, 10)}`;
}

const BRANCH = /^agent\/[a-z][a-z0-9-]{1,40}\/[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** A branch delivery may write or delete: agent/<job>/<YYYY-MM-DD> and nothing else. */
export function isAgentBranch(branch: string): boolean {
  return BRANCH.test(branch);
}

/** A branch key (output.branch_key): two to eight groups of lowercase letters and digits joined by hyphens, never a date. */
const BRANCH_KEY = /^[a-z0-9]+(?:-[a-z0-9]+){1,7}$/;
export const MAX_BRANCH_KEY_CHARS = 64;

/** Whether a value may be a branch key: a slug of hyphenated words, at most 64 characters, that cannot pass for a day. */
export function isBranchKey(key: string): boolean {
  return (
    key.length <= MAX_BRANCH_KEY_CHARS &&
    BRANCH_KEY.test(key) &&
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(key)
  );
}

/** The branch of one key of a job with output.branch_key: agent/<job>/<key>. */
export function keyedBranch(job: string, key: string): string {
  return `${jobBranchPrefix(job)}${key}`;
}

const KEYED_BRANCH = /^agent\/[a-z][a-z0-9-]{1,40}\/([^/]+)$/;

/** A branch of one key: agent/<job>/<key>. */
export function isKeyedAgentBranch(branch: string): boolean {
  const key = KEYED_BRANCH.exec(branch)?.[1];
  return key !== undefined && isBranchKey(key);
}

/** A branch the writer may write, merge or delete: a day branch, or a key branch of a job with output.branch_key. */
export function isWritableAgentBranch(branch: string): boolean {
  return isAgentBranch(branch) || isKeyedAgentBranch(branch);
}
