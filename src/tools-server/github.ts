import { createPrivateKey, sign } from "node:crypto";
import { UPSTREAM_OPERATIONS } from "../lib/tools.ts";
import {
  grepPatternProblem,
  MAX_GREP_GLOB,
  MAX_GREP_MATCHES,
  MAX_GREP_PATTERN,
} from "./code-grep.ts";
import type { CallGuard } from "./mcp-upstream.ts";
import { workspace } from "../lib/workspace.ts";

/** The organization whose repositories GitHub tools read. */
export function githubOrg(): string {
  return workspace().github;
}

export const GITHUB_API = "https://api.github.com";

export const GITHUB_OPERATIONS = UPSTREAM_OPERATIONS.github!;

/** Served by the tools server itself with the run's token, not by github-mcp-server. */
export const NATIVE_GITHUB_OPERATIONS = [
  "maintainer_notes_list",
  "compare_commits",
  "run_report_read",
  "commit_grep",
  "path_history",
  "commit_blame",
  "commit_tree",
] as const;

/** The operations github-mcp-server is started with and must offer. */
export const GITHUB_MCP_OPERATIONS = GITHUB_OPERATIONS.filter(
  (op) => !(NATIVE_GITHUB_OPERATIONS as readonly string[]).includes(op),
);

/** The one repository whose runs keep maintainer notes and run reports. */
export function notesRepo(): string {
  return workspace().repo.slice(workspace().repo.indexOf("/") + 1);
}

/** What every run's installation token may do: read, and nothing else. */
export const READ_PERMISSIONS: Readonly<Record<string, "read">> = {
  actions: "read",
  contents: "read",
  metadata: "read",
  pull_requests: "read",
};

/** The read permission an operation needs beyond READ_PERMISSIONS, asked for only by runs whose tools call it. */
export const OPERATION_PERMISSIONS: Readonly<Record<string, string>> = {
  projects_list: "organization_projects",
  list_issues: "issues",
  issue_read: "issues",
};

/** The permissions a run's token asks for: READ_PERMISSIONS plus what the given operations need, all read. */
export function readPermissions(
  operations: readonly string[],
): Readonly<Record<string, "read">> {
  const out: Record<string, "read"> = { ...READ_PERMISSIONS };
  for (const op of operations) {
    const extra = OPERATION_PERMISSIONS[op];
    if (extra !== undefined) out[extra] = "read";
  }
  return out;
}

export const WORKFLOW_METHODS: readonly string[] = [
  "list_workflow_runs",
  "list_workflow_jobs",
];

export const PULL_REQUEST_METHODS: readonly string[] = [
  "get",
  "get_diff",
  "get_status",
  "get_files",
  "get_commits",
  "get_review_comments",
  "get_reviews",
  "get_comments",
  "get_check_runs",
];

/** The one pull request search tools may run: open pull requests in the organization. */
export function openPrQuery(): string {
  return `org:${githubOrg()} is:pr is:open`;
}
function openPrSearch(): RegExp {
  return new RegExp(`^${openPrQuery()}( author:[A-Za-z0-9-]{1,39})?$`);
}

/** The other search tools may run: pull requests of the organization merged since a day. */
function mergedPrPrefix(): string {
  return `org:${githubOrg()} is:pr is:merged merged:>=`;
}
function mergedPrSearch(): RegExp {
  return new RegExp(`^${mergedPrPrefix()}\\d{4}-\\d{2}-\\d{2}$`);
}

/** How many days back the merged pull request search may reach. */
export const MAX_MERGED_DAYS = 31;

export function mergedPrQuery(day: string): string {
  return `${mergedPrPrefix()}${day}`;
}

/** The Engineering Board, the one organization project tools may read. */
export function boardNumber(): number | undefined {
  return workspace().board?.number;
}

/** The Engineering Board's Status values. */
export function boardStatuses(): readonly string[] {
  return workspace().board?.statuses ?? [];
}

/** Board items are read with their Status field only. */
export const BOARD_FIELD_NAMES: readonly string[] = ["Status"];

export const MAX_BOARD_PER_PAGE = 50;

/** How many days back the board and product epic reads may reach. */
export const MAX_ACTIVITY_DAYS = 31;

