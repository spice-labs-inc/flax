import { createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  delayFor,
  isTransient,
  RETRY_DELAYS_MS,
  retryAfterMs,
} from "../deliver/github-retry.ts";
import { readCapped } from "./artifacts.ts";
import {
  DEFAULT_GREP_MATCHES,
  grepTarball,
  matchLine,
  SearchStopped,
  type GrepSummary,
} from "./code-grep.ts";
import {
  DEFAULT_BLAME_LINES,
  DEFAULT_PATH_COMMITS,
  DEFAULT_TREE_PATHS,
  GITHUB_API,
  githubOrg,
} from "./github.ts";

/** The one host GitHub sends tarball downloads to. */
export const TARBALL_HOSTS: readonly string[] = ["codeload.github.com"];

/** The biggest tarball a run downloads. */
export const MAX_TARBALL_BYTES = 300 * 1024 * 1024;

/** How long one tarball download may take, whichever call started it. */
export const TARBALL_MS = 5 * 60 * 1000;

/** The most tarballs one run keeps on disk; the oldest goes first. */
export const MAX_CACHED_TARBALLS = 8;

/** The biggest API answer read: a recursive tree or a blame of a long file. */
export const MAX_API_BYTES = 32 * 1024 * 1024;

/** What one commit_tree or commit_blame result may take, below its tool's result cap. */
export const TREE_RESULT_BYTES = 120_000;
export const BLAME_RESULT_BYTES = 100_000;

const HEADLINE_CHARS = 300;
const BLAME_LINE_CHARS = 240;

export interface CodeReaderOptions {
  /** The run's read-only installation token. */
  token: string;
  /** Where tarballs are kept for the run: in the upstreams' work directory, removed when the run ends. */
  cacheDir: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  /** The hosts a tarball download may be sent to; TARBALL_HOSTS when not given. */
  tarballHosts?: readonly string[];
  /** Takes plain http downloads; only tests set it. */
  allowHttp?: boolean;
  sleep?: (ms: number) => Promise<void>;
  retryDelays?: readonly number[];
}

