import { workspace } from "../lib/workspace.ts";
import type { AddedLine } from "./links.ts";

/**
 * The docs lint hook. flax.yml agents.docsLint names the repository whose
 * site build checks page components and manual wording, the page sections
 * (frontmatter category) the wording check covers, the component tags a
 * patch must keep in place and in order, the words no page may add, and
 * per trait (a frontmatter traits value) the words a page with that trait
 * may not add. A patch that would break the build is refused here first.
 * Without docs_lint there are no component tags and no wording rules.
 */
export interface DocsLint {
  repo: string;
  sections: string[];
  componentTags: string[];
  always: string[];
  byTrait: Record<string, string[]>;
}

export const MDX_PATH = /\.mdx$/;

export function docsLint(): DocsLint | undefined {
  return workspace().docsLint;
}

/** An opening, closing or self-closing tag of a component the lint keeps in place. */
function componentTag(): RegExp | undefined {
  const tags = docsLint()?.componentTags ?? [];
  if (tags.length === 0) return undefined;
  return new RegExp(`</?(?:${tags.join("|")})\\b[^>]*>`, "g");
}

function componentTags(lines: readonly string[]): string[] {
  return (
    lines
      .join("\n")
      .match(componentTag() ?? /(?!)/g)
      ?.map((t) => t.replace(/\s+/g, " ")) ?? []
  );
}

/**
 * Why the patch changes the page's component structure, or undefined when
 * it does not: every gating, cast and badge tag must stay as it is, in the
 * same order, so a step is never added, removed or reordered inside a cast
 * and no gate opens, closes or changes its editions. Text between the tags
 * may change.
 */
export function componentProblem(
  before: readonly string[],
  after: readonly string[],
): string | undefined {
  const a = componentTags(before);
  const b = componentTags(after);
  if (a.join("\n") === b.join("\n")) return undefined;
  const first = a.findIndex((t, i) => t !== b[i]);
  const at = first === -1 ? a.length : first;
  const was = a[at] ?? "(nothing)";
  const now = b[at] ?? "(nothing)";
  return `changes the page's component tags (${was} becomes ${now}); casts, their steps, edition gates and badges are kept exactly as they are`;
}

/**
 * The manual wording check (public-docs src/lib/manual-build/lint.ts):
 * words that give another product away in an edition's manual. The
 * edition words apply in every manual; the credential words in manuals of
 * the other connection (an online edition's manual never names a Notes
 * License, an air-gapped one never a Notes Pass).
 */
function lintAlways(): RegExp[] {
  return (docsLint()?.always ?? []).map((s) => new RegExp(s, "i"));
}

const isVariable = (re: RegExp) => /^[A-Z_]+$/.test(re.source);

function frontmatter(lines: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (lines[0] !== "---") return out;
  for (let i = 1; i < lines.length && lines[i] !== "---"; i++) {
    const m = /^([A-Za-z_]+):\s*(.*)$/.exec(lines[i]!);
    if (m) out.set(m[1]!, m[2]!.replace(/^["']|["']$/g, ""));
  }
  return out;
}

/** Which credential words a manual chapter may not use, from its traits. */
function traitPatterns(traits: string): RegExp[] {
  const t = traits
    .replace(/[[\]"']/g, "")
    .split(/[\s,]+/)
    .filter(Boolean);
  const byTrait = docsLint()?.byTrait ?? {};
  const named = Object.keys(byTrait).filter((trait) => t.includes(trait));
  // A page with none of the traits lands in every kind of manual.
  const chosen = named.length > 0 ? named : Object.keys(byTrait);
  return chosen.flatMap((trait) => (byTrait[trait] ?? []).map((s) => new RegExp(s, "i")));
}

interface LineContext {
  fence: boolean;
  /** Inside any <Only>, so its credential words belong to the gate's editions. */
  gated: boolean;
  /** Inside <Only site> or <Verbatim>: text the manuals never show. */
  siteOnly: boolean;
}

/** The context of every line of a page (index = line number - 1). */
function lineContexts(lines: readonly string[]): LineContext[] {
  const out: LineContext[] = [];
  let fence = false;
  const stack: ("only" | "site" | "verbatim")[] = [];
  for (const line of lines) {
    const startsFence = /^\s*(```|~~~)/.test(line);
    out.push({
      fence: fence || startsFence,
      gated: stack.length > 0,
      siteOnly: stack.some((s) => s !== "only"),
    });
    if (startsFence) fence = !fence;
    if (fence) continue;
    for (const m of line.matchAll(/<(\/?)(Only|Verbatim)\b([^>]*?)(\/?)>/g)) {
      const [, close, name, attrs, selfClose] = m;
      if (selfClose) continue;
      if (close) stack.pop();
      else if (name === "Verbatim") stack.push("verbatim");
      else stack.push(/\bsite\b/.test(attrs!) ? "site" : "only");
    }
    // A gate opened and closed on the same line covers that line.
    if (/<Only\b[^>]*\bsite\b[^>]*>.*<\/Only>/.test(line))
      out[out.length - 1]!.siteOnly = true;
    else if (/<Only\b[^>]*>.*<\/Only>/.test(line))
      out[out.length - 1]!.gated = true;
  }
  return out;
}

/**
 * Added lines of a manual chapter that would fail an edition's manual
 * wording check. Only added lines are checked, outside code blocks, with
 * inline code skipped for words (a command such as `notes pass decode`)
 * but not for environment variables, as the site's check does. Lines in
 * <Only site> or <Verbatim> never reach a manual; lines inside any other
 * <Only>, and <Credential /> itself, are left to the site's build, which
 * knows each gate's editions.
 */
export function manualWordingProblems(
  repo: string,
  pageAfter: readonly string[],
  added: readonly AddedLine[],
): string[] {
  const lint = docsLint();
  if (lint === undefined || repo !== lint.repo || added.length === 0) return [];
  const fm = frontmatter(pageAfter);
  const category = fm.get("category") ?? "";
  if (!lint.sections.includes(category)) return [];
  if (fm.get("manual") === "false") return [];
  const contexts = lineContexts(pageAfter);
  const credential = traitPatterns(fm.get("traits") ?? "");
  const problems: string[] = [];
  for (const { line, text } of added) {
    const ctx = contexts[line - 1];
    if (ctx === undefined || ctx.fence || ctx.siteOnly) continue;
    if (/^\s*(import|export)\s/.test(text)) continue;
    // Tags never render as words (<Edition /> renders the edition's own name).
    const withCode = text.replace(/<\/?[A-Za-z][^>]*>/g, " ");
    const withoutCode = withCode.replace(/`[^`]*`/g, " ");
    const patterns = ctx.gated ? lintAlways() : [...lintAlways(), ...credential];
    for (const re of patterns) {
      const m = (isVariable(re) ? withCode : withoutCode).match(re);
      if (m === null) continue;
      problems.push(
        `line ${line} says "${m[0]}", which an edition's manual may not say; gate it with <Only> or <Credential />, or word it without naming editions`,
      );
    }
  }
  return problems;
}
