import type { GlossaryEntry } from "@flax/contract/config";

/** The heading the entries without a built-in section go under, after the built-in ones. */
export const PROJECT_SECTION = "This project";

/** The configured entries per built-in heading, and the rest under `PROJECT_SECTION`, in flax.yml order. */
export function glossarySections(
  entries: readonly GlossaryEntry[],
  headings: readonly string[],
): Record<string, GlossaryEntry[]> {
  const out: Record<string, GlossaryEntry[]> = Object.fromEntries(
    [...headings, PROJECT_SECTION].map((h) => [h, []]),
  );
  for (const e of entries) {
    const h =
      e.section !== undefined && headings.includes(e.section)
        ? e.section
        : PROJECT_SECTION;
    out[h]!.push(e);
  }
  return out;
}

/** A piece of an entry's text: plain words, or a link written `[label](url)`. */
export type GlossaryRun = { text: string } | { text: string; href: string };

export function glossaryRuns(text: string): GlossaryRun[] {
  const out: GlossaryRun[] = [];
  const link = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (const m of text.matchAll(link)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: m[1]!, href: m[2]! });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
