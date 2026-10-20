import { linkAllowed } from "./slack-message.ts";
import { plainText } from "./pr-text.ts";

/**
 * A section of a pull request body that a job's publish.ts writes: a
 * title, then paragraphs, list items and links, each shown as plain
 * escaped text, and a code block shown as written. Only a link's URL is kept as a link, and only when it
 * starts with a prefix the kit allows (channels.yml links).
 */
export interface PrSection {
  title: string;
  paragraphs?: string[];
  items?: string[];
  links?: { text: string; url: string }[];
  /** Text to copy, such as a prompt or commands, shown last as a code block. */
  code?: string;
}

export const MAX_SECTIONS = 12;
export const MAX_SECTION_TITLE_CHARS = 80;
export const MAX_SECTION_PARAGRAPHS = 10;
export const MAX_SECTION_PARAGRAPH_CHARS = 2000;
export const MAX_SECTION_ITEMS = 30;
export const MAX_SECTION_ITEM_CHARS = 500;
export const MAX_SECTION_LINKS = 20;
export const MAX_SECTION_LINK_TEXT_CHARS = 120;
export const MAX_SECTION_URL_CHARS = 2000;
export const MAX_SECTION_CODE_CHARS = 4000;

const KEYS = ["title", "paragraphs", "items", "links", "code"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringsProblem(
  value: unknown,
  label: string,
  max: number,
  chars: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > max ||
    !value.every(
      (v) => typeof v === "string" && v.trim() !== "" && v.length <= chars,
    )
  )
    return `${label} must be at most ${max} non-empty strings of at most ${chars} characters`;
  return undefined;
}

/** Why what publish.ts printed as sections is not a list of sections, or undefined when it is. */
export function prSectionsProblem(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0)
    return "sections must be a non-empty list";
  if (value.length > MAX_SECTIONS)
    return `sections lists ${value.length}, more than ${MAX_SECTIONS}`;
  for (const [i, s] of value.entries()) {
    const at = `sections[${i}]`;
    if (!isObject(s)) return `${at} is not an object`;
    const extra = Object.keys(s).find((k) => !KEYS.includes(k));
    if (extra !== undefined) return `${at} has the key ${extra}`;
    if (
      typeof s.title !== "string" ||
      s.title.trim() === "" ||
      s.title.includes("\n") ||
      s.title.length > MAX_SECTION_TITLE_CHARS
    )
      return `${at}.title must be one line of at most ${MAX_SECTION_TITLE_CHARS} characters`;
    const problem =
      stringsProblem(
        s.paragraphs,
        `${at}.paragraphs`,
        MAX_SECTION_PARAGRAPHS,
        MAX_SECTION_PARAGRAPH_CHARS,
      ) ??
      stringsProblem(
        s.items,
        `${at}.items`,
        MAX_SECTION_ITEMS,
        MAX_SECTION_ITEM_CHARS,
      );
    if (problem !== undefined) return problem;
    if (s.links !== undefined) {
      if (!Array.isArray(s.links) || s.links.length > MAX_SECTION_LINKS)
        return `${at}.links must be a list of at most ${MAX_SECTION_LINKS}`;
      for (const [j, l] of s.links.entries())
        if (
          !isObject(l) ||
          Object.keys(l).sort().join(",") !== "text,url" ||
          typeof l.text !== "string" ||
          l.text.trim() === "" ||
          l.text.length > MAX_SECTION_LINK_TEXT_CHARS ||
          typeof l.url !== "string" ||
          l.url.length > MAX_SECTION_URL_CHARS
        )
          return `${at}.links[${j}] must be exactly text (at most ${MAX_SECTION_LINK_TEXT_CHARS} characters) and url (at most ${MAX_SECTION_URL_CHARS})`;
    }
    if (
      s.code !== undefined &&
      (typeof s.code !== "string" ||
        s.code.trim() === "" ||
        s.code.length > MAX_SECTION_CODE_CHARS)
    )
      return `${at}.code must be a non-empty string of at most ${MAX_SECTION_CODE_CHARS} characters`;
    const parts =
      (s.code === undefined ? 0 : 1) +
      ((s.paragraphs as unknown[] | undefined)?.length ?? 0) +
      ((s.items as unknown[] | undefined)?.length ?? 0) +
      ((s.links as unknown[] | undefined)?.length ?? 0);
    if (parts === 0) return `${at} has no paragraphs, items, links or code`;
  }
  return undefined;
}

/** The links of the sections that do not start with one of the prefixes the kit allows, one line each. */
export function sectionLinkProblems(
  sections: readonly PrSection[],
  prefixes: readonly string[],
): string[] {
  const out: string[] = [];
  for (const [i, s] of sections.entries())
    for (const [j, l] of (s.links ?? []).entries())
      if (!linkAllowed(l.url, { prefixes, exact: [] }))
        out.push(
          `sections[${i}].links[${j}] points outside the links channels.yml allows`,
        );
  return out;
}

/** A checked URL as a Markdown link target: parentheses encoded, so the link cannot end early. */
function linkTarget(url: string): string {
  return url.replaceAll("(", "%28").replaceAll(")", "%29");
}

/** A fenced code block around text, its fence longer than any run of backticks in it. */
function fenced(text: string): string[] {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((r) => r.length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}text`, text, fence];
}

/** The sections as pull request body lines: each title in bold, then its paragraphs, items and links, all text escaped, then its code block. */
export function renderSections(sections: readonly PrSection[]): string[] {
  const out: string[] = [];
  for (const s of sections) {
    out.push(`**${plainText(s.title)}**`, "");
    for (const p of s.paragraphs ?? []) out.push(plainText(p), "");
    const list = [
      ...(s.items ?? []).map((t) => `- ${plainText(t)}`),
      ...(s.links ?? []).map(
        (l) => `- [${plainText(l.text, () => false)}](${linkTarget(l.url)})`,
      ),
    ];
    if (list.length > 0) out.push(...list, "");
    if (s.code !== undefined) out.push(...fenced(s.code), "");
  }
  return out;
}
