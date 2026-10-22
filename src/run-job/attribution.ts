import type { CheckContext, ProposedPage } from "../output-check/pr.ts";
import { repoCitations } from "../output-check/pr.ts";
import { GITHUB_COMPARE_FILES } from "../tools-server/compare.ts";
import {
  HEX,
  landingPull,
  pacificDay,
  PULL_IN_TEXT,
  REPO,
  repoPath,
  SHA_IN_TEXT,
  type GithubJsonReader,
} from "./review-commits.ts";

/** The days a date on a line allows: the days it lists, or every day of a range. */
export type Days = { list: string[] } | { from: string; to: string };

/** A credit on a line: a pull request number or a commit sha, and the repositories it may be in, best first. */
export interface LineCredit {
  repos: string[];
  ref: string;
  start: number;
  end: number;
}

/** One claim of an added line: a `## recent`-style line whole, otherwise one sentence or `;` clause. */
export interface Claim {
  text: string;
  credits: LineCredit[];
  /** The date the claim starts with, held to every credit in it. */
  days?: Days;
  /** Dates next to one credit (by its index), held to that credit. */
  near: { credit: number; days: Days }[];
  /** `merge <sha>` given for the pull request credit at that index. */
  merges: { credit: number; sha: string }[];
  /** Backtick-quoted code identifiers. */
  identifiers: string[];
  /** Backtick-quoted command lines and argument forms, with the literal tokens only code could have written. */
  forms: { text: string; tokens: string[] }[];
}

const LEAD_DATE =
  /^\s*(?:[-*+]\s+|\d+\.\s+)?(?:\*\*|__)?(\d{4}-\d{2}-\d{2}(?:\s*(?:\.\.|–|—|-|to|\/|,|and)\s*\d{4}-\d{2}-\d{2}|\/\d{2}(?!\d))*)(?!\d)/;
const DATE = /(?<![\d-])\d{4}-\d{2}-\d{2}(?!\d)/g;
const MERGE_SHA =
  /\bmerge(?:d(?:\s+as)?|\s+commit)?\s+`?([0-9a-f]{7,40})`?(?![0-9A-Za-z])/g;
