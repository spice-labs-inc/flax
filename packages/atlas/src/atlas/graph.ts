// depends_on / used_by: the symmetry report and the used_by generator (used_by is the
// inverse of every doc's depends_on; depends_on stays hand-written).

import { names, type Doc } from './doc.ts';
import { config } from '../config.ts';

/** Alias and tombstone docs: rename redirects that never carry their own edges (docs.symmetryExempt). */
export const SYMMETRY_EXEMPT = () => config().docs.symmetryExempt;

export function asymmetries(docs: Doc[]): string[] {
  const by = new Map(docs.map((d) => [d.name, d]));
  const out: string[] = [];
  const exempt = (...n: string[]) => n.some((x) => SYMMETRY_EXEMPT().includes(x));
  for (const a of [...docs].sort((x, y) => x.name.localeCompare(y.name))) {
    for (const d of names(a, 'depends_on')) {
      const other = by.get(d);
      if (other && !names(other, 'used_by').includes(a.name) && !exempt(a.name, d))
        out.push(`ASYMMETRY: ${a.name} depends_on ${d}, but ${d} used_by lacks ${a.name}`);
    }
  }
  for (const a of [...docs].sort((x, y) => x.name.localeCompare(y.name))) {
    for (const u of names(a, 'used_by')) {
      const other = by.get(u);
      if (other && !names(other, 'depends_on').includes(a.name) && !exempt(a.name, u))
        out.push(`ASYMMETRY: ${a.name} used_by ${u}, but ${u} depends_on lacks ${a.name}`);
    }
  }
  return out;
}

export function generatedUsedBy(docs: Doc[]): Map<string, string[]> {
  const out = new Map<string, string[]>(docs.map((d) => [d.name, []]));
  for (const a of docs) {
    for (const d of new Set(names(a, 'depends_on'))) {
      if (d !== a.name && out.has(d)) out.get(d)!.push(a.name);
    }
  }
  for (const v of out.values()) v.sort();
  return out;
}

export interface UsedByChange {
  doc: Doc;
  line: string;
  added: string[];
  /** Names dropped: docs whose depends_on does not name this doc, or names that are not docs. */
  dropped: string[];
  notesDropped: number;
}

export function usedByChanges(docs: Doc[]): UsedByChange[] {
  const gen = generatedUsedBy(docs);
  const out: UsedByChange[] = [];
  for (const d of docs) {
    const want = gen.get(d.name)!;
    const line = `used_by: [${want.join(', ')}]`;
    const entry = d.front.find((e) => e.key === 'used_by');
    if (entry?.raw === line) continue;
    const have = names(d, 'used_by');
    const raw = Array.isArray(d.fm.used_by) ? d.fm.used_by : [];
    out.push({
      doc: d,
      line,
      added: want.filter((n) => !have.includes(n)),
      dropped: have.filter((n) => !want.includes(n)),
      notesDropped: raw.filter((e) => /[\s(]/.test(e.trim())).length,
    });
  }
  return out;
}

/** The doc text with its used_by entry replaced (or added after depends_on). */
export function applyUsedBy(d: Doc, line: string): string {
  const entry = d.front.find((e) => e.key === 'used_by');
  const fmText = d.text.slice(0, d.frontEnd);
  let next: string;
  if (entry) next = fmText.replace(entry.raw, line);
  else {
    const dep = d.front.find((e) => e.key === 'depends_on');
    if (!dep) throw new Error(`${d.file}: no depends_on to place used_by after`);
    next = fmText.replace(dep.raw, `${dep.raw}\n${line}`);
  }
  return next + d.text.slice(d.frontEnd);
}
