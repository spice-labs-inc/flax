import { asPinnedInput } from "../output-check/pinned-input.ts";
import { fileLines } from "../deliver/plan.ts";
import type { RepoFile } from "../deliver/writer.ts";
import { isPlainRelativePath, matchesAnyGlob } from "../output-check/glob.ts";
import type { PinnedPage, PrPolicy, Source } from "../output-check/pr.ts";
import { MAX_ROUNDS, type RevisionRequest } from "./requests.ts";
import type { PullThread } from "./thread.ts";

/** What the model learns about the pull request it revises, under input.revision. */
export interface RevisionBlock {
  repo: string;
  pull: number;
  url: string;
  branch: string;
  /** The pull request's head commit: every page was read there, and the revision commits on top of it. */
  head: string;
  round: number;
  max_rounds: number;
  requests: RevisionRequest[];
}

export interface BuildRevisionOptions {
  /** The input.json of the run that opened the pull request. */
  original: unknown;
  thread: PullThread;
  requests: readonly RevisionRequest[];
  round: number;
  policy: PrPolicy;
  /** Reads a file of the pull request's repository at a commit. */
  readFile(path: string, commit: string): Promise<RepoFile | undefined>;
}

/** The pages a revision may change: those the pull request changes and those a line comment points at, inside the job's paths. */
export function revisionPaths(
  thread: PullThread,
  requests: readonly RevisionRequest[],
  policy: PrPolicy,
): string[] {
  const paths = new Set<string>();
  for (const p of [
    ...thread.files,
    ...requests.flatMap((r) => (r.path === undefined ? [] : [r.path])),
  ])
    if (isPlainRelativePath(p) && matchesAnyGlob(p, policy.paths)) paths.add(p);
  return [...paths].sort();
}

/**
 * The input of a revision run: the original run's input (its sources,
 * rules and anything else the job's prompt reads), with its pages
 * replaced by the pull request's pages as they are at its head, the
 * requests added as review sources the model may cite, no stamps (only
 * the first run sets them), and a revision block saying what to answer.
 */
export async function buildRevisionInput(
  o: BuildRevisionOptions,
): Promise<{ input: Record<string, unknown> } | { error: string }> {
  const pinned = asPinnedInput(o.original);
  if ("error" in pinned)
    return { error: `the original run's input is unusable: ${pinned.error}` };
  const { pull } = o.thread;
  const pages: PinnedPage[] = [];
  for (const path of revisionPaths(o.thread, o.requests, o.policy)) {
    const file = await o.readFile(path, pull.headSha);
    if (file === undefined) continue;
    pages.push({
      repo: pull.repo,
      commit: pull.headSha,
      path,
      lines: fileLines(file.text).lines,
    });
  }
  if (pages.length === 0)
    return {
      error: "the pull request has no page this job may change at its head",
    };
  const reviews: Source[] = o.requests.map((r) => ({
    kind: "review",
    repo: pull.repo,
    commit: pull.headSha,
    id: r.id,
    author: r.author,
    url: r.url,
    lines: r.text.split("\n"),
  }));
  const original = o.original as Record<string, unknown>;
  const revision: RevisionBlock = {
    repo: pull.repo,
    pull: pull.number,
    url: pull.url,
    branch: pull.branch,
    head: pull.headSha,
    round: o.round,
    max_rounds: MAX_ROUNDS,
    requests: [...o.requests],
  };
  const input: Record<string, unknown> = { ...original };
  delete input.stamps;
  input.pages = pages;
  input.sources = [...(pinned.sources ?? []), ...reviews];
  input.revision = revision;
  return { input };
}
