import type { CheckFields } from "../src/deliver/checks.ts";
import type {
  CommitRequest,
  OpenPull,
  PrWriter,
  RepoFile,
} from "../src/deliver/writer.ts";
import type { PullThread } from "../src/revise/thread.ts";

/** A check run as the fake keeps it: what it was made with, then every update. */
export interface FakeCheck extends CheckFields {
  id: number;
  repo: string;
  name: string;
  headSha: string;
  branch: string;
  updates: number;
}

export interface FakePull extends OpenPull {
  repo: string;
  base?: string;
  title?: string;
  body?: string;
  draft?: boolean;
  state: "open" | "closed";
  comments: string[];
  /** Who was asked to review: logins, and teams as team:<slug>. */
  reviewers?: string[];
}

/**
 * An in-memory stand-in for the writer: files at commits, branches,
 * commits and pull requests, and every call in order. It never talks to
 * GitHub.
 */
export class FakeWriter implements PrWriter {
  readonly files = new Map<string, RepoFile>();
  readonly branches = new Map<string, string>();
  readonly commits: { repo: string; sha: string; request: CommitRequest }[] =
    [];
  readonly pulls: FakePull[] = [];
  readonly deleted: string[] = [];
  /** Pull request threads by repo#number, as readPullThread returns them. */
  readonly threads = new Map<string, PullThread>();
  readonly calls: string[] = [];
  /** Logins, or team:<slug>, that GitHub refuses as reviewers (as a 422). */
  readonly refuseReviewers = new Set<string>();
  readonly checks: FakeCheck[] = [];
  /** Set to make every check call fail, as GitHub does without the Checks permission. */
  refuseChecks?: string;
  private nextCheck = 9000;
  /** Review comment ids whose thread replies GitHub refuses. */
  readonly refuseThreads = new Set<number>();
  /** Thread replies made, in order. */
  readonly threadReplies: {
    repo: string;
    number: number;
    commentId: number;
    body: string;
  }[] = [];
  private next = 100;

  /** Puts a file at a commit, as the repository has it. */
  put(
    repo: string,
    commit: string,
    path: string,
    text: string,
    mode = "100644",
  ) {
    this.files.set(`${repo}@${commit}:${path}`, { text, mode });
  }

  /** Adds a pull request that is already open. */
  open(pull: Partial<FakePull> & { repo: string; branch: string }): FakePull {
    const p: FakePull = {
      number: this.next++,
      url: `https://github.com/${pull.repo}/pull/${this.next - 1}`,
      sameRepo: true,
      byBot: true,
      state: "open",
      comments: [],
      ...pull,
    };
    this.pulls.push(p);
    return p;
  }

  defaultBranch(repo: string): Promise<string> {
    this.calls.push(`defaultBranch ${repo}`);
    return Promise.resolve("main");
  }

  readFile(repo: string, commit: string, path: string) {
    this.calls.push(`readFile ${repo} ${commit.slice(0, 7)} ${path}`);
    return Promise.resolve(this.files.get(`${repo}@${commit}:${path}`));
  }

  commitFiles(repo: string, request: CommitRequest): Promise<string> {
    this.calls.push(`commitFiles ${repo} ${request.branch}`);
    if (
      request.fastForwardFrom !== undefined &&
      this.branches.get(`${repo}:${request.branch}`) !== request.fastForwardFrom
    )
      return Promise.reject(
        new Error(
          `${request.branch} is no longer at ${request.fastForwardFrom.slice(0, 12)}`,
        ),
      );
    const sha = String(this.commits.length + 1).padStart(40, "e");
    this.commits.push({ repo, sha, request });
    this.branches.set(`${repo}:${request.branch}`, sha);
    return Promise.resolve(sha);
  }

  openPulls(repo: string): Promise<OpenPull[]> {
    this.calls.push(`openPulls ${repo}`);
    return Promise.resolve(
      this.pulls
        .filter((p) => p.repo === repo && p.state === "open")
        .map(({ number, url, branch, sameRepo, byBot }) => ({
          number,
          url,
          branch,
          sameRepo,
          byBot,
        })),
    );
  }

