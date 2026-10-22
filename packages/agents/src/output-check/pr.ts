import { workspace } from "../lib/workspace.ts";
import { createAjv, describeErrors } from "../lib/ajv.ts";
import {
  PATCH_SET_SCHEMA,
  PATCH_SET_TOOL_QUOTES_SCHEMA,
} from "../lib/schemas.ts";
import type { LinkHosts } from "../lib/link-hosts.ts";
import type { RepoCode } from "../lib/allowlists.ts";
import { mediaPathProblem, type MediaFile } from "../lib/media.ts";
import {
  applyHunks,
  parseUnifiedDiff,
  type FileDiff,
  type Hunk,
} from "./diff.ts";
import { isPlainRelativePath, matchesAnyGlob } from "./glob.ts";
import { linkProblems, shippedLinkHosts, type AddedLine } from "./links.ts";
import { CODE_PATH, literalOnlyProblems } from "./literals.ts";
import { DATA_PATH, dataValueProblems } from "./data-values.ts";
import { languageOf } from "./string-literals.ts";
import { quoteProblem, type ToolResultText } from "../run-job/evidence.ts";
import {
  componentProblem,
  manualWordingProblems,
  MDX_PATH,
} from "./docs-components.ts";

/** What a job may change: the pr output fields of job.yml, or a replay's rules. */
export interface PrPolicy {
  repos: readonly string[];
  paths: readonly string[];
  maxChangedLines: number;
  /** Frontmatter keys this job may change, with evidence like any other line; every other key stays as it is. */
  frontmatterKeys?: readonly string[];
  /** Frontmatter keys only the job's code sets, through the input's stamps; the model may not change them. */
  stampKeys?: readonly string[];
  /** In a YAML or JSON file, the keys whose values a patch may change; every other value, every key, the shape and the comments stay as they are. Not checked when not set. */
  dataKeys?: readonly string[];
  /** The organization team asked to review every new pull request, by its slug. */
  reviewTeam?: string;
  /** Globs of files the job's media stage may write (media.pr_paths); none when not set. */
  mediaPaths?: readonly string[];
  /** Globs a pull request's changed paths must all match for delivery to merge it (output.auto_merge.paths); never merged when not set. */
  autoMergePaths?: readonly string[];
  /** New files a patch may create (output.new_files): at most max, each under one of paths; none when not set. */
  newFiles?: { max: number; paths: readonly string[] };
  /** A change may cite a quote of a tool result (output.tool_citations); off when not set. */
  toolCitations?: boolean;
  /**
   * The job fixes code (output.code_fix), with each repository's code
   * settings from repos.yml: a change may cite the code it changes, a page
   * must be inside its repository's code paths (a created one inside its
   * tests) and never a build or deployment file, and a code file may
   * change beyond its literal values. Off when not set.
   */
  codeFix?: { repos: Readonly<Record<string, RepoCode>> };
  /** Every pull request the job opens is a draft (output.draft); off when not set. */
  draft?: boolean;
}

/** A page as the run saw it: its lines at one commit, without the final newline. */
export interface PinnedPage {
  repo: string;
  commit: string;
  path: string;
  lines: readonly string[];
  /** The file is not there at commit (lines is empty): only a patch that creates it may name it (output.new_files). */
  absent?: boolean;
}

/** A primary source given to the run; when a run has a list of them, every citation must point into it. */
export type Source =
  | {
      kind: "code";
      repo: string;
      commit: string;
      path: string;
      start_line: number;
      lines: readonly string[];
    }
  | {
      kind: "search";
      repo: string;
      commit: string;
      over: "content" | "paths";
      paths: readonly string[];
      pattern: string;
      matches: readonly string[];
    }
  | {
      kind: "commit";
      repo: string;
      commit: string;
      date: string;
      title: string;
      files: readonly { path: string; status: string }[];
      excerpt: readonly {
        path: string;
        removed: readonly string[];
        added: readonly string[];
      }[];
      /** GitHub logins of the people who made the change; delivery asks them to review, and they are never evidence. */
      authors?: readonly string[];
    }
  | {
      /** A reviewer's request on the pull request a revision changes; cited as review/<id> and a line of its text. */
      kind: "review";
      repo: string;
      commit: string;
      id: string;
      author: string;
      url: string;
      lines: readonly string[];
    };

/** The path a citation of a review request uses. */
export const REVIEW_PATH_PREFIX = "review/";

/** The dashboard's navigation source and routes; when a run had it, the UI labels and dashboard paths a patch writes must be in it. */
export interface UiSource {
  repo: string;
  commit: string;
  files: readonly { path: string; lines: readonly string[] }[];
  /** SvelteKit route patterns, such as /app/[project_uuid=uuid]/setup. */
  routes: readonly string[];
}