/** A hyphenated repository name right before a bare `#<number>`, as in "notes-cli #293". */
const NAME_BEFORE_PULL =
  /(?:^|[\s(])([a-z0-9][a-z0-9._]*-[a-z0-9._-]*[a-z0-9])\s$/;
/** A commit named as a state ("at abc1234", "to abc1234", "repo@abc1234"), not as the change a line describes. */
const STATE_BEFORE = /(?:\b(?:at|to|as of)\s+|@)$/i;
/** A pull request range, as in "#17-#20". */
const PULL_RANGE = /^\s*(?:-|–|\.\.)\s*#?(\d{1,6})(?!\w)/;
const MAX_PULL_RANGE = 20;

function parseDays(text: string): Days {
  const days: string[] = [];
  const gaps: string[] = [];
  let last = 0;
  for (const m of text.matchAll(/\d{4}-\d{2}-\d{2}|(?<=\/)\d{2}(?!\d)/g)) {
    const day = m[0].length === 2 ? `${days.at(-1)!.slice(0, 8)}${m[0]}` : m[0];
    if (days.length > 0) gaps.push(text.slice(last, m.index).trim());
    days.push(day);
    last = m.index + m[0].length;
  }
  if (days.length === 2 && /^(?:\.\.|–|—|-|to)$/.test(gaps[0] ?? ""))
    return { from: days[0]!, to: days[1]! };
  return { list: days };
}

function allows(days: Days, day: string): boolean {
  return "list" in days
    ? days.list.includes(day)
    : days.from <= day && day <= days.to;
}

function showDays(days: Days): string {
  return "list" in days ? days.list.join(" or ") : `${days.from} to ${days.to}`;
}

/** Whether backtick-quoted text is a code identifier: one token, with a letter, no placeholders or globs. */
export function isCodeIdentifier(text: string): boolean {
  return (
    text.length >= 2 &&
    /[A-Za-z]/.test(text) &&
    /^[A-Za-z0-9_.:/@$+=~-]+$/.test(text) &&
    !(HEX.test(text) && /\d/.test(text))
  );
}

/** Backtick text that is a phrase or holds a placeholder: a command line or an argument form, not one identifier. */
export function isPhrase(text: string): boolean {
  return /\S\s+\S/.test(text) || /<[^<>\s][^<>]*>/.test(text);
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const FLAG = /^(--?[A-Za-z][A-Za-z0-9-]+)(?:=.*)?$/;

/**
 * The literal tokens of a quoted command line or argument form that only
 * code could have written: a URL scheme or URL (`docker://`), a flag
 * (`--subject`), a path (`~/.local/bin/notes`) or a name with a dot,
 * underscore, colon, slash, `$`, `=`, `@` or an inner capital
 * (`NOTES_PASS`, `inputs.image`). Placeholders (`<image>`), brackets,
 * quotes, plain and hyphenated words and file paths are not.
 */
export function distinctiveTokens(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.replace(/<[^<>]*>/g, " ").split(/\s+/)) {
    const t = raw
      .replace(/^[[("'{|]+/, "")
      .replace(/[\])"'},;|]+$/, "")
      .replace(/(?<!\.)\.$/, "");
    if (!/[A-Za-z]/.test(t)) continue;
    if (SCHEME.test(t)) {
      out.add(t);
      continue;
    }
    const flag = FLAG.exec(t);
    if (flag !== null) {
      out.add(flag[1]!);
      continue;
    }
    const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
    if (
      isCodeIdentifier(name) &&
      !isFilePath(name) &&
      /[A-Za-z]/.test(name) &&
      (/[/._:$@~]/.test(name) || /[a-z][A-Z]/.test(name))
    )
      out.add(name);
  }
  return [...out];
}

/** The code a text quotes in backticks: its identifiers other than file paths, and the literals of its command lines and argument forms. */
export function quotedCode(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const q = m[1]!;
    if (isCodeIdentifier(q)) {
      if (!isFilePath(q)) out.add(q);
    } else if (isPhrase(q)) for (const t of distinctiveTokens(q)) out.add(t);
  }
  return [...out];
}

const FILE_NAME =
  /(?:^|\/)(?:[\w.-]*\.(?:md|markdown|mdx|txt|rst|adoc|ya?ml|json|jsonc|toml|xml|ini|cfg|conf|properties|env|lock|sbt|gradle|kts?|scala|java|rs|tsx?|[mc]ts|[mc]?js|jsx|svelte|astro|py|go|rb|sh|bash|ps1|sql|proto|tf|hcl|html|css|scss|csv|tsv|svg|png)|(?:Dockerfile|Containerfile|Makefile|Jenkinsfile|LICENSE|CODEOWNERS)(?:\.[\w-]+)?)$/;

/** Whether backtick-quoted text is a file or folder path. A path says where something is, never what a commit changed. */
export function isFilePath(text: string): boolean {
  return (
    !text.includes("://") &&
    (FILE_NAME.test(text) || (text.includes("/") && text.endsWith("/")))
  );
}

/** A claim that something was added, removed or renamed, which only a changed line naming it shows. */
const EXISTENCE =
  /\b(?:add(?:s|ed|ing)?|introduc(?:e|es|ed|ing)|new|creat(?:e|es|ed|ing)|remov(?:e|es|ed|ing|al)|delet(?:e|es|ed|ing|ion)|drop(?:s|ped|ping)?|renam(?:e|es|ed|ing)|gain(?:s|ed)?)\b/i;

const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Whether a diff line's text names an identifier. A one-word lowercase
 * identifier (`image`) counts only where the line uses it as code: right
 * after `.`, `$`, `-`, `/`, `@`, `:`, a quote or an opening bracket, or
 * right before `.`, `(`, `[` or a quote, or before `:` or `=`. Prose and
 * Markdown backticks around the word do not count. Any other identifier
 * counts wherever it stands as a whole token.
 */
export function namesIdentifier(text: string, id: string): boolean {
  const plain = /^[a-z]+$/.test(id);
  for (let at = text.indexOf(id); at >= 0; at = text.indexOf(id, at + 1)) {
    const before = text[at - 1] ?? "";
    const rest = text.slice(at + id.length);
    const after = rest[0] ?? "";
    if (WORD_CHAR.test(id[0]!) && WORD_CHAR.test(before)) continue;
    if (WORD_CHAR.test(id.at(-1)!) && WORD_CHAR.test(after)) continue;
    if (!plain) return true;
    if (before !== "" && /[.$("'[{/@:-]/.test(before)) return true;
    if (/^[.(["']/.test(after) || /^\s*[:=]/.test(rest)) return true;
  }
  return false;
}

/** Splits a line at the end of each sentence and at each `;`, outside brackets and backticks. */
export function clauses(line: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let depth = 0;
  let code = false;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "`") code = !code;
    if (code) continue;
    if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && depth > 0) depth--;
    else if (
      depth === 0 &&
      (ch === ";" || ch === "." || ch === "!" || ch === "?") &&
      (i + 1 === line.length || /\s/.test(line[i + 1]!)) &&
      !/(?:\be\.g|\bi\.e|\betc|\bvs|\bcf)$/i.test(line.slice(0, i))
    ) {
      out.push({ text: line.slice(start, i + 1), start });
      start = i + 1;
    }
  }
  if (line.slice(start).trim() !== "")
    out.push({ text: line.slice(start), start });
  return out;
}

/** Normalized text, for finding a claim the page already made. */
const norm = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The claims of one added line that credit something. A line starting
 * with a date (a `## recent`-style line) is one claim, the date held to
 * every credit on it; any other line is a claim per sentence or `;`
 * clause, and a clause starting with a date holds that date to its
 * credits. A date elsewhere is held to the credit it stands next to (at
 * most three words between). Commit ranges (`a..b`) are not credits.
 */
export function claimsOf(
  line: string,
  cited: readonly string[],
  owner: string,
  targets: readonly string[],
): Claim[] {
  const whole = LEAD_DATE.exec(line);
  const parts = whole === null ? clauses(line) : [{ text: line, start: 0 }];
  const out: Claim[] = [];
  for (const part of parts) {
    const text = part.text;
    const lead = whole === null ? LEAD_DATE.exec(text) : whole;
    const leadEnd = lead === null ? 0 : lead.index + lead[0].length;
    const credits = creditsIn(text, cited, owner, targets);
    if (credits.length === 0) continue;
    const near: Claim["near"] = [];
    for (const m of text.matchAll(DATE)) {
      if (m.index < leadEnd) continue;
      const dayEnd = m.index + m[0].length;
      let best: { credit: number; gap: string; distance: number } | undefined;
      credits.forEach((c, i) => {
        const gap =
          c.start >= dayEnd
            ? text.slice(dayEnd, c.start)
            : c.end <= m.index
              ? text.slice(c.end, m.index)
              : undefined;
        if (gap === undefined) return;
        if (best === undefined || gap.length < best.distance)
          best = { credit: i, gap, distance: gap.length };
      });
      const words = (best?.gap ?? "")
        .split(/\s+/)
        .filter((w) => /[A-Za-z0-9]/.test(w));
      if (best !== undefined && words.length <= 3)
        near.push({ credit: best.credit, days: { list: [m[0]] } });
    }
    const merges: Claim["merges"] = [];
    for (const m of text.matchAll(MERGE_SHA)) {
      let best: { credit: number; distance: number } | undefined;
      credits.forEach((c, i) => {
        if (!c.ref.startsWith("#")) return;
        const distance = Math.abs(c.start - m.index);
        if (best === undefined || distance < best.distance)
          best = { credit: i, distance };
      });
      if (best !== undefined) merges.push({ credit: best.credit, sha: m[1]! });
    }
    const quoted = [
      ...new Set([...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)),
    ];
    const identifiers = quoted.filter(isCodeIdentifier);
    const forms = quoted
      .filter((q) => !isCodeIdentifier(q) && isPhrase(q))
      .map((q) => ({ text: q, tokens: distinctiveTokens(q) }))
      .filter((f) => f.tokens.length > 0);
    out.push({
      text,
      credits,
      ...(lead === null ? {} : { days: parseDays(lead[1]!) }),
      near,
      merges,
      identifiers,
      forms,
    });
  }
  return out;
}

function creditsIn(
  text: string,
  cited: readonly string[],
  owner: string,
  targets: readonly string[],
): LineCredit[] {
  const out: LineCredit[] = [];
  const add = (c: LineCredit) => {
    if (
      !out.some(
        (o) => o.ref === c.ref && o.repos.join(",") === c.repos.join(","),
      )
    )
      out.push(c);
  };
  if (cited.length > 0)
    for (const m of text.matchAll(SHA_IN_TEXT)) {
      const end = m.index + m[0].length;
      if (!/\d/.test(m[0])) continue;
      if (
        text.slice(end, end + 2) === ".." ||
        text.slice(m.index - 2, m.index) === ".." ||
        STATE_BEFORE.test(text.slice(0, m.index))
      )
        continue;
      add({ repos: [...cited], ref: m[0], start: m.index, end });
    }
  for (const m of text.matchAll(PULL_IN_TEXT)) {
    const end = m.index + m[0].length;
    let where: string[];
    if (m[1] !== undefined) {
      const named = `${owner}/${m[1]}`;
      where = REPO.test(named) && !targets.includes(named) ? [named] : [];
    } else {
      const name = NAME_BEFORE_PULL.exec(text.slice(0, m.index))?.[1];
      const named = name === undefined ? undefined : `${owner}/${name}`;
      where =
        named !== undefined && REPO.test(named) && !targets.includes(named)
          ? [named, ...cited.filter((r) => r !== named)]
          : [...cited];
    }
    if (where.length === 0) continue;
    const n = Number(m[2]);
    add({ repos: where, ref: `#${n}`, start: m.index, end });
    const range = PULL_RANGE.exec(text.slice(end));
    const last = range === null ? n : Number(range[1]);
    if (last > n && last - n <= MAX_PULL_RANGE)
      for (let k = n + 1; k <= last; k++)
        add({ repos: where, ref: `#${k}`, start: m.index, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** A credited change as GitHub has it: when it landed, what is wrong with the credit itself, and its diff's changed lines. */
interface Resolved {
  label: string;
  /** GitHub has it in none of the repositories. */
  missing?: true;
  error?: string;
  problems: string[];
  pull?: { number: number; merge?: string };
  landedAt?: string;
  landedBy?: "merged" | "committed";
  /** Added and removed lines of its diff against its first parent (a merge commit's: the whole pull request). */
  changed?: string[];
  /** The paths of the files it changed, old and new. */
  paths?: string[];
  /** YAML or JSON keys with an added or removed line inside their block. */
  keyed?: Set<string>;
  /** Why the diff is not whole: files GitHub did not list or gave no diff for. */
  cut?: string[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** A YAML or JSON key line: `image:`, `- name: x`, `"image": {`. */
const KEY_LINE =
  /^(\s*(?:-\s+)?)(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2\s*:(?:\s|$)/;

/** Adds the keys of one file's patch that have an added or removed line inside their block, by indentation. */
function keysTouched(patch: string, into: Set<string>): void {
  let open: { column: number; key: string }[] = [];
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      open = [];
      continue;
    }
    const mark = raw[0];
    if (mark !== " " && mark !== "+" && mark !== "-") continue;
    const text = raw.slice(1);
    if (text.trim() === "") continue;
    const indent = text.length - text.trimStart().length;
    open = open.filter((o) => o.column < indent);
    if (mark !== " ") for (const o of open) into.add(o.key);
    const key = KEY_LINE.exec(text);
    if (key !== null) open.push({ column: key[1]!.length, key: key[3]! });
  }
}

function changedLines(
  files: readonly unknown[],
): Pick<Resolved, "changed" | "paths" | "cut" | "keyed"> {
  const keyed = new Set<string>();
  const changed: string[] = [];
  const paths: string[] = [];
  const cut: string[] = [];
  if (files.length >= GITHUB_COMPARE_FILES)
    cut.push(`GitHub lists at most ${GITHUB_COMPARE_FILES} files`);
  for (const f of files.map(record)) {
    paths.push(
      ...[str(f.filename), str(f.previous_filename)].filter((p) => p !== ""),
    );
    const patch = f.patch;
    const counted =
      (typeof f.additions === "number" ? f.additions : 0) +
      (typeof f.deletions === "number" ? f.deletions : 0);
    if (typeof patch !== "string") {
      if (counted > 0) cut.push(`no diff shown for ${str(f.filename)}`);
      continue;
    }
    keysTouched(patch, keyed);
    for (const l of patch.split("\n"))
      if (l.startsWith("+") || l.startsWith("-")) changed.push(l.slice(1));
  }
  return { changed, paths, cut, keyed };
}

/** A coordinate such as `group:artifact` is named when each of its parts is; a URL scheme (`docker://`) is one part. */
export function partsOf(id: string): string[] {
  if (id.includes("://")) return [id];
  const parts = id.split(":").filter((p) => p.length >= 2);
  return parts.length > 1 ? parts : [id];
}

/** Whether a changed file's path is the identifier: the file, a folder of it, or its name. */
function pathNames(path: string, id: string): boolean {
  const name = id.replace(/^\.\//, "").replace(/\/$/, "");
  return (
    name !== "" &&
    (path === name ||
      path.endsWith(`/${name}`) ||
      path.startsWith(`${name}/`) ||
      path.includes(`/${name}/`))
  );
}

/**
 * Reads credits from GitHub through the same paths the second check's
 * credited commits use (a pull request, its merge commit, the commit's
 * pull requests, the comparison of a merge commit with its first parent),
 * so a run reads each once when the reader is shared.
 */
function resolver(read: GithubJsonReader) {
  const cache = new Map<string, Promise<Resolved>>();

  const diffOf = async (
    repo: string,
    sha: string,
    body: Record<string, unknown>,
  ): Promise<Pick<Resolved, "changed" | "paths" | "cut" | "keyed">> => {
    const parents = (Array.isArray(body.parents) ? body.parents : [])
      .map((p) => str(record(p).sha))
      .filter((p) => HEX.test(p));
    const raw =
      parents.length > 1
        ? await read(`${repoPath(repo)}/compare/${parents[0]}...${sha}`)
        : { files: body.files };
    if (raw === undefined)
      return {
        changed: [],
        cut: ["GitHub has no comparison with its first parent"],
      };
    const files = record(raw).files;
    return changedLines(Array.isArray(files) ? files : []);
  };

  const pullIn = async (
    repo: string,
    n: string,
  ): Promise<Resolved | undefined> => {
    const raw = await read(`${repoPath(repo)}/pulls/${n}`);
    if (raw === undefined) return undefined;
    const p = record(raw);
    const label = `${repo}#${n}`;
    const merged = str(p.merged_at);
    const merge = str(p.merge_commit_sha);
    const base = record(p.base);
    const into = str(base.ref);
    const main = str(record(base.repo).default_branch);
    if (merged === "")
      return { label, problems: [`credits ${label}, which is not merged`] };
    const out: Resolved = {
      label,
      problems:
        main !== "" && into !== main
          ? [
              `credits ${label}, which merged into ${into}, not the default branch ${main}`,
            ]
          : [],
      pull: { number: Number(n), ...(HEX.test(merge) ? { merge } : {}) },
      landedAt: merged,
      landedBy: "merged",
    };
    if (!HEX.test(merge))
      return { ...out, cut: ["GitHub names no merge commit"] };
    const commit = await read(`${repoPath(repo)}/commits/${merge}`);
    if (commit === undefined)
      return { ...out, cut: ["GitHub does not have its merge commit"] };
    return { ...out, ...(await diffOf(repo, merge, record(commit))) };
  };

  const commitIn = async (
    repo: string,
    ref: string,
  ): Promise<Resolved | undefined> => {
    const raw = await read(`${repoPath(repo)}/commits/${ref}`);
    if (raw === undefined) return undefined;
    const body = record(raw);
    const sha = str(body.sha);
    if (!/^[0-9a-f]{40}$/.test(sha)) return undefined;
    const label = `${repo}@${ref}`;
    const out: Resolved = { label, problems: [] };
    const pulls = await read(`${repoPath(repo)}/commits/${sha}/pulls`);
    const onMain = (Array.isArray(pulls) ? pulls : [])
      .map(record)
      .some(
        (p) =>
          str(p.merged_at) !== "" &&
          str(record(p.base).ref) ===
            str(record(record(p.base).repo).default_branch),
      );
    const landing = onMain ? landingPull(pulls) : undefined;
    if (landing?.merged_at) {
      out.landedAt = landing.merged_at;
      out.landedBy = "merged";
    } else {
      // A commit no merged pull request brought to the default branch counts when it is on it: pushed there directly.
      const main = str(record(await read(repoPath(repo))).default_branch);
      const cmp =
        main === ""
          ? undefined
          : await read(
              `${repoPath(repo)}/compare/${encodeURIComponent(main)}...${sha}`,
            );
      const status = str(record(cmp).status);
      if (status === "behind" || status === "identical") {
        out.landedAt = str(record(record(body.commit).committer).date);
        out.landedBy = "committed";
      } else
        out.problems.push(
          `credits ${label}, which is not on the default branch${main === "" ? "" : ` ${main}`}`,
        );
    }
    return { ...out, ...(await diffOf(repo, sha, body)) };
  };

  return (credit: LineCredit): Promise<Resolved> => {
    const key = `${credit.repos.join(",")}@${credit.ref}`;
    let got = cache.get(key);
    if (got === undefined) {
      got = (async (): Promise<Resolved> => {
        for (const repo of credit.repos) {
          const label = credit.ref.startsWith("#")
            ? `${repo}${credit.ref}`
            : `${repo}@${credit.ref}`;
          try {
            const found = credit.ref.startsWith("#")
              ? await pullIn(repo, credit.ref.slice(1))
              : await commitIn(repo, credit.ref);
            if (found !== undefined) return found;
          } catch (err) {
            return {
              label,
              problems: [],
              error: (err as Error).message.split("\n")[0]!,
            };
          }
        }
        return {
          label: credit.ref,
          missing: true,
          problems: [],
        };
      })();
      cache.set(key, got);
    }
    return got;
  };
}

function excerpt(text: string): string {
  const t = norm(text);
  return t.length <= 80 ? t : `${t.slice(0, 77)}...`;
}

/** What is wrong with one claim's credits, read from GitHub. */
async function claimProblems(
  claim: Claim,
  resolve: (c: LineCredit) => Promise<Resolved>,
): Promise<string[]> {
  const problems: string[] = [];
  const resolved = await Promise.all(claim.credits.map(resolve));
  resolved.forEach((r, i) => {
    const credit = claim.credits[i]!;
    if (r.error !== undefined)
      problems.push(
        `could not read ${r.label} from GitHub to check the credit (${r.error})`,
      );
    else if (r.missing === true) {
      if (/[a-f#]/.test(credit.ref))
        problems.push(
          `credits ${credit.ref}, which ${credit.repos.join(" and ")} ${credit.repos.length === 1 ? "does" : "do"} not have`,
        );
    }
    problems.push(...r.problems);
  });
  for (const m of claim.merges) {
    const r = resolved[m.credit]!;
    const merge = r.pull?.merge;
    if (merge !== undefined && !merge.startsWith(m.sha))
      problems.push(
        `names merge ${m.sha} for ${r.label}, whose merge commit is ${merge.slice(0, 7)}`,
      );
  }
  // Credits that landed together (a pull request, its merge commit, its commits) share one problem.
  const misdated = new Map<string, string[]>();
  const dated = (i: number, days: Days) => {
    const r = resolved[i]!;
    if (r.landedAt === undefined) return;
    const day = pacificDay(r.landedAt);
    if (day === undefined || allows(days, day)) return;
    const key = `${showDays(days)}, but ${"\u0000"}landed on ${day} in America/Los_Angeles (${r.landedBy} ${r.landedAt})`;
    const labels = misdated.get(key) ?? [];
    if (!labels.includes(r.label)) labels.push(r.label);
    misdated.set(key, labels);
  };
  if (claim.days !== undefined)
    claim.credits.forEach((_, i) => dated(i, claim.days!));
  for (const n of claim.near) dated(n.credit, n.days);
  for (const [key, labels] of misdated)
    problems.push(
      `dates ${labels.join(", ")} ${key.replace("\u0000", labels.length === 1 ? "it " : "they ")}`,
    );
  const diffs = resolved.filter(
    (r) => r.changed !== undefined || r.cut !== undefined,
  );
  if (diffs.length > 0) {
    const labels = diffs.map((r) => r.label).join(", ");
    const cut = diffs.filter((r) => (r.cut ?? []).length > 0);
    const existence = EXISTENCE.test(claim.text);
    const named = (id: string) =>
      diffs.some(
        (r) =>
          (r.paths ?? []).some((p) => pathNames(p, id)) ||
          partsOf(id).every((part) =>
            (r.changed ?? []).some((l) => namesIdentifier(l, part)),
          ) ||
          (!existence && (r.keyed?.has(id) ?? false)),
      );
    const whose = diffs.length === 1 ? "its diff" : "their diffs";
    for (const id of claim.identifiers) {
      if (isFilePath(id) || named(id)) continue;
      problems.push(
        cut.length === 0
          ? `credits ${labels} with \`${id}\`, which no added or removed line of ${whose} names (unchanged lines do not count)`
          : `credits ${labels} with \`${id}\`, which no added or removed line shown names, and the diff of ${cut.map((r) => `${r.label} (${r.cut!.join("; ")})`).join(", ")} is not whole, so the credit is unverifiable`,
      );
    }
    // A quoted command line or argument form is credited when a changed line has one of its literal tokens.
    for (const form of claim.forms) {
      if (form.tokens.some(named)) continue;
      const tokens = form.tokens.map((t) => `\`${t}\``).join(", ");
      problems.push(
        cut.length === 0
          ? `credits ${labels} with \`${form.text}\`, but no added or removed line of ${whose} names ${form.tokens.length === 1 ? "its literal" : "any of its literals"} ${tokens} (unchanged lines do not count)`
          : `credits ${labels} with \`${form.text}\`, but no added or removed line shown names ${form.tokens.length === 1 ? "its literal" : "any of its literals"} ${tokens}, and the diff of ${cut.map((r) => `${r.label} (${r.cut!.join("; ")})`).join(", ")} is not whole, so the credit is unverifiable`,
      );
    }
  }
  return problems.map((p) => `"${excerpt(claim.text)}": ${p}`);
}

/**
 * The attribution check: for every claim of an added line that credits a
 * commit or pull request (a claim the page's removed lines already make,
 * word for word, is not new and is skipped), GitHub must show that each
 * credit landed on the default branch (a pull request merged into it, a
 * commit brought by such a pull request or pushed there), that a
 * `merge <sha>` given is its pull request's merge commit, that a date on
 * the claim is the day it landed in America/Los_Angeles, and that every
 * code identifier the claim quotes is on an added or removed line of a
 * credited diff. A file path the claim quotes is not checked: only shas
 * and pull request numbers credit. A claim that does not say anything was
 * added, removed or renamed also holds for a YAML or JSON key with a
 * changed line inside its block, as when a pull request changes what an
 * existing input does. Returns the problems per page (`repo/path`); a
 * page with none is not listed.
 */
export async function attributionProblems(
  pages: readonly ProposedPage[],
  context: CheckContext,
  read: GithubJsonReader,
): Promise<Map<string, string[]>> {
  const resolve = resolver(read);
  const targets = context.policy.repos;
  const out = new Map<string, string[]>();
  for (const page of pages) {
    if (page.decision !== "patch") continue;
    const before = new Set<string>();
    for (const change of page.changes ?? [])
      for (const line of change.removed) {
        before.add(norm(line));
        for (const c of clauses(line)) before.add(norm(c.text));
      }
    const problems = new Set<string>();
    for (const change of page.changes ?? []) {
      const cited = [
        ...new Set(
          repoCitations(change.evidence)
            .map((c) => c.repo)
            .filter((r) => REPO.test(r) && !targets.includes(r)),
        ),
      ];
      const owner = (cited[0] ?? targets[0] ?? "").split("/")[0]!;
      for (const line of change.added)
        for (const claim of claimsOf(line, cited, owner, targets)) {
          if (before.has(norm(claim.text))) continue;
          for (const p of await claimProblems(claim, resolve)) problems.add(p);
        }
    }
    if (problems.size > 0) out.set(`${page.repo}/${page.path}`, [...problems]);
  }
  return out;
}