  openPull(
    repo: string,
    pull: {
      branch: string;
      base: string;
      title: string;
      body: string;
      draft?: boolean;
    },
  ): Promise<{ number: number; url: string }> {
    this.calls.push(
      `openPull ${repo} ${pull.branch}${pull.draft === true ? " draft" : ""}`,
    );
    const p = this.open({ repo, ...pull, draft: pull.draft === true });
    return Promise.resolve({ number: p.number, url: p.url });
  }

  updatePull(
    repo: string,
    number: number,
    pull: { title: string; body: string },
  ): Promise<void> {
    this.calls.push(`updatePull ${repo} #${number}`);
    Object.assign(this.find(repo, number), pull);
    return Promise.resolve();
  }

  closePull(repo: string, number: number, comment: string): Promise<void> {
    this.calls.push(`closePull ${repo} #${number}`);
    const p = this.find(repo, number);
    p.comments.push(comment);
    p.state = "closed";
    return Promise.resolve();
  }

  readPullThread(repo: string, number: number): Promise<PullThread> {
    this.calls.push(`readPullThread ${repo} #${number}`);
    const thread = this.threads.get(`${repo}#${number}`);
    if (thread === undefined)
      return Promise.reject(new Error(`no pull request ${repo}#${number}`));
    return Promise.resolve(structuredClone(thread));
  }

  comment(repo: string, number: number, body: string): Promise<void> {
    this.calls.push(`comment ${repo} #${number}`);
    this.pulls
      .find((x) => x.repo === repo && x.number === number)
      ?.comments.push(body);
    this.threads.get(`${repo}#${number}`)?.comments.push({
      id: 900 + (this.threads.get(`${repo}#${number}`)?.comments.length ?? 0),
      author: "agents-writer[bot]",
      association: "NONE",
      byBot: true,
      body,
      url: "",
      createdAt: "2099-01-01T00:00:00Z",
    });
    return Promise.resolve();
  }

