import { workspace, workspaceRoot } from "../lib/workspace.ts";
import { loadRepo, validJobs } from "../lib/repo.ts";
import {
  createInstallationToken,
  GITHUB_API,
  githubOrg,
  type InstallationToken,
} from "../tools-server/github.ts";
import { checkName, writeCheck } from "../deliver/checks.ts";
import {
  GithubWriter,
  WRITER_APP_ID_ENV,
  WRITER_PRIVATE_KEY_ENV,
} from "../deliver/github-writer.ts";
import { QUEUE_CHECK_PERMISSIONS, queuedCheck } from "./check.ts";
import {
  POLL_PERMISSIONS,
  pollRevisions,
  revisableJobs,
  type QueuedRevision,
  type WorkflowRun,
} from "./poll.ts";

/** Queues the ${workspace().displayName} check of a started revision with a writer app token for that repository only. */
async function queueCheck(
  appId: string,
  privateKey: string,
  q: QueuedRevision,
): Promise<void> {
  const token = await createInstallationToken({
    appId,
    privateKey,
    permissions: QUEUE_CHECK_PERMISSIONS,
    repositories: [q.repo.split("/")[1]!],
    appIdEnv: WRITER_APP_ID_ENV,
  });
  try {
    const record = await writeCheck(
      new GithubWriter({ token: token.token }),
      { repo: q.repo, job: q.job, branch: q.branch, head: q.headSha },
      queuedCheck(q.login, q.requests),
    );
    if (record.refused !== undefined)
      throw new Error(`${checkName(q.job)}: ${record.refused}`);
  } finally {
    await token.revoke().catch(() => undefined);
  }
}

/** The repository whose job workflows revision runs start in. */
const AGENTS_REPO = workspace().repo;

const READER_APP_ID_ENV = "AGENTS_READER_APP_ID";
const READER_PRIVATE_KEY_ENV = "AGENTS_READER_PRIVATE_KEY";
/** The workflow's own token, with actions: write, for listing runs and dispatching. */
const ACTIONS_TOKEN_ENV = "GH_TOKEN";

function client(token: string) {
  return async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const res = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `token ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      // The body can echo request details; the status is enough to act on.
      await res.body?.cancel();
      throw new Error(`${method} ${path.split("?")[0]} returned ${res.status}`);
    }
    return res.status === 204 ? undefined : res.json();
  };
}

const workflowPath = (job: string) =>
  `/repos/${AGENTS_REPO}/actions/workflows/job-${job}.yml`;

function asRuns(value: unknown): WorkflowRun[] {
  const list =
    typeof value === "object" && value !== null
      ? (value as { workflow_runs?: unknown }).workflow_runs
      : undefined;
  if (!Array.isArray(list)) throw new Error("GitHub returned no list of runs");
  return list
    .filter(
      (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
    )
    .map((r) => ({
      status: typeof r.status === "string" ? r.status : "",
      conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
      title: typeof r.display_title === "string" ? r.display_title : "",
      createdAt: typeof r.created_at === "string" ? r.created_at : "",
    }));
}

async function main(): Promise<number> {
  const repo = loadRepo(workspaceRoot());
  const jobs = revisableJobs(validJobs(repo).map((j) => j.config));
  if (jobs.length === 0) {
    console.log("No live pull request job; nothing to poll.");
    return 0;
  }
  const appId = process.env[READER_APP_ID_ENV]?.trim() ?? "";
  const privateKey = process.env[READER_PRIVATE_KEY_ENV] ?? "";
  const actionsToken = process.env[ACTIONS_TOKEN_ENV] ?? "";
  if (appId === "" || privateKey === "" || actionsToken === "") {
    console.error(
      `${READER_APP_ID_ENV}, ${READER_PRIVATE_KEY_ENV} and ${ACTIONS_TOKEN_ENV} must be set`,
    );
    return 1;
  }
  let reader: InstallationToken;
  try {
    reader = await createInstallationToken({
      appId,
      privateKey,
      permissions: POLL_PERMISSIONS,
    });
  } catch (err) {
    console.error(
      `could not make the reader app's token: ${(err as Error).message}`,
    );
    return 1;
  }
  try {
    const read = client(reader.token);
    const actions = client(actionsToken);
    const writerAppId = process.env[WRITER_APP_ID_ENV]?.trim() ?? "";
    const writerKey = process.env[WRITER_PRIVATE_KEY_ENV] ?? "";
    if (writerAppId === "" || writerKey === "")
      console.log(
        `${WRITER_APP_ID_ENV} and ${WRITER_PRIVATE_KEY_ENV} are not set, so no ${workspace().displayName} check is queued`,
      );
    const outcome = await pollRevisions({
      jobs,
      get: (path) => read("GET", path),
      runs: async (job) =>
        asRuns(await actions("GET", `${workflowPath(job)}/runs?per_page=100`)),
      dispatch: async (job, target) => {
        await actions("POST", `${workflowPath(job)}/dispatches`, {
          ref: "main",
          inputs: { revise: target },
        });
      },
      ...(writerAppId === "" || writerKey === ""
        ? {}
        : { queueCheck: (q) => queueCheck(writerAppId, writerKey, q) }),
    });
    for (const line of outcome.lines) console.log(line);
    if (outcome.reads === 0 && outcome.readFailures > 0) {
      console.error("Nothing could be read.");
      return 1;
    }
    if (outcome.dispatchFailures > 0) {
      console.error("A revision run that was needed was not started.");
      return 1;
    }
    return 0;
  } finally {
    await reader.revoke().catch((err: unknown) => {
      console.error(
        `could not revoke the reader app's token: ${(err as Error).message}`,
      );
    });
  }
}

process.exit(await main());