/** The run's media files a pull request may carry, and where. */
export interface MediaContext {
  /** The job's media.pr_paths. */
  paths: readonly string[];
  /** The files of the run's checked media.json. */
  files: readonly MediaFile[];
}

export interface CheckContext {
  policy: PrPolicy;
  pinned: readonly PinnedPage[];
  sources?: readonly Source[];
  ui?: UiSource;
  /** The hosts added links may point to; the committed link-hosts.yml when not given. */
  links?: LinkHosts;
  /** Set when the job's media stage made files a pull request may carry. */
  media?: MediaContext;
  /**
   * The answer was built by the job's own code (model: none), not by a
   * model: its lines need no evidence, and only such an answer may carry
   * media files. Every other rule holds.
   */
  builtByCode?: boolean;
  /**
   * For a job with output.tool_citations: the tools a quote may name and
   * what they returned in the run. Without results (a stub run, or a report
   * checked again later) the quotes are not looked up.
   */
  toolQuotes?: {
    tools: readonly string[];
    results?: readonly ToolResultText[];
  };
}

export interface Citation {
  repo: string;
  path?: string;
  line?: number;
  commit?: string;
}

/** A quote of what a tool returned in the run, cited as evidence (output.tool_citations). */
export interface ToolQuote {
  tool: string;
  quote: string;
}

/** What a change may cite: a primary source in a repository, or, for a job that takes them, a quote of a tool result. */
export type Evidence = Citation | ToolQuote;

export function isToolQuote(e: Evidence): e is ToolQuote {
  return typeof (e as { tool?: unknown }).tool === "string";
}

/** The citations of a list of evidence that point into a repository. */
export function repoCitations(evidence: readonly Evidence[]): Citation[] {
  return evidence.filter((e): e is Citation => !isToolQuote(e));
}

export interface Change {
  removed: string[];
  added: string[];
  evidence: Evidence[];
  why?: string;
}

/** A media file a pull request writes byte for byte as media.ts wrote it. */
export interface ProposedMedia {
  repo: string;
  /** Where it goes in the repository. */
  path: string;
  /** Its path in media.json. */
  file: string;
  /** What the job's code says changed in it, for the pull request body. */
  change?: MediaChange;
}

/** How a media file changed, as the job's code describes it: plain lines, and whether the repository has an earlier version to show beside it. */
export interface MediaChange {
  lines: string[];
  before: boolean;
}

export const MAX_MEDIA_CHANGE_LINES = 20;
export const MAX_MEDIA_CHANGE_CHARS = 400;

function mediaChangeProblem(change: unknown): string | undefined {
  if (typeof change !== "object" || change === null || Array.isArray(change))
    return "change must be an object of lines and before";
  const c = change as Record<string, unknown>;
  if (Object.keys(c).sort().join(",") !== "before,lines")
    return "change must have exactly lines and before";
  if (typeof c.before !== "boolean")
    return "change.before must be true or false";
  if (
    !Array.isArray(c.lines) ||
    c.lines.length > MAX_MEDIA_CHANGE_LINES ||
    !c.lines.every(
      (l) => typeof l === "string" && l.length <= MAX_MEDIA_CHANGE_CHARS,
    )
  )
    return `change.lines must be at most ${MAX_MEDIA_CHANGE_LINES} strings of at most ${MAX_MEDIA_CHANGE_CHARS} characters`;
  return undefined;
}

export interface ProposedPage {
  repo: string;
  path: string;
  decision: "no_change" | "patch";
  reason: string;
  patch?: string;
  changes?: Change[];
}

export interface PageVerdict {
  repo: string;
  path: string;
  decision: "no_change" | "patch";
  ok: boolean;
  problems: string[];
  changedLines: number;
  /** The patch creates the file (output.new_files); left out otherwise. */
  created?: true;
}

export interface CheckResult {
  ok: boolean;
  /** Problems with the answer as a whole: its shape, repeated pages, the line limit. */
  problems: string[];
  pages: PageVerdict[];
}

/** The atlas describes the code; it is a pointer, never a source. */
export function neverEvidenceRepos(): string[] {
  return workspace().neverEvidenceRepos;
}
export const PROTECTED_FRONTMATTER = ["intent", "audience", "owner"];

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;

type Validator = ReturnType<ReturnType<typeof createAjv>["compile"]>;
let patchSetValidator: Validator | undefined;
let toolQuotesValidator: Validator | undefined;

function validateShape(answer: unknown, toolQuotes = false): string[] {
  const validator = toolQuotes
    ? (toolQuotesValidator ??= createAjv().compile(
        PATCH_SET_TOOL_QUOTES_SCHEMA as object,
      ))
    : (patchSetValidator ??= createAjv().compile(PATCH_SET_SCHEMA));
  if (validator(answer)) return [];
  return describeErrors(validator.errors).map((e) =>
    e.field === undefined ? e.message : `${e.field}: ${e.message}`,
  );
}