  replyToReviewComment(
    repo: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<void> {
    this.calls.push(`replyToReviewComment ${repo} #${number} ${commentId}`);
    if (this.refuseThreads.has(commentId))
      return Promise.reject(
        new Error(
          `POST /repos/${repo}/pulls/${number}/comments/${commentId}/replies returned 404`,
        ),
      );
    this.threadReplies.push({ repo, number, commentId, body });
    return Promise.resolve();
  }

  requestReviewers(
    repo: string,
    number: number,
    who: { reviewers?: readonly string[]; teamReviewers?: readonly string[] },
  ): Promise<void> {
    const names = [
      ...(who.reviewers ?? []),
      ...(who.teamReviewers ?? []).map((t) => `team:${t}`),
    ];
    this.calls.push(`requestReviewers ${repo} #${number} ${names.join(",")}`);
    const refused = names.find((n) => this.refuseReviewers.has(n));
    if (refused !== undefined)
      return Promise.reject(
        new Error(
          `POST /repos/${repo}/pulls/${number}/requested_reviewers returned 422`,
        ),
      );
    const p = this.find(repo, number);
    p.reviewers = [...(p.reviewers ?? []), ...names];
    return Promise.resolve();
  }

  createCheck(
    repo: string,
    check: CheckFields & { name: string; branch: string; headSha: string },
  ): Promise<number> {
    this.calls.push(
      `createCheck ${repo} ${check.headSha.slice(0, 7)} ${check.status}`,
    );
    if (this.refuseChecks !== undefined)
      return Promise.reject(new Error(this.refuseChecks));
    const id = this.nextCheck++;
    this.checks.push({ ...check, id, repo, updates: 0 });
    return Promise.resolve(id);
  }

  updateCheck(repo: string, id: number, fields: CheckFields): Promise<void> {
    this.calls.push(`updateCheck ${repo} ${id} ${fields.status}`);
    if (this.refuseChecks !== undefined)
      return Promise.reject(new Error(this.refuseChecks));
    const c = this.checks.find((x) => x.repo === repo && x.id === id);
    if (c === undefined) return Promise.reject(new Error(`no check run ${id}`));
    const { conclusion: _old, ...rest } = c;
    Object.assign(c, { ...rest, ...fields, updates: c.updates + 1 });
    if (fields.conclusion === undefined) delete c.conclusion;
    return Promise.resolve();
  }

  findChecks(
    repo: string,
    headSha: string,
    name: string,
  ): Promise<{ id: number; status: string }[]> {
    this.calls.push(`findChecks ${repo} ${headSha.slice(0, 7)}`);
    if (this.refuseChecks !== undefined)
      return Promise.reject(new Error(this.refuseChecks));
    return Promise.resolve(
      this.checks
        .filter(
          (c) => c.repo === repo && c.headSha === headSha && c.name === name,
        )
        .reverse()
        .map((c) => ({ id: c.id, status: c.status })),
    );
  }

  deleteBranch(repo: string, branch: string): Promise<void> {
    this.calls.push(`deleteBranch ${repo} ${branch}`);
    this.deleted.push(`${repo}:${branch}`);
    return Promise.resolve();
  }

  /** Set to make every merge fail, as GitHub does on a conflict or a protected branch. */
  refuseMerge?: string;
  /** Merges made, in order. */
  readonly merges: { repo: string; number: number; head: string }[] = [];

  mergePull(
    repo: string,
    number: number,
    head: string,
  ): Promise<{ sha: string }> {
    this.calls.push(`mergePull ${repo} #${number}`);
    if (this.refuseMerge !== undefined)
      return Promise.reject(new Error(this.refuseMerge));
    this.find(repo, number).state = "closed";
    this.merges.push({ repo, number, head });
    return Promise.resolve({ sha: "f".repeat(40) });
  }

  private find(repo: string, number: number): FakePull {
    const p = this.pulls.find((x) => x.repo === repo && x.number === number);
    if (p === undefined) throw new Error(`no pull request #${number}`);
    return p;
  }
}

// Built at runtime so no token-shaped literal sits in the source.
export const WRITER_TOKEN = ["ghs", "writertokenforthetests"].join("_");

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  auth: string;
}

/**
 * A stand-in for the GitHub REST API behind fetch, enough for the writer:
 * git commits, trees, blobs and refs, pulls and issue comments, and the
 * app installation token. It records every request.
 */