const DAY = "\\d{4}-\\d{2}-\\d{2}";
function boardSearch(): RegExp {
  const statuses = boardStatuses();
  const list = `"(?:${statuses.join("|")})"(?:,"(?:${statuses.join("|")})"){0,${Math.max(statuses.length - 1, 0)}}`;
  return new RegExp(`^(?:updated:>=${DAY}(?: status:${list})?|status:${list})$`);
}

/** The board filter: items whose board entry changed since a day, items in the given statuses, or both. */
export function boardQuery(
  since: string | undefined,
  statuses: readonly string[] | undefined,
): string {
  const parts: string[] = [];
  if (since !== undefined) parts.push(`updated:>=${since}`);
  if (statuses !== undefined && statuses.length > 0)
    parts.push(`status:${statuses.map((s) => `"${s}"`).join(",")}`);
  return parts.join(" ");
}

/** The one repository whose issues are the product epics. */
export function epicsRepo(): string | undefined {
  return workspace().epicsRepo;
}

/** The fields a product epic list returns: no body, author or assignees. */
export const EPIC_FIELDS: readonly string[] = [
  "number",
  "title",
  "state",
  "labels",
  "created_at",
  "updated_at",
];

export const MAX_EPICS_PER_PAGE = 100;

const EPIC_SINCE = new RegExp(`^${DAY}T00:00:00Z$`);

function sameList(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((v, i) => v === expected[i])
  );
}

function perPageWithin(value: unknown, max: number): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max;
}

/** The branch get_file_contents may read. */
export const MAIN_REF = "refs/heads/main";

/** The other refs get_file_contents may read: release tags vX.Y.Z. */
const RELEASE_TAG_REF = /^refs\/tags\/v\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/** The ref of a release tag vX.Y.Z; any other tag is refused. */
export function releaseTagRef(tag: string): string {
  const ref = `refs/tags/${tag}`;
  if (!RELEASE_TAG_REF.test(ref))
    throw new Error(`"${tag}" is not a release tag vX.Y.Z`);
  return ref;
}

/** The most commits one list_commits call may return, always from main. */
export const MAX_COMMITS = 50;

/** A commit get_file_contents may read at: its full sha, never a short one. */
export const FULL_SHA = /^[0-9a-f]{40}$/;

/** compare_commits compares two commits by sha only, never by branch or tag. */
export const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

/** The most diff lines per file compare_commits returns. */
export const MAX_PATCH_LINES = 400;

/** The most commits path_history returns, and how many when not asked. */
export const MAX_PATH_COMMITS = 50;
export const DEFAULT_PATH_COMMITS = 20;

/** The most lines commit_blame returns, and how many when not asked. */
export const MAX_BLAME_LINES = 200;
export const DEFAULT_BLAME_LINES = 100;

/** The most paths commit_tree returns, and how many when not asked. */
export const MAX_TREE_PATHS = 5000;
export const DEFAULT_TREE_PATHS = 1000;

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** A path from the repository root with no empty, . or .. part. */
export function isPlainPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 400 &&
    !path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  );
}

/**
 * Why a branch name is refused, or undefined when it may be read: the
 * characters git allows in a plain branch name, with none of the forms
 * that name something else (a range, a reflog entry, a parent).
 */
export function branchProblem(name: string): string | undefined {
  if (
    !/^[A-Za-z0-9._/-]{1,200}$/.test(name) ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("//")
  )
    return `"${name}" is not a branch name`;
  return undefined;
}