function sameCommit(cited: string, full: string): boolean {
  return COMMIT.test(cited) && full.startsWith(cited);
}

function describeCitation(c: Citation): string {
  const where =
    c.path === undefined
      ? ""
      : ` ${c.path}${c.line === undefined ? "" : `:${c.line}`}`;
  return `${c.repo}${where}${c.commit === undefined ? "" : ` @${c.commit}`}`;
}

/** The sources a citation points into. */
export function sourcesFor(c: Citation, sources: readonly Source[]): Source[] {
  return sources.filter((s) => {
    if (s.repo !== c.repo) return false;
    if (c.commit !== undefined && !sameCommit(c.commit, s.commit)) return false;
    switch (s.kind) {
      case "code":
        return (
          c.path === s.path &&
          c.line !== undefined &&
          c.line >= s.start_line &&
          c.line < s.start_line + s.lines.length
        );
      case "commit":
        return (
          c.commit !== undefined &&
          (c.path === undefined || s.files.some((f) => f.path === c.path))
        );
      case "search":
        return (
          c.commit !== undefined &&
          (c.path === undefined ||
            s.paths.some(
              (p) => p === "." || c.path === p || c.path!.startsWith(`${p}/`),
            ))
        );
      case "review":
        return (
          c.path === `${REVIEW_PATH_PREFIX}${s.id}` &&
          c.line !== undefined &&
          c.line >= 1 &&
          c.line <= s.lines.length
        );
    }
  });
}

/** Why a quote of a tool result cannot count as evidence; undefined when it can. */
function toolQuoteProblem(
  q: ToolQuote,
  context: CheckContext,
): string | undefined {
  const label = `the quote of ${q.tool}`;
  if (context.policy.toolCitations !== true || context.toolQuotes === undefined)
    return `${label} is a tool result, which this job does not take as evidence (output.tool_citations)`;
  const why = quoteProblem(
    q.tool,
    q.quote,
    context.toolQuotes.tools,
    context.toolQuotes.results,
  );
  return why === undefined ? undefined : `${label}: ${why}`;
}

/** Why a citation cannot count as evidence; undefined when it can. */
export function citationProblem(
  e: Evidence,
  context: CheckContext,
): string | undefined {
  if (isToolQuote(e)) return toolQuoteProblem(e, context);
  const c = e;
  if (!REPO.test(c.repo)) return `"${c.repo}" is not an owner/name repository`;
  // A reviewer's request is the evidence for the change it asks for, whatever repository it is in.
  if (c.path?.startsWith(REVIEW_PATH_PREFIX) === true)
    return sourcesFor(
      c,
      (context.sources ?? []).filter((s) => s.kind === "review"),
    ).length > 0
      ? undefined
      : `${describeCitation(c)} is not a line of a review request given to the run`;
  if (neverEvidenceRepos().includes(c.repo))
    return `${c.repo} is the atlas, which is never evidence; cite the code or the commit`;
  // A code fix cites the code it changes; documentation never cites the page it maintains.
  if (
    context.policy.codeFix === undefined &&
    context.policy.repos.includes(c.repo) &&
    (c.path === undefined || matchesAnyGlob(c.path, context.policy.paths))
  )
    return `${describeCitation(c)} is documentation this job maintains, not a primary source`;
  if (c.commit !== undefined && !COMMIT.test(c.commit))
    return `commit "${c.commit}" is not 7 to 40 lowercase hex characters`;
  if (c.commit === undefined && (c.path === undefined || c.line === undefined))
    return `${describeCitation(c)} needs a commit, or a path and a line`;
  if (
    context.sources !== undefined &&
    sourcesFor(c, context.sources).length === 0
  )
    return `${describeCitation(c)} is not among the sources given to the run`;
  return undefined;
}

/** The frontmatter block at the top of a page, including its --- lines; empty when there is none. */
export function frontmatter(lines: readonly string[]): string[] {
  if (lines[0] !== "---") return [];
  const end = lines.indexOf("---", 1);
  return end < 0 ? [] : lines.slice(0, end + 1);
}

function frontmatterKeys(block: readonly string[]): Map<string, string> {
  const keys = new Map<string, string>();
  let current: string | undefined;
  for (const line of block.slice(1, -1)) {
    const m = /^([A-Za-z0-9_-]+):/.exec(line);
    if (m !== null) current = m[1]!;
    if (current !== undefined)
      keys.set(current, `${keys.get(current) ?? ""}${line}\n`);
  }
  return keys;
}

