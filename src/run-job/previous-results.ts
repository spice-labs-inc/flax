/** The token the lookup reads artifacts with: the workflow's own, with actions: read. */
export const PREVIOUS_TOKEN_ENV = "GH_TOKEN";

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const API = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._/-]*)?$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The workflow run that left the newest unexpired artifact of this name,
 * other than the current run: the previous run of a check job in the same
 * environment and mode, which uploads its results under that name on every
 * path. Undefined when there is none yet. Only artifact names and run ids
 * are read; GitHub lists artifacts newest first.
 */
export async function previousResultsRun(o: {
  repo: string;
  artifact: string;
  currentRunId?: string;
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}): Promise<number | undefined> {
  const api = o.apiUrl ?? "https://api.github.com";
  if (!REPO.test(o.repo)) throw new Error(`"${o.repo}" is not owner/name`);
  if (!API.test(api)) throw new Error(`"${api}" is not a GitHub API address`);
  const url = `${api}/repos/${o.repo}/actions/artifacts?name=${encodeURIComponent(o.artifact)}&per_page=20`;
  const res = await (o.fetch ?? fetch)(url, {
    headers: {
      authorization: `Bearer ${o.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(
      `listing the ${o.artifact} artifacts returned HTTP ${res.status}`,
    );
  }
  const body: unknown = await res.json();
  if (!isObject(body) || !Array.isArray(body.artifacts))
    throw new Error(`listing the ${o.artifact} artifacts answered no list`);
  for (const a of body.artifacts) {
    if (!isObject(a) || a.name !== o.artifact || a.expired === true) continue;
    const run = isObject(a.workflow_run) ? a.workflow_run.id : undefined;
    if (typeof run !== "number" || !Number.isSafeInteger(run) || run <= 0)
      continue;
    if (String(run) === o.currentRunId) continue;
    return run;
  }
  return undefined;
}
