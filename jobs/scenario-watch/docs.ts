/**
 * What the scenario watch collects, shared with any other docs watch job a
 * workspace keeps beside it: the pull requests merged across the
 * organization in the window, the names each diff removed from its code
 * (API paths, command line flags, environment variables, quoted strings
 * removed and not added back), the pages that mention those names (leads),
 * the merged commits behind them as sources to cite, the UI's navigation
 * source and route list (uiSource) every UI label and path in a patch must
 * match, and the waiting rule: a job proposes nothing while its own pull
 * request is open.
 */
import type { CollectTools } from "@flax/agents/collect/tools";
import { jobBranchPrefix } from "@flax/agents/deliver/writer";
import { personLogin } from "@flax/agents/lib/login";

export const ORG = "{{github}}";
/** Repositories that are documentation themselves: their changes do not make a page stale. */
export const SKIP_REPOS = new Set<string>({{docsRepos}});

/** Every run reads the week before it. */
export const WINDOW_DAYS = 7;
const MERGED_PER_PAGE = 50;
const MERGED_MAX_PAGES = 4;
/** Merged pull requests whose diffs are read, newest first. */
export const MAX_PRS = 100;
/** A name found on more pages than this is too common to point at one fact. */
export const MAX_PAGES_PER_TERM = 6;
const MAX_EXCERPT_FILES = 6;
const MAX_EXCERPT_LINES = 30;
const MAX_LISTED_FILES = 30;
/** The UI repository, whose navigation source the UI names in a patch are checked against. */
export const UI_REPO = "{{uiRepo}}";
/** The components that name the UI's menus and views. */
export const UI_FILES: readonly string[] = {{uiNavFiles}};
/** The SvelteKit routes directory of the UI repository. */
export const UI_ROUTES_DIR = "src/routes";
const MAX_UI_DIRS = 80;
/** Navigation source given to the model, all files together. */
export const MAX_UI_BYTES = 40_000;
const POOL = 6;
const OPEN_PER_PAGE = 10;
const OPEN_MAX_PAGES = 10;

/** Files whose removed lines say nothing about what the product does. */
const NOISE_FILE =
  /(^|\/)(tests?|__tests__|__snapshots__|fixtures|testdata|dist|vendor|node_modules)\/|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum|CHANGELOG\.md)$|\.(snap|svg|png|jpg|lock)$/;

