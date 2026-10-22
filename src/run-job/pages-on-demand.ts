import { fileLines } from "../deliver/plan.ts";
import { firstLine } from "../lib/problem.ts";
import { isPlainRelativePath, matchesAnyGlob } from "../output-check/glob.ts";
import type { PinnedPage } from "../output-check/pr.ts";
import type { GithubJsonReader } from "./review-commits.ts";
import type { CitedFileReader } from "./review-files.ts";

/** Where the run keeps the pages it read on demand, for a later look and for checking the report again. */
export const PAGES_ON_DEMAND_FILE = "pages-on-demand.json";

/** The most pages one run reads on demand. */
export const MAX_PAGES_ON_DEMAND = 10;
/** A page larger than this is not read. */
export const MAX_PAGE_ON_DEMAND_BYTES = 512 * 1024;

const SHA = /^[0-9a-f]{40}$/;

/** What the run did about the pages a patch named that the input did not give. */
export interface PagesOnDemandRecord {
  /** The pages read, with their lines, or known to be absent; each is checked like a given page. */
  pages: PinnedPage[];
  /** Pages named but not read, and why; the PR checker then finds no pinned copy of them. */
  skipped: { repo: string; path: string; why: string }[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the pages a patch of the answer names that the input did not give,
 * when they are in the job's repositories and match pages_on_demand.paths:
 * at the commit of the input's other pages of that repository (one pull
 * request has one base), or else at the head of its default branch. A file
 * that is not there comes back as absent, with no lines. Nothing is read
 * without a reader (a stub run).
 */
export async function readPagesOnDemand(o: {
  answer: unknown;
  pinned: readonly PinnedPage[];
  repos: readonly string[];
  paths: readonly string[];
  read?: CitedFileReader;
  json?: GithubJsonReader;
}): Promise<PagesOnDemandRecord> {
  const record: PagesOnDemandRecord = { pages: [], skipped: [] };
  const pages = isObject(o.answer) ? o.answer.pages : undefined;
  if (!Array.isArray(pages)) return record;
  const heads = new Map<string, Promise<string>>();
  const seen = new Set<string>();
  for (const page of pages) {
    if (!isObject(page) || page.decision !== "patch") continue;
    const { repo, path } = page;
    if (typeof repo !== "string" || typeof path !== "string") continue;
    const id = `${repo}/${path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (o.pinned.some((p) => p.repo === repo && p.path === path)) continue;
    const skip = (why: string) => record.skipped.push({ repo, path, why });
    if (!o.repos.includes(repo)) {
      skip("not a repository this job may change");
      continue;
    }
    if (!isPlainRelativePath(path) || !matchesAnyGlob(path, o.paths)) {
      skip("outside output.pages_on_demand.paths");
      continue;
    }
    if (o.read === undefined || o.json === undefined) {
      skip(
        "this run has no reader for pages on demand (a stub run reads none)",
      );
      continue;
    }
    if (record.pages.length >= MAX_PAGES_ON_DEMAND) {
      skip(`a run reads at most ${MAX_PAGES_ON_DEMAND} pages on demand`);
      continue;
    }
    const json = o.json;
    const given = o.pinned.find((p) => p.repo === repo)?.commit;
    let commit: string;
    try {
      commit =
        given ??
        (await (heads.get(repo) ??
          heads.set(repo, defaultHead(repo, json)).get(repo)!));
    } catch (err) {
      skip(`the head of ${repo} could not be read: ${firstLine(err)}`);
      continue;
    }
    let text: string | undefined;
    try {
      text = await o.read(repo, commit, path);
    } catch (err) {
      skip(`reading it failed: ${firstLine(err)}`);
      continue;
    }
    if (text === undefined) {
      record.pages.push({ repo, path, commit, lines: [], absent: true });
      continue;
    }
    if (Buffer.byteLength(text) > MAX_PAGE_ON_DEMAND_BYTES) {
      skip(`it is larger than ${MAX_PAGE_ON_DEMAND_BYTES} bytes`);
      continue;
    }
    if (text.includes("\0")) {
      skip("it is not a text file");
      continue;
    }
    record.pages.push({ repo, path, commit, lines: fileLines(text).lines });
  }
  return record;
}

/** The commit at the head of a repository's default branch. */
async function defaultHead(
  repo: string,
  json: GithubJsonReader,
): Promise<string> {
  const info = await json(`/repos/${repo}`);
  const branch = isObject(info) ? info.default_branch : undefined;
  if (typeof branch !== "string" || branch === "")
    throw new Error(`GitHub names no default branch of ${repo}`);
  const head = await json(
    `/repos/${repo}/commits/${encodeURIComponent(branch)}`,
  );
  const sha = isObject(head) ? head.sha : undefined;
  if (typeof sha !== "string" || !SHA.test(sha))
    throw new Error(`GitHub names no commit at the head of ${repo}`);
  return sha;
}

/** The pages a kept pages-on-demand.json holds, as the PR checker reads given pages. */
export function onDemandPages(value: unknown): PinnedPage[] {
  const pages = isObject(value) ? value.pages : undefined;
  if (!Array.isArray(pages)) return [];
  return pages.filter(
    (p): p is PinnedPage =>
      isObject(p) &&
      typeof p.repo === "string" &&
      typeof p.path === "string" &&
      typeof p.commit === "string" &&
      Array.isArray(p.lines) &&
      p.lines.every((l) => typeof l === "string"),
  );
}