function frontmatterProblem(
  before: readonly string[],
  after: readonly string[],
  allowed: readonly string[] = [],
): string | undefined {
  const a = frontmatter(before);
  const b = frontmatter(after);
  if (a.join("\n") === b.join("\n")) return undefined;
  if (a.length === 0) return "adds frontmatter, which no job may do";
  if (b.length === 0) return "removes the frontmatter";
  const ka = frontmatterKeys(a);
  const kb = frontmatterKeys(b);
  const changed = [...new Set([...ka.keys(), ...kb.keys()])]
    .filter((k) => ka.get(k) !== kb.get(k))
    .sort();
  if (
    changed.length > 0 &&
    changed.every(
      (k) => allowed.includes(k) && !PROTECTED_FRONTMATTER.includes(k),
    )
  )
    return undefined;
  const guarded = changed.filter((k) => PROTECTED_FRONTMATTER.includes(k));
  const list = changed.length === 0 ? "its layout" : changed.join(", ");
  return `changes the frontmatter (${list})${guarded.length > 0 ? `, including protected ${guarded.join(", ")}` : ""}; a job may change only the keys in its frontmatter_keys`;
}

/** Whether the job may create a file at this path (output.new_files). */
function mayCreate(path: string, policy: PrPolicy): boolean {
  return (
    policy.newFiles !== undefined &&
    policy.newFiles.max > 0 &&
    matchesAnyGlob(path, policy.newFiles.paths)
  );
}

function fileDiffProblems(
  page: ProposedPage,
  file: FileDiff,
  creates = false,
): string[] {
  const out: string[] = [];
  if (file.oldPath === null && !creates)
    out.push(
      `creates a new file (${file.newPath ?? "?"}); only existing pages may change`,
    );
  if (file.newPath === null)
    out.push(`deletes the file ${file.oldPath ?? "?"}`);
  for (const op of file.fileOps)
    if (!(creates && op === "new file mode"))
      out.push(`changes the file itself (${op}); only its text may change`);
  for (const p of new Set([file.oldPath, file.newPath])) {
    if (p !== null && p !== page.path)
      out.push(
        `the patch changes ${p}, not the page it is listed under (${page.path})`,
      );
  }
  if (file.hunks.length === 0 && out.length === 0)
    out.push("the patch has no hunks");
  return out;
}

/**
 * Files no code fix changes, whatever its globs say: workflows, build and
 * dependency files, lockfiles, container and chart files, database
 * migrations. Each needs a person.
 */
export const NEVER_CODE_FIX =
  /(^|\/)(\.github\/|Dockerfile[^/]*$|[^/]*\.lock$|Cargo\.toml$|build\.rs$|pom\.xml$|build\.sbt$|project\/[^/]+\.(sbt|scala)$|(build|settings)\.gradle(\.kts)?$|package\.json$|pnpm-lock\.yaml$|package-lock\.json$|charts?\/|helm\/|migrations?\/|db\/migration\/)/;

/** Why a code fix may not change or create this page, by its repository's repos.yml code settings and NEVER_CODE_FIX. */
function codeFixPathProblems(
  page: ProposedPage,
  creates: boolean,
  codeFix: NonNullable<PrPolicy["codeFix"]>,
): string[] {
  if (NEVER_CODE_FIX.test(page.path))
    return [
      `${page.path} is a workflow, build, dependency, deployment or migration file, which a code fix never changes`,
    ];
  const code = codeFix.repos[page.repo];
  if (code === undefined)
    return [
      `${page.repo} has no code settings in repos.yml, so this job fixes no code there`,
    ];
  if (!matchesAnyGlob(page.path, code.paths))
    return [
      `${page.path} is outside the code paths repos.yml gives ${page.repo} (${code.paths.join(", ")})`,
    ];
  if (creates && !matchesAnyGlob(page.path, code.tests))
    return [
      `the patch creates ${page.path}, but a code fix creates files only under ${page.repo}'s test paths (${code.tests.join(", ")})`,
    ];
  return [];
}

/** Takes one of each item from bag that matches; returns what could not be taken. */
function takeAll(bag: string[], items: readonly string[]): string[] {
  const missing: string[] = [];
  for (const item of items) {
    const i = bag.indexOf(item.trim());
    if (i < 0) missing.push(item);
    else bag.splice(i, 1);
  }
  return missing;
}

function quote(text: string): string {
  return JSON.stringify(text.length > 100 ? `${text.slice(0, 97)}...` : text);
}

/** A README, an ADR or other documentation in a repository: it can point to a fact but never proves one alone. */
const DOC_PATH =
  /(^|\/)(README[^/]*|CHANGELOG[^/]*)$|(^|\/)(docs?|adrs?|plans)\/|\.(md|mdx|rst|adoc|txt)$/i;

