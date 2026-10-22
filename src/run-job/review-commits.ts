import type {
  CheckContext,
  Citation,
  ProposedPage,
} from "../output-check/pr.ts";
import { repoCitations, sourcesFor } from "../output-check/pr.ts";
import {
  compactComparison,
  type ComparedFile,
} from "../tools-server/compare.ts";

/** Reads one GitHub API path (`/repos/...`) as JSON; undefined when GitHub has no such commit or pull request. */
export type GithubJsonReader = (path: string) => Promise<unknown>;

/** A commit or pull request a change credits, as the second check sees it: what it changed and when it landed. */
export interface CreditedCommit {
  repo: string;
  /** How the changed lines name it: a sha as written, or `#<number>`; empty when only cited. */
  named: string[];
  /** Cited as evidence with no path: the commit as a whole. */
  cited?: true;
  sha?: string;
  subject?: string;
  /** The commit's own committer date; for a commit made on a branch, not when it reached the default branch. */
  committed_at?: string;
  /** When the change reached the default branch: the pull request's merge time, else the commit's own date. */
  landed_at?: string;
  /** The day of landed_at in America/Los_Angeles, the day the atlas and the docs date a change by. */
  landed_day_pacific?: string;
  /** The merged pull request that landed it, or the pull request the lines name. */
  pull?: {
    number: number;
    title: string;
    merged_at: string | null;
    merge_commit?: string;
  };
  /** A merge commit's other commits: what the pull request brought in (newest at the end). */
  commits?: { sha: string; date: string; subject: string }[];
  commits_left_out?: number;
  /** Each file the commit changed against its first parent, with the first lines of its diff. */
  files?: ComparedFile[];
  /** Files not listed, and listed files whose diff is not shown, to keep within the size limit. */
  files_left_out?: number;
  patches_left_out?: number;
  note?: string;
}

/** Commits and pull requests read per page; any further ones a page names are listed, with a note, unread. */
export const MAX_PAGE_CREDITS = 100;
/** Diff lines per file of a credited commit, for a page with at most FULL_DIFF_CREDITS credits. */
export const CREDIT_PATCH_LINES = 120;
/** Past this many credits on a page, each file's diff gets fewer lines, down to MIN_CREDIT_PATCH_LINES. */
export const FULL_DIFF_CREDITS = 16;
export const MIN_CREDIT_PATCH_LINES = 30;
/** One credited commit's diff, as JSON. */
export const MAX_COMMIT_BYTES = 40_000;
/** What a page's credited diffs share: each commit gets its part, within MAX_COMMIT_BYTES and at least MIN_COMMIT_BYTES. */
export const MAX_PAGE_COMMIT_BYTES = 480_000;
export const MIN_COMMIT_BYTES = 8_000;

/** Diff lines per file for a page that credits this many commits and pull requests. */
export function creditPatchLines(credits: number): number {
  if (credits <= FULL_DIFF_CREDITS) return CREDIT_PATCH_LINES;
  return Math.max(
    MIN_CREDIT_PATCH_LINES,
    Math.floor((CREDIT_PATCH_LINES * FULL_DIFF_CREDITS) / credits),
  );
}

/** The diff bytes each credited commit of a page gets, for a page that credits this many. */
export function creditCommitBytes(credits: number): number {
  return Math.min(
    MAX_COMMIT_BYTES,
    Math.max(
      MIN_COMMIT_BYTES,
      Math.floor(MAX_PAGE_COMMIT_BYTES / Math.max(1, credits)),
    ),
  );
}
/** A merge commit's own commits listed, the newest. */
const MAX_MERGE_COMMITS = 20;

