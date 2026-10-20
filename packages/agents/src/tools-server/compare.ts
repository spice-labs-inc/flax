import { readCapped } from "./artifacts.ts";
import { COMMIT_SHA, GITHUB_API, MAX_PATCH_LINES } from "./github.ts";
import { personLogin } from "../lib/login.ts";

/** A compare answer with every file's diff can run to megabytes; nothing bigger is read. */
export const MAX_COMPARE_BYTES = 32 * 1024 * 1024;

/** What one compare_commits result may take: below gh-compare's result cap, with room for JSON escaping in the reply, so it is never cut. */
export const COMPARE_RESULT_BYTES = 100_000;

/** GitHub lists at most this many files of a comparison. */
export const GITHUB_COMPARE_FILES = 300;

const SUBJECT_CHARS = 300;

export interface CompareReaderOptions {
  /** The run's read-only installation token. */
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}

export interface ComparedCommit {
  sha: string;
  date: string;
  subject: string;
  /** The GitHub login of its author, when the author is a person with an account. */
  author?: string;
}

export interface ComparedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  previous_path?: string;
  patch?: string;
  /** The diff had more lines than patch_lines. */
  patch_cut?: boolean;
}

export interface Comparison {
  repo: string;
  base: string;
  head: string;
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  /** Oldest first; the newest when not all fit. */
  commits: ComparedCommit[];
  commits_left_out: number;
  files: ComparedFile[];
  /** GitHub lists at most 300 files, so a comparison with that many may have more. */
  files_may_be_more: boolean;
  /** Files whose diff was asked for but did not fit in the result. */
  patches_left_out: number;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** The first lines of a diff, and whether any were left out. */
export function cutPatch(
  patch: string,
  lines: number,
): { patch: string; cut: boolean } {
  const all = patch.split("\n");
  if (all.length <= lines) return { patch, cut: false };
  return { patch: all.slice(0, lines).join("\n"), cut: true };
}

/** A compare answer from GitHub, made small: commits and files, and diffs only while they fit. */
export function compactComparison(
  raw: unknown,
  repo: string,
  base: string,
  head: string,
  patchLines: number,
  budget = COMPARE_RESULT_BYTES,
): Comparison {
  const body = record(raw);
  const commits = (Array.isArray(body.commits) ? body.commits : []).map(
    (c): ComparedCommit => {
      const commit = record(record(c).commit);
      const committer = record(commit.committer);
      const author = record(commit.author);
      const message = typeof commit.message === "string" ? commit.message : "";
      const login = personLogin(record(c).author);
      return {
        sha: String(record(c).sha ?? ""),
        date: String(committer.date ?? author.date ?? ""),
        subject: message.split("\n")[0]!.slice(0, SUBJECT_CHARS),
        ...(login === undefined ? {} : { author: login }),
      };
    },
  );
  const rawFiles = (Array.isArray(body.files) ? body.files : []).map(record);
  const files = rawFiles.map((f): ComparedFile => ({
    path: String(f.filename ?? ""),
    status: String(f.status ?? ""),
    additions: count(f.additions),
    deletions: count(f.deletions),
    ...(typeof f.previous_filename === "string"
      ? { previous_path: f.previous_filename }
      : {}),
  }));
  const out: Comparison = {
    repo,
    base,
    head,
    status: String(body.status ?? ""),
    ahead_by: count(body.ahead_by),
    behind_by: count(body.behind_by),
    total_commits: count(body.total_commits),
    commits,
    commits_left_out: 0,
    files,
    files_may_be_more: rawFiles.length >= GITHUB_COMPARE_FILES,
    patches_left_out: 0,
  };
  while (size(out) > budget && out.commits.length > 0) {
    const drop = Math.max(1, Math.ceil(out.commits.length / 10));
    out.commits = out.commits.slice(drop);
  }
  while (size(out) > budget && out.files.length > 0)
    out.files = out.files.slice(0, Math.floor(out.files.length * 0.9));
  out.commits_left_out = Math.max(
    0,
    Math.max(out.total_commits, commits.length) - out.commits.length,
  );
  if (patchLines === 0) return out;
  let used = size(out);
  for (const [i, file] of out.files.entries()) {
    const patch = rawFiles[i]!.patch;
    if (typeof patch !== "string" || patch === "") continue;
    const cut = cutPatch(patch, patchLines);
    const entry = { patch: cut.patch, ...(cut.cut ? { patch_cut: true } : {}) };
    // The key names, quotes and commas the two fields add.
    const extra = size(entry) - 2 + 1;
    if (used + extra > budget) {
      out.patches_left_out += 1;
      continue;
    }
    Object.assign(file, entry);
    used += extra;
  }
  return out;
}

/**
 * compare_commits: GitHub's comparison of two commits of one repository
 * (base...head, both shas), read by the tools server itself with the run's
 * read-only token, like maintainer notes. One fixed GET, a size cap on the
 * answer, and a result small enough never to be cut.
 */
export class CompareReader {
  private readonly options: CompareReaderOptions;

  constructor(options: CompareReaderOptions) {
    this.options = options;
  }

  async compare(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const extra = Object.keys(args).filter(
      (k) => !["owner", "repo", "base", "head", "patch_lines"].includes(k),
    );
    if (extra.length > 0)
      throw new Error(`compare_commits takes no ${extra.join(", ")}`);
    const { owner, repo, base, head, patch_lines } = args;
    if (typeof repo !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(repo))
      throw new Error(`"${String(repo)}" is not a repository name`);
    for (const [name, value] of [
      ["base", base],
      ["head", head],
    ] as const)
      if (typeof value !== "string" || !COMMIT_SHA.test(value))
        throw new Error(`${name} must be a commit sha`);
    const lines = Number(patch_lines);
    if (!Number.isInteger(lines) || lines < 0 || lines > MAX_PATCH_LINES)
      throw new Error(`patch_lines must be 0 to ${MAX_PATCH_LINES}`);
    const path = `/repos/${encodeURIComponent(String(owner))}/${encodeURIComponent(repo)}/compare/${String(base)}...${String(head)}`;
    const res = await (this.options.fetch ?? fetch)(
      `${this.options.apiUrl ?? GITHUB_API}${path}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.options.token}`,
          "x-github-api-version": "2022-11-28",
        },
        // A renamed repository answers with a redirect to the same API.
        redirect: "follow",
        signal,
      },
    );
    const api = new URL(this.options.apiUrl ?? GITHUB_API).origin;
    if (res.url !== "" && new URL(res.url).origin !== api) {
      await res.body?.cancel();
      throw new Error("the comparison was redirected away from the GitHub API");
    }
    if (!res.ok) {
      // The body can echo request details; the status is enough to act on.
      await res.body?.cancel();
      throw new Error(`comparing the commits returned ${res.status}`);
    }
    const bytes = await readCapped(res, MAX_COMPARE_BYTES);
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("the comparison is not JSON");
    }
    return JSON.stringify(
      compactComparison(raw, repo, String(base), String(head), lines),
    );
  }
}
