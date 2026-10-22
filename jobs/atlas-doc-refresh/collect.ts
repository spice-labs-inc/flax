/**
 * Gathers the atlas doc refresh input deterministically, through the run's
 * tools server (the job's collect_tools), never with credentials of its own.
 *
 * It does what the atlas's drift check does: every repos/*.md whose
 * analyzed_commit is behind its repository's main has drifted; drift that
 * only touched files a noise rule names (version pins, regenerated data) is
 * noise, which gets an analyzed_commit stamp and no model. The first 3 docs
 * with real drift, by name, go to the model as pinned pages with the
 * comparison of their old and new commits, each with the section files it
 * keeps under repos/<name>/; the rest wait for the next run. The input has
 * the shape the PR checker reads (pages, sources, rules, repos), so
 * pnpm check-output checks an answer like any other pull request job's.
 */
import {
  connectCollectTools,
  type CollectTools,
  runMain,
} from "@flax/agents/collect/tools";
import { jobBranchPrefix } from "@flax/agents/deliver/writer";
import { byCodePoint } from "@flax/agents/lib/sort";

export const JOB = "{{name}}";
export const ORG = "{{github}}";
export const ATLAS = "{{atlasRepo}}";
export const ATLAS_REPO = `${ORG}/${ATLAS}`;
export const DOCS_DIR = "repos";
/** Atlas pages a refresh may ripple into besides the docs themselves. */
export const SHARED_PAGES = [
  "INDEX.md",
  "ARCHITECTURE.md",
  "GLOSSARY.md",
  "GAPS.md",
] as const;
export const TEMPLATE_PATH = "_TEMPLATE.md";
/** What the model may change; the pr output of job.yml says the same. */
export const RULES = {
  repos: [ATLAS_REPO],
  paths: [`${DOCS_DIR}/*.md`, `${DOCS_DIR}/*/*.md`, ...SHARED_PAGES],
  max_changed_lines: 800,
  // The atlas is written by models for models: every frontmatter fact may
  // change with evidence, except the doc's name, the keys code sets and
  // used_by, which the atlas's generator derives from depends_on.
  frontmatter_keys: [
    "repo",
    "language",
    "type",
    "status",
    "deploy",
    "depends_on",
    "artifacts",
    "default_branch",
  ],
};
/** The frontmatter key only this code sets, never the model. */
export const STAMP_KEY = "analyzed_commit";
/** Sections a main doc may keep in repos/<name>/<section>.md (the atlas's docs.sections minus its main-only ones), in template order. */
export const SECTION_FILES = [
  "role",
  "architecture",
  "data",
  "interfaces",
  "configuration",
  "build-test-run",
  "cicd",
  "keyfiles",
  "invariants",
] as const;
/** Byte budgets of the atlas's MAINTENANCE.md that one page's size decides; the atlas check fails a page over its budget. */
export const PAGE_BUDGETS = {
  doc: 32 * 1024,
  sectionFile: 40 * 1024,
  "INDEX.md": 24 * 1024,
  "GLOSSARY.md": 25 * 1024,
} as const;

/** Docs refreshed per run; the rest wait, in name order. */
export const MAX_REFRESHES = 3;
/** Bytes of doc text given to the model, all refreshed docs and their section files together. */
export const MAX_DOC_BYTES = 300_000;
/** Diff lines per changed file in a comparison. */
export const PATCH_LINES = 60;
/** Diff text given to the model per doc; the diffs of later files are left out. */
export const MAX_PATCH_BYTES = 60_000;

/**
 * A repository whose drift is noise when every changed file matches
 * `files`: a gitops repository whose version pin files move with every
 * deploy, or a data repository whose generated report is rewritten by a
 * workflow. Such drift cannot change what the doc says, so the doc only
 * gets a new analyzed_commit. List the workspace's own here; none means
 * every drift is real.
 */
export interface NoiseRule {
  /** The repository's name under the organization. */
  repo: string;
  /** Matches the path of every file such a change may touch. */
  files: RegExp;
}
export const NOISE_RULES: readonly NoiseRule[] = [];

/** What the tools server puts in place of a UUID or a secret-shaped string. */
export const SCRUBBED = "[redacted]";
const SCRUBBED_REASON =
  "the doc holds text the tools server scrubs (a UUID or a secret-shaped string), so the model would not see the real page";

