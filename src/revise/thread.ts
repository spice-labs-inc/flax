/**
 * What a revision reads of a pull request, and how it is read from GitHub
 * REST. The writer (in a revision run) and the poller (with the reader
 * app's token) read the same shape through readPullThread.
 */

export interface PullInfo {
  repo: string;
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  /** The head branch. */
  branch: string;
  headSha: string;
  /** The head branch is in the repository itself, not a fork. */
  sameRepo: boolean;
  /** Opened by a GitHub App (a bot account), as the writer app's pull requests are. */
  byBot: boolean;
  body: string;
}

export interface ReviewItem {
  id: number;
  author: string;
  /** GitHub's author_association: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ... */
  association: string;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING. */
  state: string;
  body: string;
  url: string;
  submittedAt: string;
}

export interface ReviewCommentItem {
  id: number;
  /** The review the comment belongs to; null for a comment GitHub gives none. */
  reviewId: number | null;
  author: string;
  association: string;
  path: string;
  /** The line in the pull request's version of the file, when GitHub gives one. */
  line: number | null;
  body: string;
  url: string;
  createdAt: string;
}

export interface IssueCommentItem {
  id: number;
  author: string;
  association: string;
  byBot: boolean;
  body: string;
  url: string;
  createdAt: string;
}

export interface PullThread {
  pull: PullInfo;
  /** Paths the pull request changes. */
  files: string[];
  reviews: ReviewItem[];
  reviewComments: ReviewCommentItem[];
  comments: IssueCommentItem[];
}

/** One GET against the GitHub REST API, relative to its root, for example /repos/o/r/pulls/1. */
export type GithubGet = (path: string) => Promise<unknown>;

/** The most pages of 100 read of any one list. */
export const MAX_PAGES = 5;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

function user(v: unknown): { login: string; bot: boolean } {
  const u = isObject(v) ? v : {};
  return { login: str(u.login), bot: u.type === "Bot" };
}

async function list(get: GithubGet, path: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const got = await get(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    const items = Array.isArray(got) ? got : [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

/** A pull request as GitHub REST returns it, cut to what a revision needs. */
export function asPullInfo(repo: string, value: unknown): PullInfo {
  const p = isObject(value) ? value : {};
  const head = isObject(p.head) ? p.head : {};
  const headRepo = isObject(head.repo) ? head.repo : {};
  const number = num(p.number);
  if (number === null || str(head.ref) === "" || str(head.sha) === "")
    throw new Error(`${repo}: GitHub returned no usable pull request`);
  return {
    repo,
    number,
    url: str(p.html_url),
    state: p.state === "closed" ? "closed" : "open",
    merged: p.merged === true || typeof p.merged_at === "string",
    branch: str(head.ref),
    headSha: str(head.sha),
    sameRepo: str(headRepo.full_name) === repo,
    byBot: user(p.user).bot,
    body: str(p.body),
  };
}

/** Reads a pull request, its changed files, its reviews and both kinds of comments. */
export async function readPullThread(
  get: GithubGet,
  repo: string,
  number: number,
): Promise<PullThread> {
  const base = `/repos/${repo}`;
  const pull = asPullInfo(repo, await get(`${base}/pulls/${number}`));
  const [files, reviews, reviewComments, comments] = await Promise.all([
    list(get, `${base}/pulls/${number}/files`),
    list(get, `${base}/pulls/${number}/reviews`),
    list(get, `${base}/pulls/${number}/comments`),
    list(get, `${base}/issues/${number}/comments`),
  ]);
  return {
    pull,
    files: files
      .filter(isObject)
      .map((f) => str(f.filename))
      .filter(Boolean),
    reviews: reviews.filter(isObject).map((r) => ({
      id: num(r.id) ?? 0,
      author: user(r.user).login,
      association: str(r.author_association),
      state: str(r.state),
      body: str(r.body),
      url: str(r.html_url),
      submittedAt: str(r.submitted_at),
    })),
    reviewComments: reviewComments.filter(isObject).map((c) => ({
      id: num(c.id) ?? 0,
      reviewId: num(c.pull_request_review_id),
      author: user(c.user).login,
      association: str(c.author_association),
      path: str(c.path),
      line: num(c.line) ?? num(c.original_line),
      body: str(c.body),
      url: str(c.html_url),
      createdAt: str(c.created_at),
    })),
    comments: comments.filter(isObject).map((c) => ({
      id: num(c.id) ?? 0,
      author: user(c.user).login,
      association: str(c.author_association),
      byBot: user(c.user).bot,
      body: str(c.body),
      url: str(c.html_url),
      createdAt: str(c.created_at),
    })),
  };
}
