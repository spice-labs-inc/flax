import { isWritableAgentBranch, jobBranchPrefix } from "../deliver/writer.ts";
import type { PullInfo, PullThread } from "./thread.ts";

/** Only these authors can ask an agent to revise: people with a role in the repository. */
export const TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
/** A comment whose first line starts with this asks the agent for a change. */
export const COMMAND = "/agent";
/** Revision rounds per pull request; after that a person takes it from here. */
export const MAX_ROUNDS = 5;
/** Characters of one request the model gets. */
export const MAX_REQUEST_CHARS = 4000;

export interface RevisionRequest {
  /** review-<id>, line-<id> or comment-<id>. */
  id: string;
  kind: "review" | "line" | "comment";
  author: string;
  /** For a line comment: the file and the line in the pull request's version. */
  path?: string;
  line?: number;
  text: string;
  url: string;
  at: string;
}

export interface RevisionState {
  /** Revision rounds already answered on the pull request. */
  rounds: number;
  /** Request ids an agent comment already answered. */
  answered: Set<string>;
  /** An agent comment already said the round limit is reached. */
  limitNoticed: boolean;
}

const MARKER =
  /<!-- agents revision round=(\d+) answered=([a-z0-9,-]*) -->/;
export const LIMIT_MARKER = "<!-- agents revision-limit -->";

/** The hidden line an agent's reply comment carries: its round and the requests it answered. */
export function revisionMarker(round: number, answered: readonly string[]) {
  return `<!-- agents revision round=${round} answered=${answered.join(",")} -->`;
}

/** The pull request is one this job's writer opened: an agent branch of the job, in the repository, by a bot. */
export function isJobPull(pull: PullInfo, job: string): boolean {
  return (
    pull.byBot &&
    pull.sameRepo &&
    isWritableAgentBranch(pull.branch) &&
    pull.branch.startsWith(jobBranchPrefix(job))
  );
}

/** What the agent's own comments on the pull request say: rounds done and requests answered. */
export function revisionState(thread: PullThread): RevisionState {
  const state: RevisionState = {
    rounds: 0,
    answered: new Set(),
    limitNoticed: false,
  };
  for (const c of thread.comments) {
    if (!c.byBot) continue;
    if (c.body.includes(LIMIT_MARKER)) state.limitNoticed = true;
    const m = MARKER.exec(c.body);
    if (m === null) continue;
    state.rounds = Math.max(state.rounds, Number(m[1]));
    for (const id of m[2]!.split(",")) if (id !== "") state.answered.add(id);
  }
  return state;
}

const trusted = (association: string) =>
  TRUSTED_ASSOCIATIONS.includes(association);

/** The text after the command on a comment's first line, with the rest of the comment; undefined when it is not a command. */
export function commandText(body: string): string | undefined {
  const text = body.replace(/^\s+/, "");
  if (!text.toLowerCase().startsWith(COMMAND)) return undefined;
  const rest = text.slice(COMMAND.length);
  if (rest !== "" && !/^\s/.test(rest)) return undefined;
  return rest.trim();
}

const cut = (text: string) =>
  text.length <= MAX_REQUEST_CHARS
    ? text
    : `${text.slice(0, MAX_REQUEST_CHARS)} (cut)`;

/**
 * The requests on a pull request no agent comment has answered yet, oldest
 * first: a Request changes review's text and its line comments, and any
 * comment or line comment whose first line starts with /agent. Only
 * people GitHub marks as an owner, member or collaborator count, never a
 * bot. A request older than the latest approval is left alone: the
 * approval came after it.
 */
export function pendingRequests(thread: PullThread): RevisionRequest[] {
  const state = revisionState(thread);
  const approvedAt = thread.reviews
    .filter((r) => r.state === "APPROVED" && trusted(r.association))
    .map((r) => r.submittedAt)
    .sort()
    .at(-1);
  const out: RevisionRequest[] = [];
  const asking = new Set<number>();
  for (const r of thread.reviews) {
    if (r.state !== "CHANGES_REQUESTED" || !trusted(r.association)) continue;
    asking.add(r.id);
    if (r.body.trim() !== "")
      out.push({
        id: `review-${r.id}`,
        kind: "review",
        author: r.author,
        text: cut(r.body.trim()),
        url: r.url,
        at: r.submittedAt,
      });
  }
  for (const c of thread.reviewComments) {
    if (!trusted(c.association)) continue;
    const command = commandText(c.body);
    if (
      !(c.reviewId !== null && asking.has(c.reviewId)) &&
      command === undefined
    )
      continue;
    const text = command ?? c.body.trim();
    if (text === "") continue;
    out.push({
      id: `line-${c.id}`,
      kind: "line",
      author: c.author,
      path: c.path,
      ...(c.line === null ? {} : { line: c.line }),
      text: cut(text),
      url: c.url,
      at: c.createdAt,
    });
  }
  for (const c of thread.comments) {
    if (c.byBot || !trusted(c.association)) continue;
    const command = commandText(c.body);
    if (command === undefined || command === "") continue;
    out.push({
      id: `comment-${c.id}`,
      kind: "comment",
      author: c.author,
      text: cut(command),
      url: c.url,
      at: c.createdAt,
    });
  }
  return out
    .filter((r) => !state.answered.has(r.id))
    .filter((r) => approvedAt === undefined || r.at > approvedAt)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export type RevisionDecision =
  | { action: "none"; reason: string }
  | { action: "limit"; requests: RevisionRequest[] }
  | { action: "revise"; requests: RevisionRequest[]; round: number };

/** What a revision should do about this pull request now. */
export function decide(thread: PullThread, job: string): RevisionDecision {
  const { pull } = thread;
  if (pull.state !== "open" || pull.merged)
    return { action: "none", reason: "the pull request is not open" };
  if (!isJobPull(pull, job))
    return {
      action: "none",
      reason: `the pull request is not one ${job} opened (its branch must be ${jobBranchPrefix(job)}<day>, opened by the writer app)`,
    };
  const requests = pendingRequests(thread);
  if (requests.length === 0)
    return { action: "none", reason: "no request is waiting for an answer" };
  const state = revisionState(thread);
  if (state.rounds >= MAX_ROUNDS)
    return state.limitNoticed
      ? {
          action: "none",
          reason: `the pull request had its ${MAX_ROUNDS} rounds and was told so`,
        }
      : { action: "limit", requests };
  return { action: "revise", requests, round: state.rounds + 1 };
}