export function fakeGithubFetch(
  state: {
    /** commit sha to tree sha */
    commits?: Record<string, string>;
    /** tree sha to entries */
    trees?: Record<
      string,
      { path: string; type: string; sha: string; mode: string }[]
    >;
    /** blob sha to text */
    blobs?: Record<string, string>;
    /** existing branches, by name */
    refs?: Record<string, string>;
    pulls?: unknown[];
    /** What the token endpoint grants; the asked permissions when not given. */
    granted?: { permissions?: Record<string, string>; repositories?: string[] };
    /** Permissions the installation has not accepted: a token asking for one is refused with 422. */
    lacking?: string[];
    /** Check runs on any commit, as the check-runs list returns them. */
    checkRuns?: { id: number; status: string }[];
    /** What GET of one pull request returns. */
    pull?: unknown;
  } = {},
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const json = (value: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const path = `${url.pathname}${url.search}`;
    requests.push({ method, path, body, auth });
    let m: RegExpExecArray | null;
    if (
      method === "GET" &&
      url.pathname === "/orgs/notes-co/installation"
    )
      return json({ id: 7 });
    if (
      method === "POST" &&
      url.pathname === "/app/installations/7/access_tokens" &&
      (state.lacking ?? []).some((p) => p in (body.permissions ?? {}))
    )
      return json(
        { message: "The permissions requested are not granted" },
        422,
      );
    if (
      method === "POST" &&
      url.pathname === "/app/installations/7/access_tokens"
    )
      return json(
        {
          token: WRITER_TOKEN,
          expires_at: "2026-09-30T23:00:00Z",
          permissions: state.granted?.permissions ?? body.permissions,
          repositories: (
            state.granted?.repositories ??
            body.repositories ??
            []
          ).map((name: string) => ({ name })),
        },
        201,
      );
    if (method === "DELETE" && url.pathname === "/installation/token")
      return Promise.resolve(new Response(null, { status: 204 }));
    const repo = "/repos/notes-co/atlas";
    if (method === "GET" && url.pathname === repo)
      return json({ default_branch: "main" });
    if (
      (m = /\/git\/commits\/([0-9a-f]{40})$/.exec(url.pathname)) &&
      method === "GET"
    ) {
      const tree = state.commits?.[m[1]!];
      return tree === undefined ? json({}, 404) : json({ tree: { sha: tree } });
    }
    if (
      (m = /\/git\/trees\/([0-9a-f]{40})$/.exec(url.pathname)) &&
      method === "GET"
    )
      return json({ tree: state.trees?.[m[1]!] ?? [] });
    if (
      (m = /\/git\/blobs\/([0-9a-f]{40})$/.exec(url.pathname)) &&
      method === "GET"
    ) {
      const text = state.blobs?.[m[1]!];
      return text === undefined
        ? json({}, 404)
        : json({
            encoding: "base64",
            content: Buffer.from(text).toString("base64"),
          });
    }
    if (method === "POST" && url.pathname === `${repo}/git/blobs`)
      return json({ sha: "4".repeat(40) }, 201);
    if (method === "POST" && url.pathname === `${repo}/git/trees`)
      return json({ sha: "1".repeat(40) }, 201);
    if (method === "POST" && url.pathname === `${repo}/git/commits`)
      return json({ sha: "2".repeat(40) }, 201);
    if (
      (m = /\/git\/ref\/heads\/(.+)$/.exec(url.pathname)) &&
      method === "GET"
    ) {
      const sha = state.refs?.[decodeURIComponent(m[1]!)];
      return sha === undefined ? json({}, 404) : json({ object: { sha } });
    }
    if (method === "POST" && url.pathname === `${repo}/git/refs`)
      return json({ ref: body.ref }, 201);
    if (
      /\/git\/refs\/heads\//.test(url.pathname) &&
      (method === "PATCH" || method === "DELETE")
    )
      return method === "DELETE"
        ? Promise.resolve(new Response(null, { status: 204 }))
        : json({});
    if (method === "GET" && url.pathname === `${repo}/pulls`)
      return json(
        url.searchParams.get("page") === "1" ? (state.pulls ?? []) : [],
      );
    if (method === "POST" && url.pathname === `${repo}/pulls`)
      return json(
        {
          number: 42,
          html_url: "https://github.com/notes-co/atlas/pull/42",
        },
        201,
      );
    if (/\/pulls\/\d+$/.test(url.pathname) && method === "GET")
      return state.pull === undefined ? json({}, 404) : json(state.pull);
    if (/\/pulls\/\d+\/merge$/.test(url.pathname) && method === "PUT")
      return json({ sha: "9".repeat(40), merged: true });
    if (/\/pulls\/\d+$/.test(url.pathname) && method === "PATCH")
      return json({});
    if (/\/issues\/\d+\/comments$/.test(url.pathname) && method === "POST")
      return json({}, 201);
    if (
      /\/pulls\/\d+\/requested_reviewers$/.test(url.pathname) &&
      method === "POST"
    )
      return json({}, 201);
    if (method === "POST" && url.pathname === `${repo}/check-runs`)
      return json({ id: 77 }, 201);
    if (/\/check-runs\/\d+$/.test(url.pathname) && method === "PATCH")
      return json({});
    if (
      /\/commits\/[0-9a-f]{40}\/check-runs$/.test(url.pathname) &&
      method === "GET"
    )
      return json({ check_runs: state.checkRuns ?? [] });
    return json({ message: "not in the fake" }, 404);
  };
  return { fetch: fn as typeof fetch, requests };
}