/** A GitHub read that failed: the status, or undefined when no answer came. */
class ReadError extends Error {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(message: string, status?: number, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfter;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function onlyKeys(
  operation: string,
  args: Record<string, unknown>,
  keys: readonly string[],
): void {
  const extra = Object.keys(args).filter((k) => !keys.includes(k));
  if (extra.length > 0)
    throw new Error(`${operation} takes no ${extra.join(", ")}`);
}

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : fallback;
}

/** The pull request a commit belongs to: the merged one, else the first GitHub links it to. */
function pullRequestOf(commit: Record<string, unknown>): number | undefined {
  const prs = list(record(commit.associatedPullRequests).nodes).map(record);
  const pr = prs.find((p) => p.state === "MERGED") ?? prs[0];
  return typeof pr?.number === "number" ? pr.number : undefined;
}

function headline(commit: Record<string, unknown>): string {
  return typeof commit.messageHeadline === "string"
    ? commit.messageHeadline.slice(0, HEADLINE_CHARS)
    : "";
}

const PATH_HISTORY_QUERY = `query($owner: String!, $name: String!, $ref: String!, $path: String!, $count: Int!) {
  repository(owner: $owner, name: $name) {
    object(expression: $ref) {
      ... on Commit {
        history(first: $count, path: $path) {
          pageInfo { hasNextPage }
          nodes {
            oid
            committedDate
            messageHeadline
            author { user { login } }
            associatedPullRequests(first: 5) { nodes { number state } }
          }
        }
      }
    }
  }
}`;

const BLAME_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!, $path: String!, $file: String!) {
  repository(owner: $owner, name: $name) {
    file: object(expression: $file) {
      ... on Blob { text isBinary isTruncated }
    }
    commit: object(oid: $oid) {
      ... on Commit {
        blame(path: $path) {
          ranges {
            startingLine
            endingLine
            commit {
              oid
              committedDate
              messageHeadline
              associatedPullRequests(first: 5) { nodes { number state } }
            }
          }
        }
      }
    }
  }
}`;

export interface PathCommit {
  sha: string;
  date: string;
  author?: string;
  headline: string;
  pr?: number;
}

export interface BlameCommit {
  date: string;
  headline: string;
  pr?: number;
}

/**
 * Reads code of notes-co repositories at a commit with the run's
 * read-only token, for commit_grep (a tarball of the commit, searched on
 * the runner), path_history and commit_blame (one fixed GraphQL query
 * each) and commit_tree (one recursive tree GET). Answers GitHub fails
 * with a 5xx, or asks to wait for briefly, are tried again with backoff.
 */
export class CodeReader {
  private readonly options: CodeReaderOptions;
  private readonly api: string;
  private readonly tarballs = new Map<string, Promise<string>>();

  constructor(options: CodeReaderOptions) {
    this.options = options;
    this.api = options.apiUrl ?? GITHUB_API;
  }

  private fetch(url: string | URL, init: RequestInit): Promise<Response> {
    return (this.options.fetch ?? fetch)(url, init);
  }

  /** One read, tried again on a transient failure while the call may still run. */
  private async retrying<T>(
    signal: AbortSignal,
    attempt: () => Promise<T>,
  ): Promise<T> {
    const delays = this.options.retryDelays ?? RETRY_DELAYS_MS;
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let i = 0; ; i++) {
      try {
        return await attempt();
      } catch (err) {
        if (
          signal.aborted ||
          i >= delays.length ||
          !(err instanceof ReadError) ||
          !isTransient(err.status, err.retryAfterMs)
        )
          throw err;
        await sleep(delayFor(i, err.retryAfterMs, delays));
        if (signal.aborted) throw err;
      }
    }
  }

  private async send(
    what: string,
    url: string | URL,
    init: RequestInit,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetch(url, init);
    } catch (err) {
      if (init.signal?.aborted === true) throw err;
      throw new ReadError(
        `${what} got no answer: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status >= 400) {
      // The body can echo request details; the status is enough to act on.
      await res.body?.cancel();
      throw new ReadError(
        `${what} returned ${res.status}`,
        res.status,
        retryAfterMs(res.headers.get("retry-after")),
      );
    }
    return res;
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.options.token}`,
      "x-github-api-version": "2022-11-28",
    };
  }

  private async getJson(
    what: string,
    path: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.retrying(signal, async () => {
      const res = await this.send(what, `${this.api}${path}`, {
        headers: this.headers(),
        redirect: "error",
        signal,
      });
      const bytes = await readCapped(res, MAX_API_BYTES);
      try {
        return JSON.parse(bytes.toString("utf8")) as unknown;
      } catch {
        throw new Error(`${what}: the answer is not JSON`);
      }
    });
  }

  private async graphql(
    what: string,
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const body = await this.retrying(signal, async () => {
      const res = await this.send(what, `${this.api}/graphql`, {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        redirect: "error",
        signal,
      });
      const bytes = await readCapped(res, MAX_API_BYTES);
      try {
        return record(JSON.parse(bytes.toString("utf8")));
      } catch {
        throw new Error(`${what}: the answer is not JSON`);
      }
    });
    const errors = list(body.errors).map(record);
    if (errors.length > 0) {
      const first = errors[0]!;
      const kind = typeof first.type === "string" ? `${first.type}: ` : "";
      const message =
        typeof first.message === "string" ? first.message.slice(0, 300) : "";
      throw new Error(`${what}: GitHub answered ${kind}${message}`);
    }
    return record(body.data);
  }

  // ---- commit_grep ----

  /** The tarball of one commit on disk, downloaded once per run. */
  private tarball(
    owner: string,
    repo: string,
    sha: string,
    signal: AbortSignal,
  ): Promise<string> {
    const key = `${owner}/${repo}@${sha}`;
    let pending = this.tarballs.get(key);
    if (pending === undefined) {
      pending = this.download(owner, repo, sha);
      this.tarballs.set(key, pending);
      const started = pending;
      started.catch(() => {
        if (this.tarballs.get(key) === started) this.tarballs.delete(key);
      });
      this.evict();
    }
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => reject(new Error("the call was stopped"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (file) => {
          signal.removeEventListener("abort", onAbort);
          resolve(file);
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  private forget(owner: string, repo: string, sha: string): void {
    const key = `${owner}/${repo}@${sha}`;
    const pending = this.tarballs.get(key);
    if (pending === undefined) return;
    this.tarballs.delete(key);
    void pending.then(
      (file) => rmSync(file, { force: true }),
      () => undefined,
    );
  }

  private evict(): void {
    while (this.tarballs.size > MAX_CACHED_TARBALLS) {
      const [key, oldest] = this.tarballs.entries().next().value!;
      this.tarballs.delete(key);
      void oldest.then(
        (file) => rmSync(file, { force: true }),
        () => undefined,
      );
    }
  }

  private async download(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<string> {
    // Its own time limit, not the call's: a download a call gave up on still
    // serves the next call for the same commit.
    const signal = AbortSignal.timeout(TARBALL_MS);
    mkdirSync(this.options.cacheDir, { recursive: true, mode: 0o700 });
    const file = join(this.options.cacheDir, `${repo}-${sha}.tar.gz`);
    const part = `${file}.part`;
    const what = "downloading the commit's tarball";
    await this.retrying(signal, async () => {
      let url = new URL(
        `${this.api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${sha}`,
      );
      let res: Response | undefined;
      // A renamed repository redirects within the API first.
      for (let hop = 0; hop < 3 && res === undefined; hop++) {
        const answer = await this.send(what, url, {
          headers: this.headers(),
          redirect: "manual",
          signal,
        });
        const location = answer.headers.get("location");
        if (answer.status < 300 || answer.status > 399) {
          res = answer;
          break;
        }
        await answer.body?.cancel();
        if (location === null)
          throw new Error(`${what} returned ${answer.status}`);
        const next = new URL(location, url);
        if (
          next.origin === new URL(this.api).origin &&
          /^\/(repos|repositories)\//.test(next.pathname)
        ) {
          url = next;
          continue;
        }
        const hosts = this.options.tarballHosts ?? TARBALL_HOSTS;
        if (
          !(
            next.protocol === "https:" ||
            (this.options.allowHttp === true && next.protocol === "http:")
          ) ||
          !hosts.includes(next.hostname)
        )
          throw new Error(
            `GitHub sent the tarball to ${next.protocol}//${next.hostname}, which is not ${hosts.join(" or ")}`,
          );
        res = await this.send(what, next, { redirect: "error", signal });
      }
      if (res === undefined) throw new Error(`${what} redirected too often`);
      if (res.body === null) throw new Error(`${what} returned no body`);
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) {
        await res.body.cancel();
        throw new Error(
          `the tarball is ${declared} bytes, over the ${MAX_TARBALL_BYTES} byte limit`,
        );
      }
      let size = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length;
          if (size > MAX_TARBALL_BYTES)
            done(
              new Error(
                `the tarball is over the ${MAX_TARBALL_BYTES} byte limit`,
              ),
            );
          else done(null, chunk);
        },
      });
      try {
        await pipeline(
          Readable.fromWeb(
            res.body as import("node:stream/web").ReadableStream,
          ),
          cap,
          createWriteStream(part, { mode: 0o600 }),
        );
      } catch (err) {
        rmSync(part, { force: true });
        if (err instanceof Error && /byte limit/.test(err.message)) throw err;
        throw new ReadError(
          `${what} broke off: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    renameSync(part, file);
    return file;
  }

  async grep(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    onlyKeys("commit_grep", args, [
      "owner",
      "repo",
      "sha",
      "pattern",
      "fixed_string",
      "ignore_case",
      "path_glob",
      "max_matches",
    ]);
    const repo = String(args.repo);
    const sha = String(args.sha);
    const file = await this.tarball(String(args.owner), repo, sha, signal);
    let summary: GrepSummary;
    try {
      summary = await grepTarball(file, {
        pattern: String(args.pattern),
        fixedString: args.fixed_string === true,
        ignoreCase: args.ignore_case === true,
        glob: typeof args.path_glob === "string" ? args.path_glob : undefined,
        maxMatches: integer(args.max_matches, DEFAULT_GREP_MATCHES),
        signal,
      });
    } catch (err) {
      // A download that broke off short reads as a broken archive; the next call fetches it again.
      if (!(err instanceof SearchStopped))
        this.forget(String(args.owner), repo, sha);
      throw err;
    }
    return grepText(repo, sha, args, summary);
  }

  // ---- path_history ----

  async pathHistory(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    onlyKeys("path_history", args, ["owner", "repo", "path", "ref", "count"]);
    const repo = String(args.repo);
    const path = String(args.path);
    const ref = String(args.ref);
    const count = integer(args.count, DEFAULT_PATH_COMMITS);
    const data = await this.graphql(
      "reading the path's history",
      PATH_HISTORY_QUERY,
      {
        owner: String(args.owner),
        name: repo,
        ref: /^[0-9a-f]{40}$/.test(ref) ? ref : `refs/heads/${ref}`,
        path,
        count,
      },
      signal,
    );
    const repository = data.repository;
    if (repository === null || repository === undefined)
      throw new Error(`${githubOrg()}/${repo} was not found`);
    const object = record(repository).object;
    if (object === null || object === undefined)
      throw new Error(`${ref} was not found in ${githubOrg()}/${repo}`);
    const history = record(record(object).history);
    const commits = list(history.nodes)
      .map(record)
      .map((c): PathCommit => {
        const login = record(record(c.author).user).login;
        const pr = pullRequestOf(c);
        return {
          sha: String(c.oid ?? ""),
          date: String(c.committedDate ?? ""),
          ...(typeof login === "string" ? { author: login } : {}),
          headline: headline(c),
          ...(pr === undefined ? {} : { pr }),
        };
      });
    return JSON.stringify({
      repo,
      ref,
      path,
      commits,
      more: record(history.pageInfo).hasNextPage === true,
    });
  }

  // ---- commit_blame ----

  async blame(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    onlyKeys("commit_blame", args, [
      "owner",
      "repo",
      "sha",
      "path",
      "start_line",
      "line_count",
    ]);
    const repo = String(args.repo);
    const sha = String(args.sha);
    const path = String(args.path);
    const start = integer(args.start_line, 1);
    const count = integer(args.line_count, DEFAULT_BLAME_LINES);
    const end = start + count - 1;
    const data = await this.graphql(
      "reading the file's blame",
      BLAME_QUERY,
      {
        owner: String(args.owner),
        name: repo,
        oid: sha,
        path,
        file: `${sha}:${path}`,
      },
      signal,
    );
    const repository = data.repository;
    if (repository === null || repository === undefined)
      throw new Error(`${githubOrg()}/${repo} was not found`);
    const commit = record(repository).commit;
    if (commit === null || commit === undefined)
      throw new Error(`commit ${sha} was not found in ${githubOrg()}/${repo}`);
    const fileObject = record(repository).file;
    if (fileObject === null || fileObject === undefined)
      throw new Error(`${path} is not a file at ${sha}`);
    const blob = record(fileObject);
    if (blob.isBinary === true) throw new Error(`${path} is a binary file`);
    const lines =
      typeof blob.text === "string" ? blob.text.split("\n") : undefined;
    const ranges = list(record(record(commit).blame).ranges).map(record);
    const total = ranges.reduce(
      (max, r) => Math.max(max, integer(r.endingLine, 0)),
      0,
    );
    const commits: Record<string, BlameCommit> = {};
    const blame: { line: number; commit: string; text?: string }[] = [];
    for (const r of ranges) {
      const from = Math.max(start, integer(r.startingLine, 0));
      const to = Math.min(end, integer(r.endingLine, 0));
      if (from > to) continue;
      const c = record(r.commit);
      const oid = String(c.oid ?? "");
      if (!(oid in commits)) {
        const pr = pullRequestOf(c);
        commits[oid] = {
          date: String(c.committedDate ?? ""),
          headline: headline(c),
          ...(pr === undefined ? {} : { pr }),
        };
      }
      for (let line = from; line <= to; line++) {
        const text = lines?.[line - 1]?.replace(/\r$/, "");
        blame.push({
          line,
          commit: oid,
          ...(text === undefined
            ? {}
            : {
                text:
                  text.length > BLAME_LINE_CHARS
                    ? `${text.slice(0, BLAME_LINE_CHARS)}...`
                    : text,
              }),
        });
      }
    }
    blame.sort((a, b) => a.line - b.line);
    const out = {
      repo,
      sha,
      path,
      lines:
        blame.length === 0
          ? `none of ${total}`
          : `${blame[0]!.line}-${blame.at(-1)!.line} of ${total}`,
      ...(blob.isTruncated === true ? { text_cut: true } : {}),
      commits,
      blame,
    };
    while (
      Buffer.byteLength(JSON.stringify(out)) > BLAME_RESULT_BYTES &&
      out.blame.length > 0
    )
      out.blame = out.blame.slice(0, Math.floor(out.blame.length * 0.9));
    return JSON.stringify(out);
  }

  // ---- commit_tree ----

  async tree(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    onlyKeys("commit_tree", args, [
      "owner",
      "repo",
      "sha",
      "prefix",
      "max_paths",
    ]);
    const repo = String(args.repo);
    const sha = String(args.sha);
    const prefix =
      typeof args.prefix === "string" ? args.prefix.replace(/\/+$/, "") : "";
    const max = integer(args.max_paths, DEFAULT_TREE_PATHS);
    const body = record(
      await this.getJson(
        "reading the commit's tree",
        `/repos/${encodeURIComponent(String(args.owner))}/${encodeURIComponent(repo)}/git/trees/${sha}?recursive=1`,
        signal,
      ),
    );
    const entries = list(body.tree)
      .map(record)
      .filter(
        (e) =>
          (e.type === "blob" || e.type === "commit") &&
          typeof e.path === "string" &&
          (prefix === "" ||
            e.path === prefix ||
            e.path.startsWith(`${prefix}/`)),
      );
    const lines: string[] = [];
    let bytes = 0;
    let stopped: "paths" | "bytes" | undefined;
    for (const e of entries) {
      if (lines.length >= max) {
        stopped = "paths";
        break;
      }
      const size =
        e.type === "commit" ? "submodule" : String(integer(e.size, 0));
      const line = `${size}\t${String(e.path)}`;
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > TREE_RESULT_BYTES) {
        stopped = "bytes";
        break;
      }
      lines.push(line);
    }
    const where = prefix === "" ? "" : ` under ${prefix}/`;
    const head = [
      `${githubOrg()}/${repo} at ${sha}${where}: ${entries.length} files`,
      stopped === "paths"
        ? `; the first ${lines.length} shown (max_paths)`
        : stopped === "bytes"
          ? `; the first ${lines.length} shown (the size limit; narrow with prefix)`
          : "",
      body.truncated === true
        ? "; GitHub cut the tree short, so some files are missing: list a prefix"
        : "",
      ". Each line: size in bytes, a tab, the path.",
    ].join("");
    return [head, ...lines].join("\n");
  }
}

export function grepText(
  repo: string,
  sha: string,
  args: Record<string, unknown>,
  summary: GrepSummary,
): string {
  const glob =
    typeof args.path_glob === "string" ? ` in paths ${args.path_glob}` : "";
  const skipped = [
    summary.binary_skipped > 0 ? `${summary.binary_skipped} binary` : "",
    summary.large_skipped > 0 ? `${summary.large_skipped} over 1 MiB` : "",
  ].filter((s) => s !== "");
  const head = [
    `${githubOrg()}/${repo} at ${sha}${glob}: ${summary.matches.length} matching lines in ${summary.files_matched} files`,
    ` (${summary.files_searched} text files searched${skipped.length > 0 ? `; skipped ${skipped.join(" and ")}` : ""})`,
    summary.stopped === "matches"
      ? "; stopped at max_matches, there may be more"
      : summary.stopped === "bytes"
        ? "; stopped at the size limit, there may be more"
        : "",
    ". Each line: path:line:text.",
  ].join("");
  return [head, ...summary.matches.map(matchLine)].join("\n");
}