function boundedInteger(
  operation: string,
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): void {
  const n = Number(args[key]);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${operation} ${key} must be ${min} to ${max}`);
}

/** The guard of the four code reads the tools server serves itself. */
function codeReadGuard(operation: string, args: Record<string, unknown>): void {
  if (typeof args.repo !== "string" || !REPO_NAME.test(args.repo))
    throw new Error(`"${String(args.repo)}" is not a repository name`);
  if (operation !== "path_history" && !FULL_SHA.test(String(args.sha)))
    throw new Error(`${operation} sha must be a full commit sha`);
  if (operation === "commit_grep") {
    if (typeof args.pattern !== "string")
      throw new Error("commit_grep needs a pattern");
    if (args.fixed_string !== true) {
      const problem = grepPatternProblem(
        args.pattern,
        args.ignore_case === true,
      );
      if (problem !== undefined) throw new Error(`commit_grep: ${problem}`);
    } else if (
      args.pattern.length === 0 ||
      args.pattern.length > MAX_GREP_PATTERN
    )
      throw new Error(
        `commit_grep pattern must be 1 to ${MAX_GREP_PATTERN} characters`,
      );
    if (
      "path_glob" in args &&
      (typeof args.path_glob !== "string" ||
        !/^[A-Za-z0-9._/*?=+()@[\]-]+$/.test(args.path_glob) ||
        args.path_glob.length > MAX_GREP_GLOB)
    )
      throw new Error("commit_grep path_glob is not a path filter");
    boundedInteger(operation, args, "max_matches", 1, MAX_GREP_MATCHES);
  }
  if (operation === "path_history") {
    const ref = String(args.ref);
    if (!FULL_SHA.test(ref)) {
      const problem = branchProblem(ref);
      if (problem !== undefined) throw new Error(`path_history: ${problem}`);
    }
    if (!isPlainPath(args.path))
      throw new Error("path_history path must be a plain relative path");
    boundedInteger(operation, args, "count", 1, MAX_PATH_COMMITS);
  }
  if (operation === "commit_blame") {
    if (!isPlainPath(args.path))
      throw new Error("commit_blame path must be a plain relative path");
    boundedInteger(operation, args, "start_line", 1, 1_000_000);
    boundedInteger(operation, args, "line_count", 1, MAX_BLAME_LINES);
  }
  if (operation === "commit_tree") {
    if (
      "prefix" in args &&
      !isPlainPath(String(args.prefix).replace(/\/+$/, ""))
    )
      throw new Error("commit_tree prefix must be a plain relative path");
    boundedInteger(operation, args, "max_paths", 1, MAX_TREE_PATHS);
  }
}

/** The code reads the tools server serves itself with the run's token. */
export const CODE_OPERATIONS: readonly string[] = [
  "commit_grep",
  "path_history",
  "commit_blame",
  "commit_tree",
];

/** github-mcp-server's command line: read-only tools of three toolsets, and lockdown mode. */
export function githubArgs(): string[] {
  return [
    "stdio",
    "--read-only",
    "--toolsets",
    "repos,pull_requests,actions",
    "--tools",
    GITHUB_MCP_OPERATIONS.join(","),
    "--lockdown-mode",
  ];
}

/**
 * The last line of defense before github-mcp-server: repositories of the
 * organization only, the listed read methods only, and job logs only as
 * content. Without return_content, get_job_logs returns a signed download
 * URL that works as a credential until it expires.
 */
export const githubGuard: CallGuard = (operation, args) => {
  if (args.owner !== githubOrg())
    throw new Error(`only ${githubOrg()} repositories may be read`);
  if (
    operation === "actions_list" &&
    !WORKFLOW_METHODS.includes(String(args.method))
  )
    throw new Error(
      `actions_list method "${String(args.method)}" is not allowed`,
    );
  if (
    operation === "pull_request_read" &&
    !PULL_REQUEST_METHODS.includes(String(args.method))
  )
    throw new Error(
      `pull_request_read method "${String(args.method)}" is not allowed`,
    );
  if (operation === "search_pull_requests") {
    if (
      typeof args.query !== "string" ||
      !(openPrSearch().test(args.query) || mergedPrSearch().test(args.query))
    )
      throw new Error(
        `search_pull_requests may only search "${openPrQuery()}", optionally with one author, or "${mergedPrPrefix()}<day>"`,
      );
    if ("repo" in args)
      throw new Error(
        "search_pull_requests searches the organization, not one repository",
      );
  }
  if (operation === "list_commits") {
    if (args.sha !== "main") throw new Error("list_commits reads main only");
    const perPage = Number(args.perPage);
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > MAX_COMMITS)
      throw new Error(`list_commits returns 1 to ${MAX_COMMITS} commits`);
    for (const key of ["author", "path", "since", "until"])
      if (key in args) throw new Error(`list_commits takes no ${key}`);
  }
  if (operation === "maintainer_notes_list" && args.repo !== notesRepo())
    throw new Error(`maintainer notes are read from ${notesRepo()} only`);
  if (operation === "run_report_read" && args.repo !== notesRepo())
    throw new Error(`run reports are read from ${notesRepo()} only`);
  if (operation === "compare_commits") {
    for (const key of ["base", "head"])
      if (typeof args[key] !== "string" || !COMMIT_SHA.test(args[key]))
        throw new Error(`compare_commits ${key} must be a commit sha`);
    const lines = Number(args.patch_lines);
    if (!Number.isInteger(lines) || lines < 0 || lines > MAX_PATCH_LINES)
      throw new Error(
        `compare_commits patch_lines must be 0 to ${MAX_PATCH_LINES}`,
      );
  }
  if (CODE_OPERATIONS.includes(operation)) codeReadGuard(operation, args);
  if (operation === "get_file_contents") {
    if ("sha" in args) {
      if (typeof args.sha !== "string" || !FULL_SHA.test(args.sha))
        throw new Error("get_file_contents sha must be a full commit sha");
      if ("ref" in args)
        throw new Error("get_file_contents takes a sha or a ref, not both");
    } else if (args.ref !== MAIN_REF && !RELEASE_TAG_REF.test(String(args.ref)))
      throw new Error(
        "get_file_contents reads main, a release tag vX.Y.Z or a commit by its full sha only",
      );
  }
  if (operation === "projects_list") {
    if (args.method !== "list_project_items")
      throw new Error(
        `projects_list method "${String(args.method)}" is not allowed`,
      );
    if (args.owner_type !== "org" || args.project_number !== boardNumber())
      throw new Error(
        `projects_list reads the ${githubOrg()} project ${boardNumber()} only`,
      );
    if (!sameList(args.field_names, BOARD_FIELD_NAMES))
      throw new Error("projects_list reads the Status field only");
    for (const key of ["fields", "before"])
      if (key in args) throw new Error(`projects_list takes no ${key}`);
    if (!perPageWithin(args.perPage, MAX_BOARD_PER_PAGE))
      throw new Error(
        `projects_list returns 1 to ${MAX_BOARD_PER_PAGE} items a page`,
      );
    if (typeof args.query !== "string" || !boardSearch().test(args.query))
      throw new Error(
        'projects_list may only filter by "updated:>=<day>", "status:<statuses>" or both',
      );
  }
  if (
    (operation === "list_issues" || operation === "issue_read") &&
    args.repo !== epicsRepo()
  )
    throw new Error(`issues are read from ${epicsRepo()} only`);
  if (operation === "list_issues") {
    if (!sameList(args.fields, EPIC_FIELDS))
      throw new Error(`list_issues returns only ${EPIC_FIELDS.join(", ")}`);
    for (const key of ["labels", "field_filters"])
      if (key in args) throw new Error(`list_issues takes no ${key}`);
    if (!perPageWithin(args.perPage, MAX_EPICS_PER_PAGE))
      throw new Error(
        `list_issues returns 1 to ${MAX_EPICS_PER_PAGE} issues a page`,
      );
    if ("since" in args && !EPIC_SINCE.test(String(args.since)))
      throw new Error("list_issues since must be the start of a UTC day");
  }
  if (operation === "issue_read" && args.method !== "get")
    throw new Error(
      `issue_read method "${String(args.method)}" is not allowed`,
    );
  if (operation === "get_job_logs") {
    if (args.return_content !== true)
      throw new Error("get_job_logs must return content, never a URL");
    if ("failed_only" in args || "run_id" in args)
      throw new Error("get_job_logs reads one job at a time");
  }
};

function base64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

/** A GitHub App JWT, valid for nine minutes, backdated a minute for clock skew. */
export function appJwt(appId: string, privateKey: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat, exp: iat + 600, iss: appId }),
  );
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    createPrivateKey(privateKey),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
  /** Revokes the token; the run calls it when it ends. */
  revoke(): Promise<void>;
}

export interface InstallationTokenOptions {
  appId: string;
  privateKey: string;
  /** What the token asks for; READ_PERMISSIONS when not given. */
  permissions?: Readonly<Record<string, "read" | "write">>;
  /** Repository names in the organization the token is limited to; every repository the installation has when not given. */
  repositories?: readonly string[];
  /** The variable that names the app, for the message when it is not installed. */
  appIdEnv?: string;
  org?: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: Date;
}

async function github(
  fetchFn: typeof fetch,
  url: string,
  auth: string,
  init: { method?: string; body?: unknown; appIdEnv?: string } = {},
): Promise<unknown> {
  const res = await fetchFn(url, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: auth,
      "x-github-api-version": "2022-11-28",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    // The body can echo request details; the status is enough to act on.
    await res.body?.cancel();
    const path = new URL(url).pathname;
    throw new Error(
      `${init.method ?? "GET"} ${path} returned ${res.status}${
        res.status === 404 && path.endsWith("/installation")
          ? ` (the GitHub App is not installed on the organization, or ${init.appIdEnv ?? "AGENTS_READER_APP_ID"} names another app)`
          : ""
      }`,
    );
  }
  return res.status === 204 ? undefined : res.json();
}

/**
 * Creates an installation token for the run from the GitHub App, narrowed
 * to the read permissions asked for (READ_PERMISSIONS unless the run's
 * tools need more). GitHub answers with the permissions the token got; a
 * token with any other permission is revoked and refused, so a wider
 * installation can never widen what the tools hold.
 */
export async function createInstallationToken(
  options: InstallationTokenOptions,
): Promise<InstallationToken> {
  const fetchFn = options.fetch ?? fetch;
  const api = options.apiUrl ?? GITHUB_API;
  const org = options.org ?? githubOrg();
  const permissions = options.permissions ?? READ_PERMISSIONS;
  const jwt = `Bearer ${appJwt(options.appId, options.privateKey, options.now ?? new Date())}`;
  const installation = (await github(
    fetchFn,
    `${api}/orgs/${encodeURIComponent(org)}/installation`,
    jwt,
    options.appIdEnv === undefined ? {} : { appIdEnv: options.appIdEnv },
  )) as { id?: unknown };
  if (typeof installation.id !== "number")
    throw new Error(`the ${org} installation has no id`);
  const created = (await github(
    fetchFn,
    `${api}/app/installations/${installation.id}/access_tokens`,
    jwt,
    {
      method: "POST",
      body: {
        ...(options.repositories === undefined
          ? {}
          : { repositories: [...options.repositories] }),
        permissions,
      },
    },
  )) as {
    token?: unknown;
    expires_at?: unknown;
    permissions?: unknown;
    repositories?: unknown;
  };
  if (typeof created.token !== "string" || created.token.length === 0)
    throw new Error("GitHub returned no installation token");
  const token = created.token;
  const revoke = async () => {
    await github(fetchFn, `${api}/installation/token`, `token ${token}`, {
      method: "DELETE",
    });
  };
  const granted =
    typeof created.permissions === "object" && created.permissions !== null
      ? (created.permissions as Record<string, unknown>)
      : {};
  const extra = Object.entries(granted)
    .filter(([name, level]) => permissions[name] !== level)
    .map(([name, level]) => `${name}:${String(level)}`);
  if (extra.length > 0) {
    await revoke().catch(() => undefined);
    const asked = Object.values(permissions).includes("write")
      ? "the access"
      : "the read access";
    throw new Error(
      `the installation token was granted more than ${asked} it asked for (${extra.join(", ")}); it was revoked`,
    );
  }
  if (options.repositories !== undefined) {
    const wanted = new Set(options.repositories);
    const names = Array.isArray(created.repositories)
      ? created.repositories.map((r) =>
          typeof r === "object" && r !== null
            ? String((r as { name?: unknown }).name)
            : "?",
        )
      : ["(no list)"];
    const others = names.filter((n) => !wanted.has(n));
    if (others.length > 0) {
      await revoke().catch(() => undefined);
      throw new Error(
        `the installation token reaches repositories it did not ask for (${others.join(", ")}); it was revoked`,
      );
    }
  }
  return {
    token,
    expiresAt: typeof created.expires_at === "string" ? created.expires_at : "",
    revoke,
  };
}