/** A citation of documentation rather than code, a commit or a review request. */
export function isDocCitation(e: Evidence): boolean {
  if (isToolQuote(e)) return false;
  const c = e;
  return (
    c.path !== undefined &&
    !c.path.startsWith(REVIEW_PATH_PREFIX) &&
    DOC_PATH.test(c.path)
  );
}

function evidenceProblems(
  changes: readonly Change[],
  removed: readonly string[],
  added: readonly string[],
  context: CheckContext,
): string[] {
  const out: string[] = [];
  // Blank lines carry no fact, so they need no evidence; they still count toward the line limit.
  const removedBag = removed.map((l) => l.trim()).filter((l) => l !== "");
  const addedBag = added.map((l) => l.trim()).filter((l) => l !== "");
  for (const [j, change] of changes.entries()) {
    const label = `change ${j + 1}`;
    if (change.evidence.length === 0) out.push(`${label} cites no evidence`);
    for (const [k, c] of change.evidence.entries()) {
      const why = citationProblem(c, context);
      if (why !== undefined) out.push(`${label}, evidence ${k + 1}: ${why}`);
    }
    if (
      change.evidence.length > 0 &&
      change.evidence.every((c) => isDocCitation(c))
    )
      out.push(
        `${label} cites only documentation (a README, ADR or docs file); cite the code or a commit that confirms it too`,
      );
    const nonBlank = (lines: readonly string[]) =>
      lines.filter((l) => l.trim() !== "");
    for (const l of takeAll(removedBag, nonBlank(change.removed)))
      out.push(
        `${label} lists a removed line the patch does not remove: ${quote(l)}`,
      );
    for (const l of takeAll(addedBag, nonBlank(change.added)))
      out.push(
        `${label} lists an added line the patch does not add: ${quote(l)}`,
      );
  }
  for (const l of removedBag)
    out.push(`removes a line with no evidence: ${quote(l)}`);
  for (const l of addedBag)
    out.push(`adds a line with no evidence: ${quote(l)}`);
  return out;
}

const BOLD = /\*\*([^*\n]+?)\*\*/g;
/** A bold span that reads as a UI label: one to four words, capitalized, no punctuation. */
const UI_LABEL = /^[A-Z][A-Za-z0-9]*(?:[ -][A-Za-z0-9]+){0,3}$/;
const APP_PATH =
  /(?<![\w./-])(?:https?:\/\/[A-Za-z0-9.-]+)?(\/app(?:\/[A-Za-z0-9_.~:<>{}[\]=-]+)*)(?![A-Za-z0-9_-])/g;

/** The bold UI labels in lines. */
export function uiLabels(lines: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines)
    for (const m of line.matchAll(BOLD)) {
      const label = m[1]!.trim();
      if (UI_LABEL.test(label)) out.add(label);
    }
  return out;
}

const TEST_ID = /data-testid=["']?([A-Za-z0-9_-]+)/g;

/** The dashboard test ids (data-testid) that selectors in lines name. */
export function testIds(lines: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines)
    for (const m of line.matchAll(TEST_ID)) out.add(m[1]!);
  return out;
}

/** The dashboard paths (under /app) in lines, without trailing punctuation or slash. */
export function appPaths(lines: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines)
    for (const m of line.matchAll(APP_PATH))
      out.add(m[1]!.replace(/[.,;:]+$/, "").replace(/(.)\/$/, "$1"));
  return out;
}

/** What a reader can see in source text: element text and quoted strings, whitespace collapsed. */
export function sourceLabels(text: string): Set<string> {
  const out = new Set<string>();
  const add = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    if (t !== "") out.add(t);
  };
  for (const m of text.matchAll(/>([^<>{}]+)</g)) add(m[1]!);
  for (const m of text.matchAll(/"([^"\n]{1,80})"|'([^'\n]{1,80})'/g))
    add(m[1] ?? m[2]!);
  return out;
}