/** A file whose removed lines say nothing about what the product does: tests, fixtures, lock files, build output. */
export function isNoiseFile(path: string): boolean {
  return NOISE_FILE.test(path);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** fn over every item, at most limit at a time, the results in item order. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** The tool calls of one collection, with every failure kept for the input. */
export class Calls {
  readonly failures: string[] = [];
  count = 0;
  private readonly tools: CollectTools;

  constructor(tools: CollectTools) {
    this.tools = tools;
  }

  record(label: string, message: string): void {
    this.failures.push(`${label}: ${message}`.slice(0, 300));
  }

  async text(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; truncated: boolean } | undefined> {
    this.count += 1;
    try {
      return await this.tools.call(tool, args);
    } catch (err) {
      this.failures.push((err as Error).message.slice(0, 300));
      return undefined;
    }
  }

  async json(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown | undefined> {
    this.count += 1;
    try {
      return await this.tools.json(tool, args);
    } catch (err) {
      this.failures.push((err as Error).message.slice(0, 300));
      return undefined;
    }
  }
}

export interface Window {
  now: Date;
  since: Date;
  sinceDay: string;
}

export function windowAt(now: Date, days = WINDOW_DAYS): Window {
  const since = new Date(now.getTime() - days * 86400_000);
  return { now, since, sinceDay: since.toISOString().slice(0, 10) };
}

export interface MergedPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  /** The login of the person who opened it; not set for an app or bot. */
  author?: string;
}

export async function collectMergedPrs(calls: Calls, w: Window) {
  const prs: MergedPr[] = [];
  for (let page = 1; page <= MERGED_MAX_PAGES; page++) {
    const answer = await calls.json("gh-merged-prs", {
      since: w.sinceDay,
      per_page: MERGED_PER_PAGE,
      page,
    });
    if (!isObject(answer))
      throw new Error(
        `cannot list the merged pull requests: ${calls.failures.at(-1) ?? "the answer is not an object"}`,
      );
    const items = records(answer.items);
    for (const pr of items) {
      const mergedAt = str(
        isObject(pr.pull_request) ? pr.pull_request.merged_at : undefined,
      );
      if (mergedAt === "" || Date.parse(mergedAt) < w.since.getTime()) continue;
      const author = personLogin(pr.user);
      prs.push({
        repo: str(pr.repository_url).split("/").pop() ?? "",
        number: Number(pr.number),
        title: str(pr.title),
        url: str(pr.html_url),
        mergedAt,
        ...(author === undefined ? {} : { author }),
      });
    }
    if (items.length < MERGED_PER_PAGE) break;
  }
  prs.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
  return prs;
}

export interface DiffFile {
  path: string;
  status: "added" | "deleted" | "modified" | "renamed";
  removed: string[];
  added: string[];
}

/** The files of a unified diff, with their removed and added lines. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let inHunk = false;
  for (const line of text.split("\n")) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head !== null) {
      file = { path: head[2]!, status: "modified", removed: [], added: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (file === undefined) continue;
    if (!inHunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename to ")) file.status = "renamed";
      else if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("-")) file.removed.push(line.slice(1));
    else if (line.startsWith("+")) file.added.push(line.slice(1));
  }
  return files;
}

const TERM_PATTERNS = [
  // API and URL paths with at least two segments
  /(?<![\w.])\/(?:[A-Za-z0-9_.{}:*-]+\/)+[A-Za-z0-9_.{}:*-]+/g,
  // command line flags
  /(?<![\w-])--[a-z][a-z0-9]*(?:-[a-z0-9]+)+|(?<![\w-])--[a-z]{4,}/g,
  // environment variables and constants in capitals
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
  // quoted strings of two or more parts, such as labels and feature names
  /(?<=["'`])[A-Za-z][A-Za-z0-9]*(?:[ ./:_-][A-Za-z0-9]+)+(?=["'`])/g,
  // text between tags, such as a navigation label
  /(?<=>)[A-Z][A-Za-z0-9 ]{4,40}[A-Za-z0-9](?=<)/g,
];

/** Names a line mentions that a page could also mention. */
export function terms(line: string): string[] {
  const found = new Set<string>();
  for (const pattern of TERM_PATTERNS)
    for (const m of line.matchAll(pattern)) found.add(m[0].trim());
  return [...found].filter((t) => t.length >= 8 && !/^\d/.test(t));
}

/**
 * The names a pull request removed from its product files and did not add
 * back anywhere in the same pull request: what a page may now wrongly say.
 */
export function removedTerms(files: readonly DiffFile[]): string[] {
  const kept = new Set<string>();
  for (const f of files)
    for (const l of f.added) for (const t of terms(l)) kept.add(t);
  const gone = new Set<string>();
  for (const f of files) {
    if (NOISE_FILE.test(f.path)) continue;
    for (const l of f.removed)
      for (const t of terms(l)) if (!kept.has(t)) gone.add(t);
  }
  return [...gone].sort();
}

export interface PrChange extends MergedPr {
  files: DiffFile[];
  removedTerms: string[];
  diffCut: boolean;
}

export async function collectChanges(calls: Calls, prs: readonly MergedPr[]) {
  const code = prs.filter((p) => !SKIP_REPOS.has(p.repo)).slice(0, MAX_PRS);
  const changes = await pool(code, POOL, async (pr) => {
    const result = await calls.text("gh-pull-requests", {
      repo: pr.repo,
      number: pr.number,
      view: "get_diff",
    });
    if (result === undefined) return undefined;
    const files = parseDiff(result.text);
    return {
      ...pr,
      files,
      removedTerms: removedTerms(files),
      diffCut: result.truncated,
    } satisfies PrChange;
  });
  return changes.filter((c) => c !== undefined);
}

/** The newest commit on main of a repository, and the newest commits' shas by the pull request number in their titles. */
export async function collectCommits(calls: Calls, repo: string) {
  const answer = await calls.json("gh-commits", { repo, per_page: 50 });
  const list = records(answer);
  const byPr = new Map<number, string>();
  for (const c of list) {
    const title = str(isObject(c.commit) ? c.commit.message : "").split(
      "\n",
    )[0]!;
    const m =
      /\(#(\d+)\)\s*$/.exec(title) ??
      /^Merge pull request #(\d+)\b/.exec(title);
    if (m !== null && !byPr.has(Number(m[1])))
      byPr.set(Number(m[1]), str(c.sha));
  }
  const head = list.length > 0 ? str(list[0]!.sha) : undefined;
  return { head, byPr };
}

const FILE_HEAD = /^[^\n]*\(SHA: ([0-9a-f]{7,64})\)[^\n]*\n/;

/** The file text out of a gh-file result, or why it is not usable. */
export function parseFile(
  text: string,
  truncated: boolean,
): { source: string } | { problem: string } {
  if (truncated) return { problem: "the file was cut to the tool's size cap" };
  const m = FILE_HEAD.exec(text);
  if (m === null) return { problem: "the result is not a text file" };
  return { source: text.slice(m[0].length) };
}

export interface Lead {
  term: string;
  repo: string;
  number: number;
}

export interface Page {
  repo: string;
  path: string;
  text: string;
  leads: Lead[];
}

/** Which removed names each page mentions, leaving out names too common to mean anything. */
export function matchLeads(
  pages: readonly { repo: string; path: string; text: string }[],
  changes: readonly PrChange[],
): Page[] {
  const byTerm = new Map<string, Lead[]>();
  for (const c of changes)
    for (const term of c.removedTerms)
      byTerm.set(term, [
        ...(byTerm.get(term) ?? []),
        { term, repo: c.repo, number: c.number },
      ]);
  const hits = pages.map((p) => ({ ...p, leads: [] as Lead[] }));
  for (const [term, leads] of byTerm) {
    const on = hits.filter((p) => p.text.includes(term));
    if (on.length === 0 || on.length > MAX_PAGES_PER_TERM) continue;
    for (const p of on) p.leads.push(...leads);
  }
  return hits.filter((p) => p.leads.length > 0);
}

/** How many pages, and how many bytes of their text, an input may hold. */
export interface PageCaps {
  pages: number;
  bytes: number;
}

/** The pages naming the most distinct removed names, within the page and byte caps. */
export function selectPages(
  candidates: readonly Page[],
  caps: PageCaps,
): Page[] {
  const score = (p: Page) => new Set(p.leads.map((l) => l.term)).size;
  const ranked = [...candidates].sort(
    (a, b) =>
      score(b) - score(a) ||
      a.repo.localeCompare(b.repo) ||
      a.path.localeCompare(b.path),
  );
  const chosen: Page[] = [];
  let bytes = 0;
  for (const p of ranked) {
    if (chosen.length >= caps.pages) break;
    const size = Buffer.byteLength(p.text);
    if (bytes + size > caps.bytes) continue;
    chosen.push(p);
    bytes += size;
  }
  return chosen;
}

export function fileLines(text: string): string[] {
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** A Svelte component's lines without its style blocks, which name nothing a reader sees. */
export function withoutStyles(lines: readonly string[]): string[] {
  const out: string[] = [];
  let inStyle = false;
  for (const line of lines) {
    if (!inStyle && /^<style[\s>]/.test(line)) inStyle = true;
    if (!inStyle) out.push(line);
    if (inStyle && line.includes("</style>")) inStyle = false;
  }
  return out;
}

/** The URL pattern of a SvelteKit route directory: groups dropped, parameters kept as written. */
export function routeOf(dir: string): string {
  const parts = dir
    .slice(UI_ROUTES_DIR.length)
    .split("/")
    .filter((p) => p !== "" && !/^\(.*\)$/.test(p));
  return `/${parts.join("/")}`;
}

/** Every UI route: each directory under the routes directory with a +page or +server file. */
export async function listRoutes(calls: Calls): Promise<string[]> {
  const routes = new Set<string>();
  const dirs: string[] = [UI_ROUTES_DIR];
  let read = 0;
  while (dirs.length > 0 && read < MAX_UI_DIRS) {
    const dir = dirs.shift()!;
    read += 1;
    const answer = await calls.json("gh-file", { repo: UI_REPO, path: dir });
    for (const entry of records(answer)) {
      if (entry.type === "dir") dirs.push(str(entry.path));
      else if (
        entry.type === "file" &&
        /^\+(page|server)\./.test(str(entry.name))
      )
        routes.add(routeOf(dir));
    }
  }
  if (dirs.length > 0)
    calls.record(
      UI_REPO,
      `stopped listing routes after ${MAX_UI_DIRS} directories`,
    );
  return [...routes].sort();
}

/** The UI's navigation components and routes, read from main at commit. */
export async function collectUiSource(calls: Calls, commit: string) {
  const files: { path: string; lines: string[] }[] = [];
  let bytes = 0;
  for (const path of UI_FILES) {
    const result = await calls.text("gh-file", { repo: UI_REPO, path });
    if (result === undefined) continue;
    const file = parseFile(result.text, result.truncated);
    if ("problem" in file) {
      calls.record(`${UI_REPO}/${path}`, file.problem);
      continue;
    }
    const lines = withoutStyles(fileLines(file.source));
    const size = Buffer.byteLength(lines.join("\n"));
    if (bytes + size > MAX_UI_BYTES) {
      calls.record(
        `${UI_REPO}/${path}`,
        `left out: over the ${MAX_UI_BYTES} byte cap for navigation source`,
      );
      continue;
    }
    files.push({ path, lines });
    bytes += size;
  }
  return {
    repo: `${ORG}/${UI_REPO}`,
    commit,
    files,
    routes: await listRoutes(calls),
  };
}

/** How much of a commit's diff a source shows: files, and lines of each side per file. */
export interface ExcerptCaps {
  files: number;
  lines: number;
}

/** A merged commit as a source to cite: the files it changed and their diff lines, those that removed a name a chosen page mentions first. */
export function commitSource(
  change: PrChange,
  sha: string,
  named: Set<string>,
  caps: ExcerptCaps = { files: MAX_EXCERPT_FILES, lines: MAX_EXCERPT_LINES },
) {
  const names = (f: DiffFile) =>
    f.removed.some((l) => terms(l).some((t) => named.has(t)));
  // The files that removed a named thing first, then the product files
  // around them, which often show where it went.
  const excerpt = [
    ...change.files.filter(names),
    ...change.files.filter((f) => !names(f) && !NOISE_FILE.test(f.path)),
  ]
    .slice(0, caps.files)
    .map((f) => ({
      path: f.path,
      removed: f.removed.slice(0, caps.lines),
      added: f.added.slice(0, caps.lines),
    }));
  return {
    kind: "commit" as const,
    repo: `${ORG}/${change.repo}`,
    commit: sha,
    date: change.mergedAt,
    title: `${change.title} (#${change.number})`,
    ...(change.author === undefined ? {} : { authors: [change.author] }),
    files: change.files
      .slice(0, MAX_LISTED_FILES)
      .map((f) => ({ path: f.path, status: f.status })),
    excerpt,
  };
}

/** A page's text on main, or undefined, with the reason recorded, when it cannot be read whole. */
export async function readPage(
  calls: Calls,
  repo: string,
  path: string,
): Promise<{ repo: string; path: string; text: string } | undefined> {
  const result = await calls.text("gh-file", { repo, path });
  if (result === undefined) return undefined;
  const file = parseFile(result.text, result.truncated);
  if ("problem" in file) {
    calls.record(`${repo}/${path}`, file.problem);
    return undefined;
  }
  return { repo, path, text: file.source };
}

export type RepoCommits = Awaited<ReturnType<typeof collectCommits>>;

/**
 * The candidate pages with only the leads that can be cited: a pull
 * request whose merged commit is not among the newest on main cannot be,
 * so its leads are dropped before the pages are chosen.
 */
export async function citableLeads(
  calls: Calls,
  candidates: readonly Page[],
  changes: readonly PrChange[],
) {
  const led = changes.filter((c) =>
    candidates.some((p) =>
      p.leads.some((l) => l.repo === c.repo && l.number === c.number),
    ),
  );
  const commits = new Map<string, RepoCommits>();
  for (const repo of [...new Set(led.map((c) => c.repo))].sort())
    commits.set(repo, await collectCommits(calls, repo));
  const shaOf = (c: { repo: string; number: number }) =>
    commits.get(c.repo)?.byPr.get(c.number);
  for (const c of led)
    if (shaOf(c) === undefined)
      calls.record(
        `${c.repo}#${c.number}`,
        "merged commit not among the newest 50 on main",
      );
  const citable = candidates
    .map((p) => ({
      ...p,
      leads: p.leads.filter((l) => shaOf(l) !== undefined),
    }))
    .filter((p) => p.leads.length > 0);
  return { citable, led, commits, shaOf };
}

/** The merged commits behind the chosen pages' leads, as sources; each source's repository head goes into repos. */
export function leadSources(
  chosen: readonly Page[],
  led: readonly PrChange[],
  commits: ReadonlyMap<string, RepoCommits>,
  repos: Record<string, string>,
) {
  const named = new Set(chosen.flatMap((p) => p.leads.map((l) => l.term)));
  return led
    .filter((c) =>
      chosen.some((p) =>
        p.leads.some((l) => l.repo === c.repo && l.number === c.number),
      ),
    )
    .map((c) => {
      const repo = commits.get(c.repo);
      if (repo?.head !== undefined) repos[`${ORG}/${c.repo}`] = repo.head;
      return commitSource(c, repo!.byPr.get(c.number)!, named);
    });
}

/** The removed names a page mentions, each with the pull request that removed it. */
export function leadNames(p: Page) {
  return [
    ...new Map(
      p.leads.map((l) => [
        `${l.term} ${l.repo}#${l.number}`,
        { name: l.term, pull_request: `${ORG}/${l.repo}#${l.number}` },
      ]),
    ).values(),
  ];
}

/** A job's own open pull request on its repository. */
export interface Waiting {
  pull: number;
  url: string;
  branch: string;
}

/**
 * The job's open pull request on the repository, if any: one a bot opened
 * from the repository itself on an agent/<job>/ branch, as delivery opens
 * them. Delivery closes the job's earlier open pull requests, so a run
 * that delivered while one is open would throw away its review comments
 * and revisions. A list that cannot be read stops the run.
 */
export async function openAgentPull(
  calls: Calls,
  job: string,
  repo: string,
): Promise<Waiting | undefined> {
  const prefix = jobBranchPrefix(job);
  const full = `${ORG}/${repo}`;
  for (let page = 1; page <= OPEN_MAX_PAGES; page++) {
    const answer = await calls.json("gh-pull-requests", {
      repo,
      state: "open",
      per_page: OPEN_PER_PAGE,
      page,
    });
    if (!Array.isArray(answer))
      throw new Error(
        `cannot tell whether ${job} has an open pull request on ${full}: ${calls.failures.at(-1) ?? "the answer is not a list"}`,
      );
    for (const p of records(answer)) {
      const head = isObject(p.head) ? p.head : {};
      const user = isObject(p.user) ? p.user : {};
      const from = isObject(head.repo) ? str(head.repo.full_name) : full;
      if (
        str(head.ref).startsWith(prefix) &&
        str(user.login).endsWith("[bot]") &&
        from === full
      )
        return {
          pull: Number(p.number),
          url: str(p.html_url),
          branch: str(head.ref),
        };
    }
    if (answer.length < OPEN_PER_PAGE) return undefined;
  }
  throw new Error(
    `cannot tell whether ${job} has an open pull request on ${full}: more than ${OPEN_PER_PAGE * OPEN_MAX_PAGES} are open`,
  );
}

/** What the tools server writes in place of a secret-shaped string or a UUID (:id). */
const SCRUBBED_TEXT = /\[redacted\]|:id(?![A-Za-z0-9_])/;

/** The page holds text the tools server scrubs, so the model would not see it as it is on GitHub and its patch could not be delivered. */
export function isScrubbed(text: string): boolean {
  return SCRUBBED_TEXT.test(text);
}

/** How many tool calls a collection made, and the first of its failures. */
export function collection(calls: Calls) {
  return {
    toolCalls: calls.count,
    failedCalls: calls.failures.length,
    failures: calls.failures.slice(0, 10),
  };
}