/** A page as the model saw it must be the page on GitHub, or its patch and stamp cannot be delivered. */
function isScrubbed(lines: readonly string[]): boolean {
  return lines.some((l) => l.includes(SCRUBBED));
}
/** Enough lines for any doc's frontmatter. */
const FRONTMATTER_LINES = 40;
/** A gh-file range asking for the rest of a file. */
const REST_OF_FILE = 100_000;
const POOL = 6;
const OPEN_PER_PAGE = 10;
const OPEN_MAX_PAGES = 10;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

async function pool<T, R>(
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

/** A job's own open pull request on its docs repository. */
export interface Waiting {
  pull: number;
  url: string;
  branch: string;
}

/**
 * The job's open pull request on the docs repository, if any: one a bot
 * opened from the repository itself on an agent/<job>/ branch, as delivery
 * opens them. Delivery closes the job's earlier open pull requests, so a
 * run that delivered while one is open would throw away its review
 * comments and revisions. A list that cannot be read stops the run.
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

/** The newest commit on main of a repository, or undefined when it cannot be read. */
export async function headOf(
  calls: Calls,
  repo: string,
): Promise<{ sha: string; date: string } | undefined> {
  const list = records(await calls.json("gh-commits", { repo, per_page: 1 }));
  const sha = str(list[0]?.sha);
  if (!/^[0-9a-f]{40}$/.test(sha)) return undefined;
  const commit = isObject(list[0]!.commit) ? list[0]!.commit : {};
  const committer = isObject(commit.committer) ? commit.committer : {};
  return { sha, date: str(committer.date) };
}

const RANGE_HEAD =
  /^[^\n]*\(SHA: ([0-9a-f]{7,64})\)[^\n]*; lines (?:none|(\d+)-(\d+)) of (\d+)\n/;

export interface FileRead {
  blob: string;
  lines: string[];
  total: number;
}

/**
 * Lines of a text file on main through gh-file line ranges, so a file over
 * the result cap is read in parts: each part keeps the complete lines a cut
 * result holds and asks for the rest. Every part must come from the same
 * blob, or the file changed while it was read.
 */
export async function readLines(
  calls: Calls,
  repo: string,
  path: string,
  lineCount = REST_OF_FILE,
): Promise<FileRead | { problem: string }> {
  const lines: string[] = [];
  let blob: string | undefined;
  let total: number | undefined;
  while (total === undefined || lines.length < Math.min(total, lineCount)) {
    const result = await calls.text("gh-file", {
      repo,
      path,
      start_line: lines.length + 1,
      line_count: lineCount - lines.length,
    });
    if (result === undefined) return { problem: "the read failed" };
    const head = RANGE_HEAD.exec(result.text);
    if (head === null) return { problem: "the result is not a text file" };
    if (blob !== undefined && head[1] !== blob)
      return { problem: "the file changed while it was read" };
    blob = head[1]!;
    total = Number(head[4]);
    const part = result.text.slice(head[0].length).split("\n");
    // The last element is empty after a final newline, or the line the cut split.
    part.pop();
    if (result.truncated && part.length === 0)
      return { problem: "a single line is longer than the tool's size cap" };
    lines.push(...part);
    if (!result.truncated) break;
  }
  return { blob: blob!, lines, total: total! };
}

export interface DocHead {
  path: string;
  /** The repository the doc describes, from its name: frontmatter. */
  name: string;
  /** The first word of analyzed_commit, a short sha. */
  analyzed: string;
  source: string;
  bytes: number | undefined;
  /** repos/<name>/ exists beside the doc: its section files are read when the doc is refreshed. */
  sectionDir: boolean;
}

export interface SectionFile {
  path: string;
  bytes: number | undefined;
}

/** The folder of a doc's section files: repos/<name>.md keeps them in repos/<name>/. */
export function sectionDirOf(docPath: string): string {
  return docPath.replace(/\.md$/, "");
}

/** The frontmatter keys drift detection reads, from the lines between the first two --- lines. */
export function parseFrontmatter(lines: readonly string[]) {
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end < 0) return undefined;
  const keys = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m !== null) keys.set(m[1]!, m[2]!.trim());
  }
  return keys;
}

