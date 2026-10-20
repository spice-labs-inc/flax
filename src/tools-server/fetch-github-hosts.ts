import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  GITHUB_META_URL,
  githubHostsProblems,
  type GithubHosts,
} from "../lib/github-hosts.ts";
import { GITHUB_HOSTS_FILE } from "../lib/paths.ts";
import { formatProblem } from "../lib/problem.ts";
import { byCodePoint } from "../lib/sort.ts";

/** api.github.com/meta is about 200 KB today. */
export const MAX_META_BYTES = 4 * 1024 * 1024;

/**
 * The job log download hosts among GitHub's published Actions hosts: the
 * results service's storage accounts (job logs redirect there today) and
 * the older pipelines hosts. Whole names only, so a published wildcard such
 * as *.core.windows.net, which would reach any Azure storage account, never
 * matches.
 */
export const LOG_HOST_PATTERNS: readonly RegExp[] = [
  /^productionresultssa\d+\.blob\.core\.windows\.net$/,
  /^pipelines[a-z0-9]+\.actions\.githubusercontent\.com$/,
];

export const API_HOST = "api.github.com";

/** The log hosts in a meta answer plus api.github.com, sorted; throws on an answer that lists none. */
export function logHostsFromMeta(meta: unknown): string[] {
  const full = (
    meta as { domains?: { actions_inbound?: { full_domains?: unknown } } }
  )?.domains?.actions_inbound?.full_domains;
  if (!Array.isArray(full) || !full.every((d) => typeof d === "string"))
    throw new Error(
      `${GITHUB_META_URL} does not list domains.actions_inbound.full_domains`,
    );
  const logs = full.filter((d) => LOG_HOST_PATTERNS.some((p) => p.test(d)));
  if (!logs.some((d) => LOG_HOST_PATTERNS[0]!.test(d)))
    throw new Error(
      `${GITHUB_META_URL} lists no productionresultssa*.blob.core.windows.net host; GitHub may have moved job logs`,
    );
  return [...new Set([API_HOST, ...logs])].sort(byCodePoint);
}

export function githubHostsText(hosts: GithubHosts): string {
  return [
    "# The exact hosts a run may reach to read GitHub job logs: api.github.com",
    "# and the log download hosts GitHub publishes. Written by",
    "# flax agents fetch-github-hosts from domains.actions_inbound.full_domains at the",
    "# source below; run it again to update, do not edit by hand. Schema:",
    "# schema/github-log-hosts.schema.json. The tools server follows GitHub's",
    "# downloads only to these hosts.",
    stringify(hosts),
  ].join("\n");
}

async function readMeta(fetchFn: typeof fetch): Promise<unknown> {
  const res = await fetchFn(GITHUB_META_URL, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok || res.body === null)
    throw new Error(`${GITHUB_META_URL} returned ${res.status}`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    if (bytes > MAX_META_BYTES)
      throw new Error(
        `${GITHUB_META_URL} is larger than ${MAX_META_BYTES} bytes`,
      );
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error(`${GITHUB_META_URL} did not return JSON`);
  }
}

export interface FetchGithubHostsOptions {
  /** The repository root; github-log-hosts.yml is written there. */
  root: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Reads api.github.com/meta and writes github-log-hosts.yml: the exact log
 * download hosts plus api.github.com, with the day they were read. A list
 * that would fail flax agents check is never written.
 */
export async function fetchGithubHosts(
  options: FetchGithubHostsOptions,
): Promise<GithubHosts> {
  const meta = await readMeta(options.fetch ?? fetch);
  const hosts: GithubHosts = {
    fetched: (options.now ?? (() => new Date()))().toISOString().slice(0, 10),
    source: GITHUB_META_URL,
    hosts: logHostsFromMeta(meta),
  };
  const problems = githubHostsProblems(hosts);
  if (problems.length > 0)
    throw new Error(problems.map(formatProblem).join("; "));
  const path = join(options.root, GITHUB_HOSTS_FILE);
  const partial = `${path}.partial`;
  writeFileSync(partial, githubHostsText(hosts));
  renameSync(partial, path);
  return hosts;
}