export const SHA_IN_TEXT = /(?<![0-9A-Za-z])[0-9a-f]{7,40}(?![0-9A-Za-z])/g;
export const PULL_IN_TEXT =
  /(?<![\w&#])(?:([A-Za-z0-9][A-Za-z0-9._-]*)#|#)(\d{1,6})(?!\w)/g;
export const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
export const HEX = /^[0-9a-f]{7,40}$/;

/** One thing a change credits: a sha or `#<number>`, and the repositories it may be in. */
export interface Credit {
  repos: string[];
  ref: string;
  cited?: true;
  /** The change's removed lines name it too: a credit the page already made, kept. */
  kept?: true;
}

/**
 * What one change credits: commit shas (with a digit, so no hex-only word)
 * and pull request numbers in its added lines, looked up in the
 * repositories its evidence cites, and each commit it cites with no path.
 * The job's own repositories are not evidence and are never looked in.
 */
export function creditsOf(
  added: readonly string[],
  removed: readonly string[],
  citations: readonly Citation[],
  targets: readonly string[],
  resolve: (c: Citation) => string | undefined = (c) => c.commit,
): Credit[] {
  const repos = [
    ...new Set(
      citations
        .map((c) => c.repo)
        .filter((r) => REPO.test(r) && !targets.includes(r)),
    ),
  ];
  const owner = (repos[0] ?? targets[0] ?? "").split("/")[0]!;
  const out: Credit[] = [];
  const text = added.join("\n");
  const before = removed.join("\n");
  const keptShas = new Set([...before.matchAll(SHA_IN_TEXT)].map((m) => m[0]));
  const keptPulls = new Set(
    [...before.matchAll(PULL_IN_TEXT)].map((m) => `#${Number(m[2])}`),
  );
  if (repos.length > 0)
    for (const m of text.matchAll(SHA_IN_TEXT))
      if (/\d/.test(m[0]))
        out.push({
          repos,
          ref: m[0],
          ...(keptShas.has(m[0]) ? { kept: true as const } : {}),
        });
  for (const m of text.matchAll(PULL_IN_TEXT)) {
    const named = m[1] === undefined ? undefined : `${owner}/${m[1]}`;
    const where =
      named === undefined
        ? repos
        : REPO.test(named) && !targets.includes(named)
          ? [named]
          : [];
    const ref = `#${Number(m[2])}`;
    if (where.length > 0)
      out.push({
        repos: where,
        ref,
        ...(keptPulls.has(ref) ? { kept: true as const } : {}),
      });
  }
  for (const c of citations) {
    if (c.path !== undefined || c.commit === undefined) continue;
    if (!REPO.test(c.repo) || targets.includes(c.repo)) continue;
    const sha = resolve(c);
    if (sha !== undefined && HEX.test(sha))
      out.push({ repos: [c.repo], ref: sha, cited: true });
  }
  return out;
}

/** Every credit of a page's changes, once each: the new ones first, then the ones the page already made, each in the order the page makes them. */
export function pageCredits(
  page: ProposedPage,
  context: CheckContext,
): Credit[] {
  const resolve = (c: Citation) =>
    context.sources === undefined
      ? c.commit
      : (sourcesFor(c, context.sources).find((s) => s.kind === "commit")
          ?.commit ?? c.commit);
  const seen = new Map<string, Credit>();
  for (const change of page.changes ?? [])
    for (const credit of creditsOf(
      change.added,
      change.removed,
      repoCitations(change.evidence),
      context.policy.repos,
      resolve,
    )) {
      const key = `${credit.repos.join(",")}@${credit.ref}`;
      const prior = seen.get(key);
      if (prior === undefined) seen.set(key, credit);
      else {
        if (credit.cited) prior.cited = true;
        if (!credit.kept) delete prior.kept;
      }
    }
  const all = [...seen.values()];
  return [...all.filter((c) => !c.kept), ...all.filter((c) => c.kept)];
}

/** Whether a credited commit is one a page's credits name or cite. */
export function credits(
  list: readonly Credit[],
  entry: Pick<CreditedCommit, "repo" | "named" | "sha">,
): boolean {
  return list.some(
    (c) =>
      c.repos.includes(entry.repo) &&
      (entry.named.includes(c.ref) ||
        (c.cited === true &&
          entry.sha !== undefined &&
          entry.sha.startsWith(c.ref))),
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

export const repoPath = (repo: string) => {
  const [owner, name] = repo.split("/");
  return `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`;
};

/** The pull request a commit came in with: a merged one into the default branch, the earliest merged, when there are several. */
export function landingPull(raw: unknown): CreditedCommit["pull"] {
  const merged = (Array.isArray(raw) ? raw : [])
    .map(record)
    .filter((p) => str(p.merged_at) !== "");
  const base = (p: Record<string, unknown>) => record(p.base);
  const onDefault = merged.filter(
    (p) => str(base(p).ref) === str(record(base(p).repo).default_branch),
  );
  const pick = (onDefault.length > 0 ? onDefault : merged).sort((a, b) =>
    str(a.merged_at).localeCompare(str(b.merged_at)),
  )[0];
  return pick === undefined ? undefined : pullOf(pick);
}

function pullOf(
  p: Record<string, unknown>,
): NonNullable<CreditedCommit["pull"]> {
  const merged = str(p.merged_at);
  const merge = str(p.merge_commit_sha);
  return {
    number: Number(p.number),
    title: str(p.title).slice(0, 300),
    merged_at: merged === "" ? null : merged,
    ...(merged !== "" && HEX.test(merge) ? { merge_commit: merge } : {}),
  };
}

/** Files first that the page names (by path or file name) or cites, so a diff cut for size keeps them. */
function preferred(
  files: readonly Record<string, unknown>[],
  mentions: readonly string[],
): Record<string, unknown>[] {
  const hit = (f: Record<string, unknown>) => {
    const path = str(f.filename);
    const base = path.split("/").at(-1) ?? "";
    const stem = base.replace(/\.[^.]+$/, "");
    return mentions.some(
      (n) =>
        (path !== "" && n.includes(path)) ||
        (base.length >= 4 && n.includes(base)) ||
        (stem.length >= 4 && n.includes(stem)),
    );
  };
  return [...files.filter(hit), ...files.filter((f) => !hit(f))];
}

/**
 * A commit's diff within budget: its files (those the page names first)
 * and the first lines of each one's diff while they fit, and for a merge
 * commit the commits it brought in.
 */
function diffOf(
  repo: string,
  base: string,
  head: string,
  raw: unknown,
  mentions: readonly string[],
  budget: number,
  lines: number,
): Pick<
  CreditedCommit,
  | "commits"
  | "commits_left_out"
  | "files"
  | "files_left_out"
  | "patches_left_out"
> {
  const body = record(raw);
  const merge = Array.isArray(body.commits);
  const rawCommits = merge ? (body.commits as unknown[]) : [];
  const sorted = preferred(
    (Array.isArray(body.files) ? body.files : []).map(record),
    mentions,
  );
  const cmp = compactComparison(
    {
      files: sorted,
      commits: rawCommits.slice(-MAX_MERGE_COMMITS),
      total_commits: rawCommits.length,
    },
    repo,
    base,
    head,
    lines,
    budget,
  );
  const filesLeft =
    sorted.length - cmp.files.length + (cmp.files_may_be_more ? 1 : 0);
  const patchesLeft = cmp.files.filter(
    (f, i) =>
      f.patch === undefined &&
      typeof sorted[i]!.patch === "string" &&
      sorted[i]!.patch !== "",
  ).length;
  return {
    ...(merge
      ? {
          commits: cmp.commits.map((c) => ({
            sha: c.sha,
            date: c.date,
            subject: c.subject,
          })),
          ...(cmp.commits_left_out > 0
            ? { commits_left_out: cmp.commits_left_out }
            : {}),
        }
      : {}),
    files: cmp.files,
    ...(filesLeft > 0 ? { files_left_out: filesLeft } : {}),
    ...(patchesLeft > 0 ? { patches_left_out: patchesLeft } : {}),
  };
}

/**
 * The commits and pull requests every proposed page credits, read from
 * GitHub, so the second check can see that the credited commit made the
 * change a line gives it, and when it landed: subject, dates, the pull
 * request that landed it, and its diff against its first parent (for a
 * merge commit, the whole pull request). Read once each, every credit of a
 * page up to MAX_PAGE_CREDITS; a page that credits many gets fewer diff
 * lines per file and a smaller share of MAX_PAGE_COMMIT_BYTES per commit
 * (a commit shown for one page keeps that diff for every page that credits
 * it), never fewer credits. What cannot be read is listed with a note; a
 * sha or number GitHub does not know is left out.
 */
export async function creditedCommits(
  pages: readonly ProposedPage[],
  context: CheckContext,
  read: GithubJsonReader,
): Promise<CreditedCommit[]> {
  const bySha = new Map<string, CreditedCommit>();
  const byRef = new Map<string, CreditedCommit | null>();
  const out: CreditedCommit[] = [];
  const add = (entry: CreditedCommit) => {
    out.push(entry);
    return entry;
  };
  const failed = (err: unknown) =>
    `could not be read: ${(err as Error).message.split("\n")[0]}`;

  const commitEntry = async (
    repo: string,
    ref: string,
    mentions: readonly string[],
    budget: number,
    lines: number,
  ): Promise<CreditedCommit | undefined> => {
    const raw = await read(`${repoPath(repo)}/commits/${ref}`);
    if (raw === undefined) return undefined;
    const body = record(raw);
    const sha = str(body.sha);
    if (!/^[0-9a-f]{40}$/.test(sha)) return undefined;
    const prior = bySha.get(`${repo}@${sha}`);
    if (prior !== undefined) return prior;
    const commit = record(body.commit);
    const committed = str(record(commit.committer).date);
    const parents = (Array.isArray(body.parents) ? body.parents : [])
      .map((p) => str(record(p).sha))
      .filter((p) => HEX.test(p));
    const entry: CreditedCommit = {
      repo,
      named: [],
      sha,
      subject: str(commit.message).split("\n")[0]!.slice(0, 300),
      committed_at: committed,
      landed_at: committed,
    };
    bySha.set(`${repo}@${sha}`, add(entry));
    try {
      const pull = landingPull(
        await read(`${repoPath(repo)}/commits/${sha}/pulls`),
      );
      if (pull !== undefined) {
        entry.pull = pull;
        if (pull.merged_at !== null) entry.landed_at = pull.merged_at;
      }
    } catch {
      // The diff and dates still stand without the pull request.
    }
    try {
      // A merge commit's own file list is not its pull request's change; the comparison with its first parent is.
      const raw =
        parents.length > 1
          ? await read(`${repoPath(repo)}/compare/${parents[0]}...${sha}`)
          : { files: body.files };
      if (raw === undefined)
        throw new Error("GitHub has no comparison with its first parent");
      Object.assign(
        entry,
        diffOf(repo, parents[0] ?? sha, sha, raw, mentions, budget, lines),
      );
    } catch (err) {
      entry.note = `diff ${failed(err)}`;
    }
    return entry;
  };

  for (const page of pages) {
    if (page.decision !== "patch") continue;
    const all = pageCredits(page, context);
    const list = all.slice(0, MAX_PAGE_CREDITS);
    const budget = creditCommitBytes(list.length);
    const lines = creditPatchLines(list.length);
    const mentions = (page.changes ?? []).flatMap((c) => [
      ...c.added,
      ...repoCitations(c.evidence).flatMap((e) => e.path ?? []),
    ]);
    for (const credit of list) {
      for (const repo of credit.repos) {
        const key = `${repo}@${credit.ref}`;
        let entry = byRef.get(key);
        if (entry === undefined) {
          entry = null;
          try {
            if (credit.ref.startsWith("#")) {
              const raw = await read(
                `${repoPath(repo)}/pulls/${credit.ref.slice(1)}`,
              );
              if (raw !== undefined) {
                const pull = pullOf(record(raw));
                const merged =
                  pull.merge_commit === undefined
                    ? undefined
                    : await commitEntry(
                        repo,
                        pull.merge_commit,
                        mentions,
                        budget,
                        lines,
                      );
                entry = merged ?? add({ repo, named: [], pull });
                entry.pull = pull;
                if (pull.merged_at !== null) entry.landed_at = pull.merged_at;
                else entry.note = "this pull request is not merged";
              }
            } else
              entry =
                (await commitEntry(
                  repo,
                  credit.ref,
                  mentions,
                  budget,
                  lines,
                )) ?? null;
          } catch (err) {
            entry = add({
              repo,
              named: [],
              ...(credit.cited ? { sha: credit.ref } : {}),
              note: failed(err),
            });
          }
          byRef.set(key, entry);
        }
        if (entry === null) continue;
        if (!credit.cited && !entry.named.includes(credit.ref))
          entry.named.push(credit.ref);
        if (credit.cited) entry.cited = true;
        break;
      }
    }
    // Credits past the limit still reach the second check, as unread entries, so none is missed without a word.
    for (const credit of all.slice(MAX_PAGE_CREDITS)) {
      const repo = credit.repos[0]!;
      const key = `${repo}@${credit.ref}`;
      if (byRef.has(key)) continue;
      byRef.set(
        key,
        add({
          repo,
          named: credit.cited ? [] : [credit.ref],
          ...(credit.cited ? { cited: true as const, sha: credit.ref } : {}),
          note: `not read: the page credits more than ${MAX_PAGE_CREDITS} commits and pull requests`,
        }),
      );
    }
  }
  for (const entry of out) {
    const day =
      entry.landed_at === undefined ? undefined : pacificDay(entry.landed_at);
    if (day !== undefined) entry.landed_day_pacific = day;
  }
  return out;
}

const PACIFIC_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The YYYY-MM-DD day of an ISO time in America/Los_Angeles; undefined when it is not a time. */
export function pacificDay(iso: string): string | undefined {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : PACIFIC_DAY.format(new Date(t));
}
