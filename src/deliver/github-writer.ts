import { readPullThread, type PullThread } from "../revise/thread.ts";
import {
  delayFor,
  GithubCallError,
  isTransient,
  RETRY_DELAYS_MS,
  retryAfterMs,
  safeToRepeat,
  sleepMs,
} from "./github-retry.ts";
import type { CheckFields } from "./checks.ts";
import {
  createInstallationToken,
  GITHUB_API,
  githubOrg,
} from "../tools-server/github.ts";
import {
  isWritableAgentBranch,
  type CommitRequest,
  type OpenPull,
  type PrWriter,
  type RepoFile,
} from "./writer.ts";

/** The GitHub App that opens agent pull requests, by the repository secrets that hold it. */
export const WRITER_APP_ID_ENV = "AGENTS_WRITER_APP_ID";
export const WRITER_PRIVATE_KEY_ENV = "AGENTS_WRITER_PRIVATE_KEY";
export const WRITER_SECRET_ENV = [
  WRITER_APP_ID_ENV,
  WRITER_PRIVATE_KEY_ENV,
] as const;

/**
 * What a delivery token asks for, and all it may get: write the contents of
 * a branch, pull requests and check runs, read metadata, and read
 * organization members (GitHub refuses an app's team review request
 * without it). Never workflows, never administration, never actions.
 */
export const WRITE_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
  checks: "write",
  contents: "write",
  members: "read",
  metadata: "read",
  pull_requests: "write",
};

/**
 * What delivery needs at the least. When the installation has not accepted
 * the newer permissions (checks, members) yet, GitHub refuses a token that
 * asks for them; delivery then asks for these and goes on without check
 * runs and team review requests.
 */
export const BASE_WRITE_PERMISSIONS: Readonly<
  Record<string, "read" | "write">
> = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
};

const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_OPEN_PULL_PAGES = 5;
const SHA = /^[0-9a-f]{40}$/;
const MODE = /^100(644|755)$/;

export interface GithubWriterOptions {
  token: string;
  /** The token may write check runs; false when the installation lacks the permission. */
  checks?: boolean;
  apiUrl?: string;
  fetch?: typeof fetch;
  /** Waits between retries; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  retryDelays?: readonly number[];
}

function repoPath(repo: string): string {
  const [owner, name, ...rest] = repo.split("/");
  if (owner !== githubOrg() || name === undefined || rest.length > 0)
    throw new Error(`${repo} is not a ${githubOrg()} repository`);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function refPath(branch: string): string {
  if (!isWritableAgentBranch(branch))
    throw new Error(
      `${branch} is not an agent branch; delivery writes agent/<job>/<day> and agent/<job>/<key> branches only`,
    );
  return branch.split("/").map(encodeURIComponent).join("/");
}

/** A check run's state and output as GitHub's REST API takes it. */
function checkBody(fields: CheckFields): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    status: fields.status,
    ...(fields.status === "completed"
      ? { conclusion: fields.conclusion ?? "neutral", completed_at: now }
      : {}),
    ...(fields.status === "in_progress" ? { started_at: now } : {}),
    ...(fields.detailsUrl === undefined
      ? {}
      : { details_url: fields.detailsUrl }),
    output: { title: fields.title, summary: fields.summary },
  };
}