/** Every doc under repos/ with the frontmatter drift detection needs. */
export async function readDocHeads(calls: Calls): Promise<DocHead[]> {
  const entries = records(
    await calls.json("gh-file", { repo: ATLAS, path: DOCS_DIR }),
  );
  const dirs = new Set(
    entries.filter((e) => e.type === "dir").map((e) => str(e.path)),
  );
  const listing = entries.filter(
    (e) => e.type === "file" && /\.md$/.test(str(e.name)),
  );
  // No docs is never a quiet day: the listing failed, and the run must say so.
  if (listing.length === 0)
    throw new Error(
      `could not list ${ATLAS}/${DOCS_DIR}: ${calls.failures.at(-1) ?? "the listing had no .md files"}`,
    );
  const docs = await pool(listing, POOL, async (entry) => {
    const path = str(entry.path);
    const read = await readLines(calls, ATLAS, path, FRONTMATTER_LINES);
    if ("problem" in read) {
      calls.record(path, read.problem);
      return undefined;
    }
    const keys = parseFrontmatter(read.lines);
    const name = keys?.get("name") ?? "";
    const analyzed = (keys?.get("analyzed_commit") ?? "").split(/\s+/)[0]!;
    if (keys === undefined || name === "" || analyzed === "") return undefined;
    return {
      path,
      name,
      analyzed,
      source: (keys.get("analysis_source") ?? "").split(/\s+/)[0]!,
      bytes: typeof entry.size === "number" ? entry.size : undefined,
      sectionDir: dirs.has(sectionDirOf(path)),
    } satisfies DocHead;
  });
  return docs
    .filter((d) => d !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ComparedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  previous_path?: string;
  patch?: string;
  patch_cut?: boolean;
}

export interface Comparison {
  total_commits: number;
  commits: { sha: string; date: string; subject: string; author?: string }[];
  commits_left_out: number;
  files: ComparedFile[];
  files_may_be_more: boolean;
  patches_left_out: number;
}

export function asComparison(value: unknown): Comparison | undefined {
  if (!isObject(value) || !Array.isArray(value.files)) return undefined;
  return {
    total_commits: Number(value.total_commits) || 0,
    commits: records(value.commits).map((c) => ({
      sha: str(c.sha),
      date: str(c.date),
      subject: str(c.subject),
      ...(typeof c.author === "string" ? { author: c.author } : {}),
    })),
    commits_left_out: Number(value.commits_left_out) || 0,
    files: records(value.files).map((f) => ({
      path: str(f.path),
      status: str(f.status),
      additions: Number(f.additions) || 0,
      deletions: Number(f.deletions) || 0,
      ...(typeof f.previous_path === "string"
        ? { previous_path: f.previous_path }
        : {}),
      ...(typeof f.patch === "string" ? { patch: f.patch } : {}),
      ...(f.patch_cut === true ? { patch_cut: true } : {}),
    })),
    files_may_be_more: value.files_may_be_more === true,
    patches_left_out: Number(value.patches_left_out) || 0,
  };
}

/** The noise rule of a repository, if it has one. */
export function noiseRuleOf(repo: string): NoiseRule | undefined {
  return NOISE_RULES.find((r) => r.repo === repo);
}

/**
 * Drift that cannot change what a doc says: every changed file of the
 * comparison matches the repository's noise rule. A repository without a
 * rule, a missing comparison, or one that may list more files than it
 * shows, is real drift.
 */
export function isNoise(repo: string, cmp: Comparison | undefined): boolean {
  const rule = noiseRuleOf(repo);
  if (rule === undefined || cmp === undefined) return false;
  if (cmp.files.length === 0 || cmp.files_may_be_more) return false;
  return cmp.files.every((f) => rule.files.test(f.path));
}

async function compare(
  calls: Calls,
  repo: string,
  base: string,
  head: string,
): Promise<Comparison | undefined> {
  return asComparison(
    await calls.json("gh-compare", {
      repo,
      base,
      head,
      patch_lines: PATCH_LINES,
    }),
  );
}

/** The comparison with diffs only while they fit in MAX_PATCH_BYTES, in file order. */
export function trimPatches(
  cmp: Comparison,
  budget = MAX_PATCH_BYTES,
): Comparison {
  let used = 0;
  let leftOut = cmp.patches_left_out;
  const files = cmp.files.map((f) => {
    if (f.patch === undefined) return f;
    const bytes = Buffer.byteLength(f.patch);
    if (used + bytes <= budget) {
      used += bytes;
      return f;
    }
    leftOut += 1;
    const { patch: _patch, patch_cut: _cut, ...rest } = f;
    return rest;
  });
  return { ...cmp, files, patches_left_out: leftOut };
}

export interface Drift {
  doc: DocHead;
  head: { sha: string; date: string };
}

/** The docs whose repository's main moved past analyzed_commit. */
export async function findDrift(
  calls: Calls,
  docs: readonly DocHead[],
): Promise<{ drifted: Drift[]; unresolved: string[]; localStale: number }> {
  const tracked = docs.filter((d) => d.source !== "local-stale");
  const heads = await pool(tracked, POOL, (d) => headOf(calls, d.name));
  const drifted: Drift[] = [];
  const unresolved: string[] = [];
  for (const [i, doc] of tracked.entries()) {
    const head = heads[i];
    if (head === undefined) unresolved.push(doc.name);
    else if (!head.sha.startsWith(doc.analyzed))
      drifted.push({ doc, head: head });
  }
  return {
    drifted,
    unresolved,
    localStale: docs.length - tracked.length,
  };
}

function day(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** What kit code, never the model, writes as a doc's analyzed_commit once it is refreshed or its drift was noise. */
export function stampFor(head: string, now: Date): string {
  return `${head.slice(0, 7)} ${day(now)}`;
}

export interface Refresh extends Drift {
  cmp: Comparison;
  sections: SectionFile[];
}

/** The doc's section files (repos/<name>/<section>.md for a section that may move there, in template order), or undefined when the folder cannot be listed. */
export async function listSections(
  calls: Calls,
  doc: DocHead,
): Promise<SectionFile[] | undefined> {
  if (!doc.sectionDir) return [];
  const listed = await calls.json("gh-file", {
    repo: ATLAS,
    path: sectionDirOf(doc.path),
  });
  if (!Array.isArray(listed)) return undefined;
  const files = new Map(
    records(listed)
      .filter((e) => e.type === "file")
      .map((e) => [str(e.name), e]),
  );
  return SECTION_FILES.flatMap((id) => {
    const e = files.get(`${id}.md`);
    return e === undefined
      ? []
      : [
          {
            path: str(e.path),
            bytes: typeof e.size === "number" ? e.size : undefined,
          },
        ];
  });
}

/** The doc and its section files together, as the run's byte limit counts them. */
function refreshBytes(doc: DocHead, sections: readonly SectionFile[]): number {
  return (doc.bytes ?? 0) + sections.reduce((n, s) => n + (s.bytes ?? 0), 0);
}

/** The doc, then its section files: the order the model gets them in. */
function pathsOf(r: Refresh): string[] {
  return [r.doc.path, ...r.sections.map((s) => s.path)];
}

/** A page's size and, where one page's size decides it, its atlas budget. */
export function pageBudget(path: string, lines: readonly string[]) {
  const bytes = lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  const max =
    path in PAGE_BUDGETS
      ? PAGE_BUDGETS[path as keyof typeof PAGE_BUDGETS]
      : new RegExp(`^${DOCS_DIR}/[^/]+\\.md$`).test(path)
        ? PAGE_BUDGETS.doc
        : new RegExp(`^${DOCS_DIR}/[^/]+/[^/]+\\.md$`).test(path)
          ? PAGE_BUDGETS.sectionFile
          : undefined;
  return { path, bytes, ...(max === undefined ? {} : { max_bytes: max }) };
}

/** The removed and added lines of each file's diff, as a commit source shows them, so the second check sees what a change added and not only the file after it. */
export function patchExcerpt(files: readonly ComparedFile[]) {
  return files.flatMap((f) => {
    if (f.patch === undefined) return [];
    const removed: string[] = [];
    const added: string[] = [];
    for (const line of f.patch.split("\n")) {
      if (line.startsWith("+")) added.push(line.slice(1));
      else if (line.startsWith("-")) removed.push(line.slice(1));
    }
    return removed.length + added.length === 0
      ? []
      : [{ path: f.path, removed, added }];
  });
}

/** The input's sources for one refresh: all its changes at the new head, and each commit on its own. */
export function refreshSources(r: Refresh) {
  const repo = `${ORG}/${r.doc.name}`;
  const authors = [
    ...new Set(r.cmp.commits.flatMap((c) => c.author ?? [])),
  ].sort(byCodePoint);
  return [
    {
      kind: "commit" as const,
      repo,
      commit: r.head.sha,
      date: r.head.date,
      title: `${r.doc.name} ${r.doc.analyzed}..${r.head.sha.slice(0, 7)}: every change since the doc's analyzed_commit (${r.cmp.total_commits} commit${r.cmp.total_commits === 1 ? "" : "s"})`,
      files: r.cmp.files.map((f) => ({ path: f.path, status: f.status })),
      excerpt: patchExcerpt(r.cmp.files),
      ...(authors.length === 0 ? {} : { authors }),
    },
    ...r.cmp.commits.map((c) => ({
      kind: "commit" as const,
      repo,
      commit: c.sha,
      date: c.date,
      title: c.subject,
      files: [],
      excerpt: [],
      ...(c.author === undefined ? {} : { authors: [c.author] }),
    })),
  ];
}

/** The template's style rules: the comment at the top of _TEMPLATE.md. */
export function templateRules(lines: readonly string[]): string[] {
  const end = lines.findIndex((l) => l.trim() === "-->");
  return end < 0 ? [] : lines.slice(0, end + 1);
}

export async function collect(tools: CollectTools, now: Date) {
  const calls = new Calls(tools);
  // Delivery closes the job's earlier open pull request, so a run while one is open would throw away its review.
  const waiting = await openAgentPull(calls, JOB, ATLAS);
  if (waiting !== undefined)
    return {
      generatedAt: now.toISOString(),
      rules: RULES,
      repos: {},
      pages: [],
      sources: [],
      waiting,
      collection: {
        toolCalls: calls.count,
        failedCalls: calls.failures.length,
        failures: calls.failures.slice(0, 10),
      },
    };
  const atlasHead = await headOf(calls, ATLAS);
  if (atlasHead === undefined)
    throw new Error(`cannot read the newest commit of ${ATLAS_REPO}`);

  const docs = await readDocHeads(calls);
  const { drifted, unresolved, localStale } = await findDrift(calls, docs);

  const stamps: {
    repo: string;
    path: string;
    commit: string;
    key: typeof STAMP_KEY;
    value: string;
    why: string;
  }[] = [];
  const stamp = (path: string, head: string, why: string) =>
    stamps.push({
      repo: ATLAS_REPO,
      path,
      commit: atlasHead.sha,
      key: STAMP_KEY,
      value: stampFor(head, now),
      why,
    });
  const deferred: {
    path: string;
    repo: string;
    from: string;
    to: string;
    reason: string;
  }[] = [];
  const deferDrift = (d: Drift, reason: string) =>
    deferred.push({
      path: d.doc.path,
      repo: `${ORG}/${d.doc.name}`,
      from: d.doc.analyzed,
      to: d.head.sha,
      reason,
    });
  const isNoiseDrift = async (d: Drift) => {
    const known =
      noiseRuleOf(d.doc.name) === undefined
        ? undefined
        : await compare(calls, d.doc.name, d.doc.analyzed, d.head.sha);
    if (!isNoise(d.doc.name, known)) return { noise: false, known };
    stamp(
      d.doc.path,
      d.head.sha,
      "noise: only version pins or regenerated data changed",
    );
    return { noise: true, known };
  };

  const given: Refresh[] = [];
  const docLines = new Map<string, string[]>();
  const scrubbed: string[] = [];
  let docBytes = 0;
  let next = 0;
  // Choose docs up to the limit and read them whole; a doc that cannot be given frees its place for the next one.
  while (next < drifted.length) {
    const batch: Refresh[] = [];
    for (
      ;
      next < drifted.length && given.length + batch.length < MAX_REFRESHES;
      next++
    ) {
      const d = drifted[next]!;
      const { noise, known } = await isNoiseDrift(d);
      if (noise) continue;
      const sections = await listSections(calls, d.doc);
      if (sections === undefined) {
        calls.record(sectionDirOf(d.doc.path), "the listing failed");
        deferDrift(d, "its section files could not be listed");
        continue;
      }
      const bytes = refreshBytes(d.doc, sections);
      if (given.length + batch.length > 0 && docBytes + bytes > MAX_DOC_BYTES) {
        deferDrift(d, `the run's limit of ${MAX_DOC_BYTES} bytes of doc text`);
        continue;
      }
      const cmp =
        known ?? (await compare(calls, d.doc.name, d.doc.analyzed, d.head.sha));
      if (cmp === undefined) {
        deferDrift(d, "the comparison of its commits could not be read");
        continue;
      }
      batch.push({ ...d, cmp: trimPatches(cmp), sections });
      docBytes += bytes;
    }
    if (batch.length === 0) break;
    // A doc and its section files are given together or not at all, so a fact is never refreshed in one and left stale in the other.
    const read = await pool(batch, POOL, (r) =>
      Promise.all(pathsOf(r).map((path) => readLines(calls, ATLAS, path))),
    );
    for (const [i, r] of batch.entries()) {
      const files = read[i]!;
      const paths = pathsOf(r);
      const failed = files.findIndex((f) => "problem" in f);
      const hidden = paths.filter((_, j) => {
        const f = files[j]!;
        return !("problem" in f) && isScrubbed(f.lines);
      });
      if (failed >= 0) {
        calls.record(
          paths[failed]!,
          (files[failed] as { problem: string }).problem,
        );
        deferDrift(
          r,
          failed === 0
            ? "the doc could not be read"
            : "one of its section files could not be read",
        );
      } else if (hidden.length > 0) {
        scrubbed.push(...hidden);
        deferDrift(r, SCRUBBED_REASON);
      } else {
        given.push(r);
        for (const [j, path] of paths.entries())
          docLines.set(path, (files[j] as FileRead).lines);
        continue;
      }
      docBytes -= refreshBytes(r.doc, r.sections);
    }
  }
  for (; next < drifted.length; next++) {
    const d = drifted[next]!;
    if (!(await isNoiseDrift(d)).noise)
      deferDrift(d, `the run's limit of ${MAX_REFRESHES} refreshes`);
  }

  const pages: {
    repo: string;
    path: string;
    commit: string;
    lines: string[];
  }[] = given.flatMap((r) =>
    pathsOf(r).map((path) => ({
      repo: ATLAS_REPO,
      path,
      commit: atlasHead.sha,
      lines: docLines.get(path)!,
    })),
  );
  const shared = given.length === 0 ? [] : [...SHARED_PAGES];
  const sharedRead = await pool(shared, POOL, (path) =>
    readLines(calls, ATLAS, path),
  );
  for (const [i, path] of shared.entries()) {
    const r = sharedRead[i]!;
    if ("problem" in r) calls.record(path, r.problem);
    else if (isScrubbed(r.lines)) scrubbed.push(path);
    else
      pages.push({
        repo: ATLAS_REPO,
        path,
        commit: atlasHead.sha,
        lines: r.lines,
      });
  }
  for (const r of given)
    stamp(
      r.doc.path,
      r.head.sha,
      "refresh: set when the answer lists this doc and passes every check",
    );

  const template =
    given.length === 0
      ? undefined
      : await readLines(calls, ATLAS, TEMPLATE_PATH, FRONTMATTER_LINES);
  if (template !== undefined && "problem" in template)
    calls.record(TEMPLATE_PATH, template.problem);

  // Pages pinned at a commit must be that commit's text: main may not move while they are read.
  const atlasAfter = await headOf(calls, ATLAS);
  if (atlasAfter?.sha !== atlasHead.sha)
    throw new Error(
      `${ATLAS_REPO} main moved from ${atlasHead.sha.slice(0, 12)} to ${atlasAfter?.sha.slice(0, 12) ?? "an unreadable commit"} while the docs were read; the next run starts over`,
    );

  const repos: Record<string, string> = { [ATLAS_REPO]: atlasHead.sha };
  for (const r of given) repos[`${ORG}/${r.doc.name}`] = r.head.sha;

  return {
    generatedAt: now.toISOString(),
    rules: RULES,
    repos,
    pages,
    drift: given.map((r) => ({
      path: r.doc.path,
      repo: `${ORG}/${r.doc.name}`,
      from: r.doc.analyzed,
      to: r.head.sha,
      total_commits: r.cmp.total_commits,
      commits: r.cmp.commits,
      commits_left_out: r.cmp.commits_left_out,
      files: r.cmp.files,
      files_may_be_more: r.cmp.files_may_be_more,
      patches_left_out: r.cmp.patches_left_out,
      ...(r.sections.length === 0
        ? {}
        : { section_pages: r.sections.map((s) => s.path) }),
    })),
    sources: given.flatMap(refreshSources),
    budgets: pages.map((p) => pageBudget(p.path, p.lines)),
    stamps,
    deferred,
    atlas_docs: docs.map((d) => d.name),
    template_rules:
      template === undefined || "problem" in template
        ? []
        : templateRules(template.lines),
    coverage: {
      docsRead: docs.length,
      localStale,
      unresolved,
      drifted: drifted.length,
      noise: stamps.length - given.length,
      refreshed: given.length,
      deferred: deferred.length,
      scrubbed,
    },
    collection: {
      toolCalls: calls.count,
      failedCalls: calls.failures.length,
      failures: calls.failures.slice(0, 10),
    },
  };
}

async function main(): Promise<void> {
  const tools = await connectCollectTools();
  try {
    process.stdout.write(
      `${JSON.stringify(await collect(tools, new Date()))}\n`,
    );
  } finally {
    await tools.close();
  }
}

await runMain(import.meta.url, JOB, main);