/** Whether one written segment fits a route segment: literal text must match, each [param] takes any text. */
function segmentFits(seg: string, route: string): boolean {
  if (!route.includes("[")) return seg === route;
  const pattern = route
    .split(/(\[[^\]]+\])/)
    .map((part) =>
      /^\[.+\]$/.test(part)
        ? ".+"
        : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${pattern}$`).test(seg);
}

/** Whether a written path, such as /app/<project>/setup, is one of the SvelteKit route patterns. */
export function matchesRoute(path: string, routes: readonly string[]): boolean {
  const segs = path.split("/").filter((s) => s !== "");
  const fits = (route: readonly string[], i: number, j: number): boolean => {
    if (j === route.length) return i === segs.length;
    const r = route[j]!;
    if (/^\[\.\.\..+\]$/.test(r))
      return Array.from({ length: segs.length - i + 1 }, (_, k) => k).some(
        (k) => fits(route, i + k, j + 1),
      );
    if (/^\[\[.+\]\]$/.test(r))
      return (
        fits(route, i, j + 1) || (i < segs.length && fits(route, i + 1, j + 1))
      );
    if (i === segs.length) return false;
    return segmentFits(segs[i]!, r) && fits(route, i + 1, j + 1);
  };
  return routes.some((r) =>
    fits(
      r.split("/").filter((s) => s !== ""),
      0,
      0,
    ),
  );
}

/**
 * UI labels (bold, label-shaped), test ids (data-testid) and dashboard paths
 * that a patch writes and the removed lines did not already have must be in
 * the dashboard source the run was given: element text or a quoted string of
 * its navigation files or of the added lines of a dashboard commit in the
 * sources, or one of its routes.
 */
function uiProblems(
  removed: readonly string[],
  added: readonly string[],
  context: CheckContext,
): string[] {
  const ui = context.ui;
  if (ui === undefined) return [];
  const known = new Set<string>();
  const texts = [
    ...ui.files.map((f) => f.lines.join("\n")),
    ...(context.sources ?? []).flatMap((s) =>
      s.kind === "commit" && s.repo === ui.repo
        ? s.excerpt.map((e) => e.added.join("\n"))
        : [],
    ),
  ];
  for (const t of texts) for (const l of sourceLabels(t)) known.add(l);
  const out: string[] = [];
  const before = uiLabels(removed);
  for (const label of uiLabels(added))
    if (!before.has(label) && !known.has(label))
      out.push(
        `writes the UI label ${quote(label)}, which the dashboard source given to the run (uiSource) does not show`,
      );
  const beforeIds = testIds(removed);
  for (const id of testIds(added))
    if (!beforeIds.has(id) && !known.has(id))
      out.push(
        `selects the test id ${quote(id)}, which the dashboard source given to the run does not show`,
      );
  const beforePaths = appPaths(removed);
  for (const path of appPaths(added))
    if (!beforePaths.has(path) && !matchesRoute(path, ui.routes))
      out.push(
        `writes the dashboard path ${quote(path)}, which is not one of the routes in uiSource`,
      );
  return out;
}

/** The lines hunks add, numbered as in the patched page; at is where applyHunks placed each hunk. */
function addedLines(
  hunks: readonly Hunk[],
  at: readonly number[],
): AddedLine[] {
  const out: AddedLine[] = [];
  let shift = 0;
  for (const [i, hunk] of hunks.entries()) {
    let line = at[i]! + shift + 1;
    for (const l of hunk.lines) {
      if (l.op === "+") out.push({ line, text: l.text });
      if (l.op !== "-") line++;
      shift += l.op === "+" ? 1 : l.op === "-" ? -1 : 0;
    }
  }
  return out;
}

function checkPage(page: ProposedPage, context: CheckContext): PageVerdict {
  const problems: string[] = [];
  let creates = false;
  const verdict = (changedLines = 0): PageVerdict => ({
    repo: page.repo,
    path: page.path,
    decision: page.decision,
    ok: problems.length === 0,
    problems,
    changedLines,
    ...(creates ? { created: true as const } : {}),
  });
  if (!context.policy.repos.includes(page.repo))
    problems.push(`${page.repo} is not a repository this job may change`);
  if (!isPlainRelativePath(page.path))
    problems.push(`"${page.path}" is not a plain relative path`);
  else if (!matchesAnyGlob(page.path, context.policy.paths))
    problems.push(
      `${page.path} is outside the paths this job may change (${context.policy.paths.join(", ")})`,
    );

  const patch = page.patch ?? "";
  const changes = page.changes ?? [];
  if (page.decision === "no_change") {
    if (patch.trim() !== "" || changes.length > 0)
      problems.push("the decision is no_change but it carries a patch");
    return verdict();
  }
  if (patch.trim() === "") {
    problems.push("the decision is patch but there is no patch");
    return verdict();
  }
  const parsed = parseUnifiedDiff(patch);
  if ("error" in parsed) {
    problems.push(`the patch is not a unified diff: ${parsed.error}`);
    return verdict();
  }
  if (parsed.files.length > 1)
    problems.push(
      `the patch holds ${parsed.files.length} file diffs; a page's patch changes that page only`,
    );
  creates =
    parsed.files.length === 1 &&
    parsed.files[0]!.oldPath === null &&
    parsed.files[0]!.newPath === page.path &&
    mayCreate(page.path, context.policy);
  for (const file of parsed.files)
    problems.push(...fileDiffProblems(page, file, creates));
  if (context.policy.codeFix !== undefined)
    problems.push(
      ...codeFixPathProblems(page, creates, context.policy.codeFix),
    );
  const hunkLines = parsed.files.flatMap((f) =>
    f.hunks.flatMap((h) => h.lines),
  );
  const removed = hunkLines.filter((l) => l.op === "-").map((l) => l.text);
  const added = hunkLines.filter((l) => l.op === "+").map((l) => l.text);
  const changedLines = removed.length + added.length;
  if (problems.length > 0) return verdict(changedLines);

  const pinned = context.pinned.find(
    (p) => p.repo === page.repo && p.path === page.path,
  );
  if (pinned === undefined) {
    problems.push(
      "no pinned copy of this page was given to the run, so the patch cannot be checked against it",
    );
    return verdict(changedLines);
  }
  if (pinned.absent === true && !creates) {
    problems.push(
      `${page.path} is not there at ${pinned.commit.slice(0, 12)}, and only a patch that creates it under the paths in output.new_files may name it`,
    );
    return verdict(changedLines);
  }
  if (creates && pinned.absent !== true) {
    problems.push(
      `the patch creates ${page.path}, which the run was not told is absent at ${pinned.commit.slice(0, 12)}`,
    );
    return verdict(changedLines);
  }
  const applied = applyHunks(pinned.lines, parsed.files[0]!.hunks);
  if ("error" in applied) {
    problems.push(`${applied.error} at ${pinned.commit.slice(0, 12)}`);
    return verdict(changedLines);
  }
  if (applied.lines.join("\n") === pinned.lines.join("\n"))
    problems.push("the patch changes nothing");
  else if (applied.lines.every((l) => l.trim() === ""))
    problems.push("the patch empties the page");
  const fm = frontmatterProblem(
    pinned.lines,
    applied.lines,
    context.policy.frontmatterKeys,
  );
  if (fm !== undefined) problems.push(fm);
  if (CODE_PATH.test(page.path) && context.policy.codeFix === undefined)
    problems.push(...literalOnlyProblems(pinned.lines, applied.lines));
  if (DATA_PATH.test(page.path) && context.policy.dataKeys !== undefined)
    problems.push(
      ...dataValueProblems(
        pinned.lines,
        applied.lines,
        context.policy.dataKeys,
      ),
    );
  if (MDX_PATH.test(page.path)) {
    const component = componentProblem(pinned.lines, applied.lines);
    if (component !== undefined) problems.push(component);
    problems.push(
      ...manualWordingProblems(
        page.repo,
        applied.lines,
        addedLines(parsed.files[0]!.hunks, applied.at),
      ),
    );
  }
  if (context.builtByCode !== true)
    problems.push(...evidenceProblems(changes, removed, added, context));
  problems.push(...uiProblems(removed, added, context));
  problems.push(
    ...linkProblems(
      pinned.lines,
      addedLines(parsed.files[0]!.hunks, applied.at),
      context.links ?? shippedLinkHosts(),
      context.policy.codeFix !== undefined &&
        languageOf(page.path) !== undefined
        ? { markdown: false }
        : {},
    ),
  );
  return verdict(changedLines);
}