async function reviewRefusalReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    return typeof body.message === "string"
      ? body.message.replace(/\s+/g, " ").slice(0, 200)
      : "";
  } catch {
    return "";
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The GitHub REST side of delivery, with an installation token of the
 * writer app. It writes only agent branches and pull requests; it has
 * no call that merges, approves, or writes any other ref.
 */
export class GithubWriter implements PrWriter {
  private readonly token: string;
  private readonly api: string;
  private readonly fetchFn: typeof fetch;
  private readonly checks: boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelays: readonly number[];

  constructor(options: GithubWriterOptions) {
    this.token = options.token;
    this.checks = options.checks ?? true;
    this.api = options.apiUrl ?? GITHUB_API;
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? sleepMs;
    this.retryDelays = options.retryDelays ?? RETRY_DELAYS_MS;
  }

  /**
   * One call, tried again with backoff on a transient answer when repeating it
   * is safe (safeToRepeat); any other failure throws a GithubCallError.
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    allow404 = false,
  ): Promise<unknown> {
    const repeat = safeToRepeat(method, path);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(method, path, body, allow404);
      } catch (err) {
        if (
          !repeat ||
          attempt >= this.retryDelays.length ||
          !(err instanceof GithubCallError) ||
          !isTransient(err.status, err.retryAfterMs)
        )
          throw err;
        await this.sleep(delayFor(attempt, err.retryAfterMs, this.retryDelays));
      }
    }
  }

  /** Repeats a call that is not safe to repeat only after `settled` finds it did not take effect. */
  private async withRecheck<T>(
    call: () => Promise<T>,
    settled: () => Promise<T | undefined>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (err) {
        if (
          attempt >= this.retryDelays.length ||
          !(err instanceof GithubCallError) ||
          !isTransient(err.status, err.retryAfterMs)
        )
          throw err;
        await this.sleep(delayFor(attempt, err.retryAfterMs, this.retryDelays));
        const done = await settled();
        if (done !== undefined) return done;
      }
    }
  }

  private async requestOnce(
    method: string,
    path: string,
    body: unknown,
    allow404: boolean,
  ): Promise<unknown> {
    const what = `${method} ${path.split("?")[0]}`;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.api}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `token ${this.token}`,
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new GithubCallError(
        `${what} got no answer: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
      );
    }
    if (allow404 && res.status === 404) {
      await res.body?.cancel();
      return undefined;
    }
    if (!res.ok) {
      // The body can echo request details, so only a refused review
      // request keeps GitHub's short reason: it names who could not be asked.
      const reason =
        res.status === 422 && path.endsWith("/requested_reviewers")
          ? await reviewRefusalReason(res)
          : (await res.body?.cancel(), "");
      throw new GithubCallError(
        `${what} returned ${res.status}${reason ? `: ${reason}` : ""}`,
        res.status,
        retryAfterMs(res.headers.get("retry-after")),
      );
    }
    return res.status === 204 ? undefined : res.json();
  }

  async defaultBranch(repo: string): Promise<string> {
    const info = await this.request("GET", repoPath(repo));
    const branch = isObject(info) ? info.default_branch : undefined;
    if (typeof branch !== "string" || branch === "")
      throw new Error(`${repo} names no default branch`);
    return branch;
  }

  private async treeOf(repo: string, commit: string): Promise<string> {
    const got = await this.request(
      "GET",
      `${repoPath(repo)}/git/commits/${commit}`,
    );
    const tree = isObject(got) && isObject(got.tree) ? got.tree.sha : undefined;
    if (typeof tree !== "string" || !SHA.test(tree))
      throw new Error(`commit ${commit} of ${repo} has no tree`);
    return tree;
  }

  async readFile(
    repo: string,
    commit: string,
    path: string,
  ): Promise<RepoFile | undefined> {
    if (!SHA.test(commit))
      throw new Error(`"${commit}" is not a full commit id`);
    let tree = await this.treeOf(repo, commit);
    const parts = path.split("/");
    for (const [i, part] of parts.entries()) {
      const got = await this.request(
        "GET",
        `${repoPath(repo)}/git/trees/${tree}`,
      );
      const entries = isObject(got) && Array.isArray(got.tree) ? got.tree : [];
      const entry = entries.find(
        (e): e is Record<string, unknown> => isObject(e) && e.path === part,
      );
      if (entry === undefined || typeof entry.sha !== "string")
        return undefined;
      if (i < parts.length - 1) {
        if (entry.type !== "tree") return undefined;
        tree = entry.sha;
        continue;
      }
      if (entry.type !== "blob" || typeof entry.mode !== "string")
        return undefined;
      if (!MODE.test(entry.mode))
        throw new Error(
          `${path} has mode ${entry.mode}; only regular files are written`,
        );
      const blob = await this.request(
        "GET",
        `${repoPath(repo)}/git/blobs/${entry.sha}`,
      );
      if (
        !isObject(blob) ||
        blob.encoding !== "base64" ||
        typeof blob.content !== "string"
      )
        throw new Error(`the blob of ${path} is not base64 content`);
      const bytes = Buffer.from(blob.content, "base64");
      if (bytes.length > MAX_BLOB_BYTES)
        throw new Error(
          `${path} is ${bytes.length} bytes, over the ${MAX_BLOB_BYTES} byte limit`,
        );
      return { text: bytes.toString("utf8"), mode: entry.mode };
    }
    return undefined;
  }

  async commitFiles(repo: string, request: CommitRequest): Promise<string> {
    const ref = refPath(request.branch);
    if (!SHA.test(request.base))
      throw new Error(`"${request.base}" is not a full commit id`);
    const base = repoPath(repo);
    const baseTree = await this.treeOf(repo, request.base);
    const entries = [];
    for (const f of request.files) {
      if (!MODE.test(f.mode))
        throw new Error(`${f.path}: mode ${f.mode} is not a regular file`);
      if ("text" in f) {
        entries.push({
          path: f.path,
          mode: f.mode,
          type: "blob",
          content: f.text,
        });
        continue;
      }
      // Bytes go up as a blob of their own: a tree entry's content is text only.
      const blob = await this.request("POST", `${base}/git/blobs`, {
        content: f.bytes.toString("base64"),
        encoding: "base64",
      });
      const blobSha = isObject(blob) ? blob.sha : undefined;
      if (typeof blobSha !== "string" || !SHA.test(blobSha))
        throw new Error(`GitHub made no blob for ${f.path}`);
      entries.push({ path: f.path, mode: f.mode, type: "blob", sha: blobSha });
    }
    const tree = await this.request("POST", `${base}/git/trees`, {
      base_tree: baseTree,
      tree: entries,
    });
    const treeSha = isObject(tree) ? tree.sha : undefined;
    if (typeof treeSha !== "string") throw new Error("GitHub made no tree");
    const who = { ...request.author, date: request.date.toISOString() };
    const commit = await this.request("POST", `${base}/git/commits`, {
      message: request.message,
      tree: treeSha,
      parents: [request.base],
      author: who,
      committer: who,
    });
    const sha = isObject(commit) ? commit.sha : undefined;
    if (typeof sha !== "string" || !SHA.test(sha))
      throw new Error("GitHub made no commit");
    const existing = await this.request(
      "GET",
      `${base}/git/ref/heads/${ref}`,
      undefined,
      true,
    );
    if (request.fastForwardFrom !== undefined) {
      const object = isObject(existing) ? existing.object : undefined;
      const at = isObject(object) ? object.sha : undefined;
      if (at !== request.fastForwardFrom)
        throw new Error(
          `${request.branch} is no longer at ${request.fastForwardFrom.slice(0, 12)} (someone pushed to it), so the revision was not written`,
        );
      await this.request("PATCH", `${base}/git/refs/heads/${ref}`, {
        sha,
        force: false,
      });
      return sha;
    }
    if (existing === undefined)
      // Creating a ref is not safe to repeat: try again only when it is still missing.
      await this.withRecheck(
        () =>
          this.request("POST", `${base}/git/refs`, {
            ref: `refs/heads/${request.branch}`,
            sha,
          }),
        async () => {
          const now = await this.request(
            "GET",
            `${base}/git/ref/heads/${ref}`,
            undefined,
            true,
          );
          const object = isObject(now) ? now.object : undefined;
          if (isObject(object) && object.sha === sha) return now;
          if (now !== undefined)
            throw new Error(
              `${request.branch} appeared at another commit while it was being created`,
            );
          return undefined;
        },
      );
    else
      await this.request("PATCH", `${base}/git/refs/heads/${ref}`, {
        sha,
        force: true,
      });
    return sha;
  }

  async openPulls(repo: string): Promise<OpenPull[]> {
    const out: OpenPull[] = [];
    for (let page = 1; page <= MAX_OPEN_PULL_PAGES; page++) {
      const got = await this.request(
        "GET",
        `${repoPath(repo)}/pulls?state=open&per_page=100&page=${page}`,
      );
      const pulls = Array.isArray(got) ? got.filter(isObject) : [];
      for (const p of pulls) {
        const head = isObject(p.head) ? p.head : {};
        const headRepo = isObject(head.repo) ? head.repo : {};
        const user = isObject(p.user) ? p.user : {};
        if (typeof p.number !== "number" || typeof head.ref !== "string")
          continue;
        out.push({
          number: p.number,
          url: typeof p.html_url === "string" ? p.html_url : "",
          branch: head.ref,
          sameRepo: headRepo.full_name === repo,
          byBot: user.type === "Bot",
        });
      }
      if (pulls.length < 100) break;
    }
    return out;
  }

  async openPull(
    repo: string,
    pull: {
      branch: string;
      base: string;
      title: string;
      body: string;
      draft?: boolean;
    },
  ): Promise<{ number: number; url: string }> {
    refPath(pull.branch);
    // Opening a pull request is not safe to repeat: try again only when none is open for the branch.
    const got = await this.withRecheck<unknown>(
      () =>
        this.request("POST", `${repoPath(repo)}/pulls`, {
          title: pull.title,
          head: pull.branch,
          base: pull.base,
          body: pull.body,
          draft: pull.draft === true,
          maintainer_can_modify: false,
        }),
      async () => {
        const open = (await this.openPulls(repo)).find(
          (p) => p.sameRepo && p.branch === pull.branch,
        );
        return open === undefined
          ? undefined
          : { number: open.number, html_url: open.url };
      },
    );
    if (!isObject(got) || typeof got.number !== "number")
      throw new Error("GitHub opened no pull request");
    return {
      number: got.number,
      url: typeof got.html_url === "string" ? got.html_url : "",
    };
  }

  async updatePull(
    repo: string,
    number: number,
    pull: { title: string; body: string },
  ): Promise<void> {
    await this.request("PATCH", `${repoPath(repo)}/pulls/${number}`, {
      title: pull.title,
      body: pull.body,
    });
  }

  async closePull(repo: string, number: number, comment: string) {
    await this.request("POST", `${repoPath(repo)}/issues/${number}/comments`, {
      body: comment,
    });
    await this.request("PATCH", `${repoPath(repo)}/pulls/${number}`, {
      state: "closed",
    });
  }

  readPullThread(repo: string, number: number): Promise<PullThread> {
    repoPath(repo);
    return readPullThread((path) => this.request("GET", path), repo, number);
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    await this.request("POST", `${repoPath(repo)}/issues/${number}/comments`, {
      body,
    });
  }

  async replyToReviewComment(
    repo: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<void> {
    if (!Number.isSafeInteger(commentId) || commentId <= 0)
      throw new Error(`${commentId} is not a review comment id`);
    await this.request(
      "POST",
      `${repoPath(repo)}/pulls/${number}/comments/${commentId}/replies`,
      { body },
    );
  }

  async requestReviewers(
    repo: string,
    number: number,
    who: { reviewers?: readonly string[]; teamReviewers?: readonly string[] },
  ): Promise<void> {
    await this.request(
      "POST",
      `${repoPath(repo)}/pulls/${number}/requested_reviewers`,
      {
        reviewers: who.reviewers ?? [],
        team_reviewers: who.teamReviewers ?? [],
      },
    );
  }

  private noChecks(): never {
    throw new Error(
      "the writer app has no Checks permission on this installation yet",
    );
  }

  async createCheck(
    repo: string,
    check: CheckFields & { name: string; branch: string; headSha: string },
  ): Promise<number> {
    if (!this.checks) this.noChecks();
    const ref = refPath(check.branch);
    if (!SHA.test(check.headSha))
      throw new Error(`${check.headSha} is not a commit sha`);
    // Only the head of one of the job's own branches gets a check run.
    const head = await this.request(
      "GET",
      `${repoPath(repo)}/git/ref/heads/${ref}`,
    );
    const at =
      isObject(head) && isObject(head.object) ? head.object.sha : undefined;
    if (at !== check.headSha)
      throw new Error(
        `${check.branch} is not at ${check.headSha.slice(0, 12)}, so no check run was written`,
      );
    const got = await this.request("POST", `${repoPath(repo)}/check-runs`, {
      name: check.name,
      head_sha: check.headSha,
      ...checkBody(check),
    });
    if (!isObject(got) || typeof got.id !== "number")
      throw new Error("GitHub made no check run");
    return got.id;
  }

  async updateCheck(
    repo: string,
    id: number,
    fields: CheckFields,
  ): Promise<void> {
    if (!this.checks) this.noChecks();
    if (!Number.isInteger(id) || id <= 0)
      throw new Error(`${id} is not a check run id`);
    await this.request(
      "PATCH",
      `${repoPath(repo)}/check-runs/${id}`,
      checkBody(fields),
    );
  }

  async findChecks(
    repo: string,
    headSha: string,
    name: string,
  ): Promise<{ id: number; status: string }[]> {
    if (!this.checks) this.noChecks();
    if (!SHA.test(headSha)) throw new Error(`${headSha} is not a commit sha`);
    const got = await this.request(
      "GET",
      `${repoPath(repo)}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=20`,
    );
    const runs =
      isObject(got) && Array.isArray(got.check_runs) ? got.check_runs : [];
    return runs
      .filter(isObject)
      .filter((r) => typeof r.id === "number" && typeof r.status === "string")
      .map((r) => ({ id: r.id as number, status: r.status as string }));
  }

  /**
   * Squash-merges a pull request only when it is open, comes from an agent
   * branch in the same repository and still has head `head`: with no branch
   * protection on the target repositories, these checks are what keeps a
   * merge to agent pull requests (delivery decides when, from auto_merge).
   */
  async mergePull(
    repo: string,
    number: number,
    head: string,
  ): Promise<{ sha: string }> {
    if (!SHA.test(head)) throw new Error(`${head} is not a commit sha`);
    const pull = await this.request("GET", `${repoPath(repo)}/pulls/${number}`);
    if (!isObject(pull)) throw new Error(`${repo}#${number} could not be read`);
    const h = isObject(pull.head) ? pull.head : {};
    const branch = typeof h.ref === "string" ? h.ref : "";
    const fromRepo =
      isObject(h.repo) && typeof h.repo.full_name === "string"
        ? h.repo.full_name
        : "";
    if (pull.state !== "open") throw new Error(`${repo}#${number} is not open`);
    if (!isWritableAgentBranch(branch) || fromRepo !== repo)
      throw new Error(
        `${repo}#${number} is not from an agent branch of ${repo}, so it is not merged`,
      );
    if (h.sha !== head)
      throw new Error(
        `${repo}#${number} moved past ${head.slice(0, 12)}, so it is not merged`,
      );
    try {
      const got = await this.request(
        "PUT",
        `${repoPath(repo)}/pulls/${number}/merge`,
        { merge_method: "squash", sha: head },
      );
      return {
        sha: isObject(got) && typeof got.sha === "string" ? got.sha : "",
      };
    } catch (err) {
      // A merge that went through before a lost answer reads as merged.
      const after = await this.request(
        "GET",
        `${repoPath(repo)}/pulls/${number}`,
      );
      if (
        isObject(after) &&
        after.merged === true &&
        typeof after.merge_commit_sha === "string"
      )
        return { sha: after.merge_commit_sha };
      throw err;
    }
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    await this.request(
      "DELETE",
      `${repoPath(repo)}/git/refs/heads/${refPath(branch)}`,
      undefined,
      true,
    );
  }
}

