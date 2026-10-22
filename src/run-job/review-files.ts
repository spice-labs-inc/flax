import type { Change, CheckContext, ProposedPage } from "../output-check/pr.ts";
import {
  isDocCitation,
  isToolQuote,
  repoCitations,
  sourcesFor,
} from "../output-check/pr.ts";
import { clauses, partsOf, quotedCode } from "./attribution.ts";

/** Reads one file of a notes-co repository at a commit; undefined when it does not exist there. */
export type CitedFileReader = (
  repo: string,
  commit: string,
  path: string,
) => Promise<string | undefined>;

/** A file a change cites, as the second check sees it: numbered lines, all of them or the parts the change relies on. */
export interface CitedFile {
  repo: string;
  commit: string;
  path: string;
  /** The file's length in lines; absent when it could not be read. */
  lines?: number;
  /** `all` when every line is shown, `excerpts` when only the parts around what the changes name are. */
  shown?: "all" | "excerpts";
  /** Numbered lines, `<number>: <text>`; `...` marks lines left out. */
  text?: string;
  /** Why the file is not shown: unreadable, missing, or over the review's total size. */
  note?: string;
}

export const MAX_FILE_LINES = 1_000;
export const MAX_FILE_BYTES = 80_000;
/** Cited file content per page: each page is reviewed on its own when the whole proposal is too big, so each gets its own share. */
export const MAX_PAGE_BYTES = 400_000;
export const MAX_FILES = 40;
/** Lines kept on each side of a line that names something a change relies on. */
const CONTEXT_LINES = 15;

interface Wanted {
  repo: string;
  commit: string;
  path: string;
  /** Text of the changes that cite this file: what to look for when it is too big to show whole. */
  needles: Set<string>;
}