/**
 * Checks a proposed set of page changes before it may become a pull
 * request: allowed repositories and paths, the changed-line limit per
 * repository, untouched frontmatter, evidence for every changed line, a
 * patch that applies to the pinned page, no new (but as output.new_files
 * allows, on a page the run knows is absent), deleted or renamed files, no added image, URL-loading HTML or link to a host outside
 * link-hosts.yml, in a code file nothing changed but literal values,
 * media files only as mediaProblems allows, on MDX pages no change to a
 * component tag, and on public docs manual chapters none of the manual
 * lint's words. A code fix (policy.codeFix) may change code and cite it,
 * inside its repository's code paths. Building the target repository is
 * not done here.
 */
export function checkPatchSet(
  answer: unknown,
  context: CheckContext,
): CheckResult {
  const { patchSet, media } = splitMedia(answer);
  const shape = validateShape(patchSet, context.policy.toolCitations === true);
  if (shape.length > 0)
    return {
      ok: false,
      problems: shape.map(
        (s) => `the answer does not match the patch-set schema: ${s}`,
      ),
      pages: [],
    };
  const pages = (patchSet as { pages: ProposedPage[] }).pages.map((p) =>
    checkPage(p, context),
  );
  const problems: string[] = mediaProblems(media, pages, context);
  const created = pages.filter((p) => p.ok && p.created === true).length;
  const maxNew = context.policy.newFiles?.max ?? 0;
  if (created > maxNew)
    problems.push(
      `creates ${created} new files, more than the ${maxNew} this job may (output.new_files)`,
    );
  const seen = new Set<string>();
  for (const p of pages) {
    const key = `${p.repo}/${p.path}`;
    if (seen.has(key)) problems.push(`${key} is listed more than once`);
    seen.add(key);
  }
  // Pages with a problem are left out of delivery, so only the others count toward the limit.
  const perRepo = new Map<string, number>();
  for (const p of pages)
    if (p.ok) perRepo.set(p.repo, (perRepo.get(p.repo) ?? 0) + p.changedLines);
  for (const [repo, lines] of perRepo) {
    if (lines > context.policy.maxChangedLines)
      problems.push(
        `${repo}: ${lines} changed lines, more than the limit of ${context.policy.maxChangedLines}`,
      );
  }
  return {
    ok: problems.length === 0 && pages.every((p) => p.ok),
    problems,
    pages,
  };
}