export interface OpenedWriter {
  writer: PrWriter;
  /** Permissions the installation has not accepted yet, so the token goes without them (checks, members). */
  missing?: string[];
  /** Values to scrub from every report file: the installation token. */
  secrets: string[];
  /** Revokes the token; called when delivery ends, on every path. */
  close(): Promise<void>;
}

/**
 * Makes an installation token of the writer app for these repositories
 * only, with WRITE_PERMISSIONS only, and a writer that uses it. A token
 * granted anything more, or any other repository, is revoked and refused.
 */
export async function openGithubWriter(
  env: NodeJS.ProcessEnv,
  repos: readonly string[],
  options: { apiUrl?: string; fetch?: typeof fetch; now?: Date } = {},
): Promise<OpenedWriter> {
  const appId = env[WRITER_APP_ID_ENV] ?? "";
  const privateKey = env[WRITER_PRIVATE_KEY_ENV] ?? "";
  if (appId === "" || privateKey === "")
    throw new Error(
      `${WRITER_SECRET_ENV.join(" and ")} must be set to open pull requests`,
    );
  const names = repos.map((r) => {
    repoPath(r);
    return r.split("/")[1]!;
  });
  const make = (permissions: Readonly<Record<string, "read" | "write">>) =>
    createInstallationToken({
      appId,
      privateKey,
      permissions,
      repositories: names,
      appIdEnv: WRITER_APP_ID_ENV,
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  let token: Awaited<ReturnType<typeof make>>;
  let missing: string[] = [];
  try {
    token = await make(WRITE_PERMISSIONS);
  } catch (err) {
    // GitHub answers 422 when the installation lacks a permission the token asks for.
    if (!/access_tokens returned 422/.test((err as Error).message)) throw err;
    token = await make(BASE_WRITE_PERMISSIONS);
    missing = Object.keys(WRITE_PERMISSIONS).filter(
      (p) => !(p in BASE_WRITE_PERMISSIONS),
    );
  }
  return {
    writer: new GithubWriter({
      token: token.token,
      checks: !missing.includes("checks"),
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    secrets: [token.token],
    ...(missing.length === 0 ? {} : { missing }),
    close: () => token.revoke(),
  };
}