/** Identifiers and quoted terms in a change's added and removed lines, worth finding in the file it cites. */
export function needlesOf(lines: readonly string[]): string[] {
  const out = new Set<string>();
  for (const line of lines) {
    for (const m of line.matchAll(/`([^`]{3,80})`/g)) out.add(m[1]!);
    for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_.-]{4,}/g))
      out.add(m[0]);
  }
  return [...out];
}

/** Every file a patch change cites by path into a commit or search source (not a code source, which already carries its lines), once. */
export function wantedFiles(
  pages: readonly ProposedPage[],
  context: CheckContext,
): Wanted[] {
  const byKey = new Map<string, Wanted>();
  for (const page of pages) {
    if (page.decision !== "patch") continue;
    for (const change of page.changes ?? []) {
      const needles = needlesOf([...change.added, ...change.removed]);
      for (const citation of repoCitations(change.evidence)) {
        if (citation.path === undefined || context.sources === undefined)
          continue;
        const resolved = sourcesFor(citation, context.sources);
        if (resolved.some((s) => s.kind === "code")) continue;
        const source = resolved.find(
          (s) => s.kind === "commit" || s.kind === "search",
        );
        if (source === undefined) continue;
        const key = `${citation.repo}@${source.commit}:${citation.path}`;
        let w = byKey.get(key);
        if (w === undefined) {
          w = {
            repo: citation.repo,
            commit: source.commit,
            path: citation.path,
            needles: new Set(),
          };
          byKey.set(key, w);
        }
        for (const n of needles) w.needles.add(n);
      }
    }
  }
  return [...byKey.values()];
}

/** The file's lines numbered from 1, all of them when they fit, otherwise windows around lines naming a needle, within the caps. */
export function trimFile(
  content: string,
  needles: Iterable<string>,
): { text: string; shown: "all" | "excerpts"; lines: number } {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const numbered = lines.map((l, i) => `${i + 1}: ${l}`);
  const whole = numbered.join("\n");
  if (lines.length <= MAX_FILE_LINES && whole.length <= MAX_FILE_BYTES)
    return { text: whole, shown: "all", lines: lines.length };
  const terms = [...needles].filter((n) => n.length >= 4);
  const keep = new Set<number>();
  for (const [i, line] of lines.entries())
    if (terms.some((t) => line.includes(t)))
      for (
        let j = Math.max(0, i - CONTEXT_LINES);
        j <= Math.min(lines.length - 1, i + CONTEXT_LINES);
        j++
      )
        keep.add(j);
  // Nothing found: the start of the file is the best guess.
  if (keep.size === 0)
    for (let j = 0; j < Math.min(lines.length, MAX_FILE_LINES); j++)
      keep.add(j);
  const out: string[] = [];
  let bytes = 0;
  let shownLines = 0;
  let previous = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (shownLines >= MAX_FILE_LINES) break;
    const row = numbered[i]!;
    if (bytes + row.length + 1 > MAX_FILE_BYTES) break;
    if (i !== previous + 1) out.push("...");
    out.push(row);
    bytes += row.length + 1;
    shownLines += 1;
    previous = i;
  }
  if (previous < lines.length - 1) out.push("...");
  return { text: out.join("\n"), shown: "excerpts", lines: lines.length };
}

/**
 * The content of every file the proposal cites by path, read at the cited
 * commit, so the second check can see what the writer read instead of only
 * a file list. Files are read once each, within per-file caps and a budget
 * per page (a file shown for one page counts for every page that cites it);
 * a file that cannot be read is listed with a note instead of failing.
 */
export async function citedFiles(
  pages: readonly ProposedPage[],
  context: CheckContext,
  read: CitedFileReader,
): Promise<CitedFile[]> {
  const byKey = new Map<string, CitedFile>();
  const keyOf = (w: { repo: string; commit: string; path: string }) =>
    `${w.repo}@${w.commit}:${w.path}`;
  const LIMIT =
    "not shown: the review's limit on cited file content was reached";
  for (const page of pages) {
    const wanted = wantedFiles([page], context);
    let total = 0;
    let count = 0;
    for (const w of wanted) {
      const prior = byKey.get(keyOf(w));
      if (prior?.text !== undefined) {
        total += prior.text.length;
        count += 1;
      }
    }
    for (const w of wanted) {
      const key = keyOf(w);
      const prior = byKey.get(key);
      if (prior !== undefined && prior.note !== LIMIT) continue;
      const base = { repo: w.repo, commit: w.commit, path: w.path };
      if (count >= MAX_FILES || total >= MAX_PAGE_BYTES) {
        byKey.set(key, { ...base, note: LIMIT });
        continue;
      }
      let content: string | undefined;
      try {
        content = await read(w.repo, w.commit, w.path);
      } catch (err) {
        byKey.set(key, {
          ...base,
          note: `could not be read: ${(err as Error).message.split("\n")[0]}`,
        });
        continue;
      }
      if (content === undefined) {
        byKey.set(key, { ...base, note: "does not exist at this commit" });
        continue;
      }
      const trimmed = trimFile(content, w.needles);
      if (total + trimmed.text.length > MAX_PAGE_BYTES) {
        byKey.set(key, { ...base, lines: trimmed.lines, note: LIMIT });
        continue;
      }
      total += trimmed.text.length;
      count += 1;
      byKey.set(key, { ...base, ...trimmed });
    }
  }
  return [...byKey.values()];
}

const WORD_CHAR = /[A-Za-z0-9_]/;

/** Whether text has a token whole, not inside a longer name; a coordinate (`group:artifact`) when it has each part. */
export function hasToken(text: string, token: string): boolean {
  return partsOf(token).every((part) => {
    for (
      let at = text.indexOf(part);
      at >= 0;
      at = text.indexOf(part, at + 1)
    ) {
      if (WORD_CHAR.test(part[0]!) && WORD_CHAR.test(text[at - 1] ?? ""))
        continue;
      if (
        WORD_CHAR.test(part.at(-1)!) &&
        WORD_CHAR.test(text[at + part.length] ?? "")
      )
        continue;
      return true;
    }
    return false;
  });
}

/** A clause about what a document itself says ("MAVEN.md still says ..."), for which the document is the evidence. */
const ABOUT_DOCS =
  /(?:\bREADME[\w.-]*|[\w./-]+\.(?:md|mdx|rst|adoc|txt))\b[^;]*?\b(?:says?|said|states?|reports?|documents?|describes?|claims?|lists?|mentions?|still)\b/i;

const norm = (text: string) => text.replace(/\s+/g, " ").trim();

const excerpt = (text: string) => {
  const t = norm(text);
  return t.length <= 80 ? t : `${t.slice(0, 77)}...`;
};

/**
 * Clauses of a change's added lines that quote code only the documentation
 * it cites has: a README or docs file can point to a fact about code but
 * never prove it. A clause counts when a code identifier or command literal
 * it quotes is in a cited documentation file and none of them is in any
 * cited code file. Judged only when every code file the change cites was
 * read whole and the change cites no commit without a path (whose diff
 * could hold it); a clause about what a document says, and one the page's
 * removed lines already make word for word, are left alone.
 */
function docOnlyClaims(
  change: Change,
  context: CheckContext,
  byKey: ReadonlyMap<string, CitedFile>,
  before: ReadonlySet<string>,
): string[] {
  const docs: CitedFile[] = [];
  const code: CitedFile[] = [];
  for (const citation of change.evidence) {
    if (isToolQuote(citation) || citation.path === undefined) return [];
    const resolved = sourcesFor(citation, context.sources ?? []);
    const source = resolved.find(
      (s) => s.kind === "commit" || s.kind === "search",
    );
    if (source === undefined || resolved.some((s) => s.kind === "code"))
      return [];
    const file = byKey.get(
      `${citation.repo}@${source.commit}:${citation.path}`,
    );
    if (isDocCitation(citation)) {
      if (file?.text !== undefined) docs.push(file);
    } else if (file?.text === undefined || file.shown !== "all") return [];
    else code.push(file);
  }
  if (docs.length === 0 || code.length === 0) return [];
  const out: string[] = [];
  for (const line of change.added)
    for (const { text } of clauses(line)) {
      if (before.has(norm(text)) || ABOUT_DOCS.test(text)) continue;
      const tokens = quotedCode(text);
      const inDocs = tokens.filter((t) =>
        docs.some((f) => hasToken(f.text!, t)),
      );
      if (
        inDocs.length === 0 ||
        tokens.some((t) => code.some((f) => hasToken(f.text!, t)))
      )
        continue;
      const docNames = [...new Set(docs.map((f) => f.path))].join(", ");
      const codeNames = [...new Set(code.map((f) => f.path))].join(", ");
      out.push(
        `"${excerpt(text)}": quotes ${inDocs.map((t) => `\`${t}\``).join(", ")}, which only the documentation it cites has (${docNames}), not the code it cites (${codeNames}); documentation alone is not evidence for what code does`,
      );
    }
  return out;
}

/**
 * Citations a page's changes make that the cited files disprove, by page:
 * a file that does not exist at the cited commit, a line past its end, or
 * a clause whose quoted code only cited documentation has
 * (`docOnlyClaims`). Checked by code before the second check, so no model
 * has to notice a citation that points at nothing. Files not read for
 * another reason (the size limit, an error) prove nothing and are skipped.
 */
export function citationProblems(
  pages: readonly ProposedPage[],
  context: CheckContext,
  files: readonly CitedFile[],
): Map<string, string[]> {
  const byKey = new Map(
    files.map((f) => [`${f.repo}@${f.commit}:${f.path}`, f] as const),
  );
  const out = new Map<string, string[]>();
  for (const page of pages) {
    if (page.decision !== "patch" || context.sources === undefined) continue;
    const problems = new Set<string>();
    const before = new Set(
      (page.changes ?? []).flatMap((c) =>
        c.removed.flatMap((l) => clauses(l).map((x) => norm(x.text))),
      ),
    );
    for (const change of page.changes ?? []) {
      for (const p of docOnlyClaims(change, context, byKey, before))
        problems.add(p);
      for (const citation of repoCitations(change.evidence)) {
        if (citation.path === undefined) continue;
        const resolved = sourcesFor(citation, context.sources);
        if (resolved.some((s) => s.kind === "code")) continue;
        const source = resolved.find(
          (s) => s.kind === "commit" || s.kind === "search",
        );
        if (source === undefined) continue;
        const file = byKey.get(
          `${citation.repo}@${source.commit}:${citation.path}`,
        );
        if (file === undefined) continue;
        const at = `${citation.repo}/${citation.path} at ${source.commit.slice(0, 12)}`;
        if (file.note === "does not exist at this commit")
          problems.add(`cites ${at}, which does not exist at that commit`);
        else if (
          citation.line !== undefined &&
          file.lines !== undefined &&
          citation.line > file.lines
        )
          problems.add(
            `cites line ${citation.line} of ${at}, which has ${file.lines} lines`,
          );
      }
    }
    if (problems.size > 0) out.set(`${page.repo}/${page.path}`, [...problems]);
  }
  return out;
}