/** The answer without its media entries, which the patch-set schema does not take, and the media entries. */
function splitMedia(answer: unknown): { patchSet: unknown; media: unknown } {
  if (typeof answer !== "object" || answer === null || !("media" in answer))
    return { patchSet: answer, media: undefined };
  const { media, ...rest } = answer as Record<string, unknown>;
  return { patchSet: rest, media };
}

// The media directory's 200 MB still bounds the bytes.
export const MAX_MEDIA_ENTRIES = 200;

/** The media entries of an answer as one checked list, or why they are not one. */
export function proposedMedia(
  answer: unknown,
): ProposedMedia[] | { error: string } {
  const { media } = splitMedia(answer);
  if (media === undefined) return [];
  if (!Array.isArray(media)) return { error: "media is not a list" };
  if (media.length > MAX_MEDIA_ENTRIES)
    return {
      error: `media lists ${media.length} files, more than ${MAX_MEDIA_ENTRIES}`,
    };
  const out: ProposedMedia[] = [];
  for (const [i, m] of media.entries()) {
    const entry = m as Record<string, unknown>;
    if (
      typeof m !== "object" ||
      m === null ||
      Object.keys(entry)
        .filter((k) => k !== "change")
        .sort()
        .join(",") !== "file,path,repo" ||
      !["repo", "path", "file"].every((k) => typeof entry[k] === "string")
    )
      return {
        error: `media[${i}] must be an object of exactly repo, path and file, each a string, and an optional change`,
      };
    const changeProblem =
      "change" in entry ? mediaChangeProblem(entry.change) : undefined;
    if (changeProblem !== undefined)
      return { error: `media[${i}]: ${changeProblem}` };
    out.push(entry as unknown as ProposedMedia);
  }
  return out;
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Media entries may come only from an answer the job's code built, for a
 * job whose media stage made files: each names a file of the run's
 * media.json, goes to a repository the job may change at a path its
 * media.pr_paths allows, keeps the file's extension, and is neither a page
 * of the answer nor listed twice.
 */
function mediaProblems(
  media: unknown,
  pages: readonly PageVerdict[],
  context: CheckContext,
): string[] {
  if (media === undefined) return [];
  if (context.builtByCode !== true)
    return [
      "the answer carries media files, which only an answer the job's code built may do",
    ];
  if (context.media === undefined)
    return [
      "the answer carries media files, but the job lists no media.pr_paths or the run has no media",
    ];
  const entries = proposedMedia({ media });
  if ("error" in entries) return [entries.error];
  const out: string[] = [];
  const seen = new Set(pages.map((p) => `${p.repo}/${p.path}`));
  for (const [i, m] of entries.entries()) {
    const label = `media[${i}] (${m.repo}/${m.path})`;
    if (!context.policy.repos.includes(m.repo))
      out.push(`${label}: ${m.repo} is not a repository this job may change`);
    if (!isPlainRelativePath(m.path))
      out.push(`${label}: "${m.path}" is not a plain relative path`);
    else if (!matchesAnyGlob(m.path, context.media.paths))
      out.push(
        `${label}: outside the paths media files may go (${context.media.paths.join(", ")})`,
      );
    const key = `${m.repo}/${m.path}`;
    if (seen.has(key)) out.push(`${label}: is listed more than once`);
    seen.add(key);
    const pathProblem = mediaPathProblem(m.file);
    const file = context.media.files.find((f) => f.path === m.file);
    if (pathProblem !== undefined)
      out.push(`${label}: file ${m.file} ${pathProblem}`);
    else if (file === undefined)
      out.push(`${label}: ${m.file} is not a file of the run's media.json`);
    else if (extension(m.file) !== extension(m.path))
      out.push(
        `${label}: ${m.file} would change its extension to ${extension(m.path) || "none"}`,
      );
  }
  return out;
}

/** Every problem of a result, one line each, prefixed with the page it belongs to. */
export function resultLines(result: CheckResult): string[] {
  return [
    ...result.problems,
    ...result.pages.flatMap((p) =>
      p.problems.map((m) => `${p.repo}/${p.path}: ${m}`),
    ),
  ];
}
