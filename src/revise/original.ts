import { workspace } from "../lib/workspace.ts";
import { reportArtifact } from "../generate/render.ts";
import { readCapped, readZipEntry } from "../tools-server/artifacts.ts";
import { GITHUB_API } from "../tools-server/github.ts";

/** The reader app, by the secrets that hold it; a revision reads the original run's artifact with it. */
export const READER_APP_ID_ENV = "AGENTS_READER_APP_ID";
export const READER_PRIVATE_KEY_ENV = "AGENTS_READER_PRIVATE_KEY";

/** Where every job run and its report artifact live. */
export function runsRepo(): string {
  return workspace().repo;
}
/** A report artifact holds transcripts too; only input.json is read from it. */
export const MAX_REPORT_ZIP_BYTES = 64 * 1024 * 1024;
export const MAX_ORIGINAL_INPUT_BYTES = 16 * 1024 * 1024;

function runLink(): RegExp {
  return new RegExp(`https:\/\/github\\.com\/${workspace().repo}\/actions\/runs\/(\\d+)`);
}

/** The workflow run a pull request body names, which made the pull request. */
export function originalRunId(body: string): number | undefined {
  const m = runLink().exec(body);
  return m === null ? undefined : Number(m[1]);
}

export interface OriginalInputOptions {
  /** A token that may read agents' actions: the reader app's. */
  token: string;
  job: string;
  runId: number;
  /** Hosts GitHub may send the download to (github-log-hosts.yml). */
  downloadHosts: readonly string[];
  apiUrl?: string;
  allowHttp?: boolean;
  fetch?: typeof fetch;
}

/**
 * The input.json of the run that opened a pull request, from that run's
 * job-<name>-report artifact: the pages, sources and rules a revision
 * keeps, so its evidence must point into the same sources. The download
 * goes only to a host in github-log-hosts.yml, over https, without the
 * token. Artifacts expire after 90 days; an expired one cannot be read.
 */
export async function readOriginalInput(
  o: OriginalInputOptions,
): Promise<unknown> {
  const fetchFn = o.fetch ?? fetch;
  const api = o.apiUrl ?? GITHUB_API;
  const signal = AbortSignal.timeout(120_000);
  const get = (path: string) =>
    fetchFn(`${api}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${o.token}`,
        "x-github-api-version": "2022-11-28",
      },
      redirect: "manual",
      signal,
    });
  const name = reportArtifact(o.job);
  const listed = await get(
    `/repos/${runsRepo()}/actions/runs/${o.runId}/artifacts?name=${encodeURIComponent(name)}`,
  );
  if (!listed.ok) {
    await listed.body?.cancel();
    throw new Error(
      `listing the artifacts of run ${o.runId} returned ${listed.status}`,
    );
  }
  const artifacts = ((await listed.json()) as { artifacts?: unknown })
    .artifacts;
  const artifact = (Array.isArray(artifacts) ? artifacts : []).find(
    (a): a is { id: number; expired?: boolean; size_in_bytes?: number } =>
      typeof a === "object" &&
      a !== null &&
      (a as { name?: unknown }).name === name &&
      typeof (a as { id?: unknown }).id === "number",
  );
  if (artifact === undefined)
    throw new Error(`run ${o.runId} has no ${name} artifact`);
  if (artifact.expired === true)
    throw new Error(
      `the ${name} artifact of run ${o.runId} has expired (artifacts are kept 90 days)`,
    );
  if ((artifact.size_in_bytes ?? 0) > MAX_REPORT_ZIP_BYTES)
    throw new Error(
      `the ${name} artifact of run ${o.runId} is over the ${MAX_REPORT_ZIP_BYTES} byte limit`,
    );
  const redirect = await get(
    `/repos/${runsRepo()}/actions/artifacts/${artifact.id}/zip`,
  );
  await redirect.body?.cancel();
  const location = redirect.headers.get("location");
  if (redirect.status < 300 || redirect.status > 399 || location === null)
    throw new Error(`downloading the artifact returned ${redirect.status}`);
  const url = new URL(location);
  if (
    !(
      url.protocol === "https:" ||
      (o.allowHttp === true && url.protocol === "http:")
    ) ||
    !o.downloadHosts.includes(url.hostname)
  )
    throw new Error(
      `GitHub sent the download to ${url.protocol}//${url.hostname}, which is not a host in github-log-hosts.yml`,
    );
  const res = await fetchFn(url, { redirect: "error", signal });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`the download returned ${res.status}`);
  }
  const zip = await readCapped(res, MAX_REPORT_ZIP_BYTES);
  const file = readZipEntry(zip, "input.json", MAX_ORIGINAL_INPUT_BYTES);
  if (file === undefined)
    throw new Error(`the ${name} artifact of run ${o.runId} has no input.json`);
  try {
    return JSON.parse(file.toString("utf8")) as unknown;
  } catch {
    throw new Error(`input.json of run ${o.runId} is not JSON`);
  }
}
