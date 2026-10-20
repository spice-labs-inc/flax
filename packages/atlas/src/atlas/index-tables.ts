// INDEX per-plane repo tables, generated from each doc's frontmatter (`plane`,
// `language`, `status`) and its H1 one-liner. The routing table and the prose
// around the tables stay hand-written.

import { h1Role, type Doc } from './doc.ts';
import { beginMarker, endMarker, findBlocks, renderTable, replaceBlock } from './markdown.ts';
import { clip } from './outline.ts';
import { config, indexPlanes } from '../config.ts';

export interface Plane {
  id: string;
  /** The INDEX heading the plane's table sits under. */
  heading: string;
}

/** The index planes of the atlas config (planes[] with index: true), in config order. */
export const PLANES = (): Plane[] => indexPlanes().map((p) => ({ id: p.id, heading: p.heading! }));

/** A row's role is the H1 one-liner, cut near this many characters (the doc holds the rest). */
export const ROLE_MAX = 72;
const STATUS_ORDER = () => config().enums.statusOrder;
const HOW = 'flax atlas index';

const blockId = (p: Plane) => `index-plane:${p.id}`;
const firstWord = (s: unknown) => String(s ?? '').trim().split(/[\s(]/)[0];

function planeOfHeading(line: string): Plane | undefined {
  return PLANES().find((p) => line.startsWith(p.heading));
}

/** The plane each doc sits under in the INDEX as it stands (first table or list it is linked from). */
export function planesFromIndex(index: string): Map<string, string> {
  const out = new Map<string, string>();
  let plane: Plane | undefined;
  for (const line of index.split('\n')) {
    if (/^#{2,3} /.test(line)) plane = planeOfHeading(line);
    if (!plane) continue;
    for (const m of line.matchAll(/repos\/([A-Za-z0-9_.-]+)\.md/g)) if (!out.has(m[1])) out.set(m[1], plane.id);
  }
  return out;
}

export function planeOf(doc: Doc): string | undefined {
  const p = doc.fm.plane;
  return typeof p === 'string' && p ? p : undefined;
}

export function renderPlane(plane: Plane, docs: Doc[], planeFor: (d: Doc) => string | undefined): string {
  const rows = docs
    .filter((d) => planeFor(d) === plane.id)
    .sort((a, b) => {
      const sa = STATUS_ORDER().indexOf(firstWord(a.fm.status));
      const sb = STATUS_ORDER().indexOf(firstWord(b.fm.status));
      return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb) || a.name.localeCompare(b.name);
    })
    .map((d) => [`repos/${d.name}.md`, firstWord(d.fm.status), clip(h1Role(d), ROLE_MAX)]);
  return renderTable(['doc', 'status', 'role'], rows);
}

export interface IndexResult {
  text: string;
  /** Planes whose block was missing and was put in place of the old table or list. */
  bootstrapped: string[];
  /** Docs without a `plane:` field (their plane came from where the INDEX links them today). */
  missingPlane: string[];
  /** Docs no table rows at all. */
  unplaced: string[];
  unknownPlane: string[];
  rows: Record<string, number>;
}

/**
 * The INDEX with every plane block regenerated. A plane without its marker block yet
 * gets one in place of the table or link list under its heading (other prose stays).
 */
export function generateIndex(index: string, docs: Doc[], fallback: Map<string, string>): IndexResult {
  const missingPlane: string[] = [];
  const unknownPlane: string[] = [];
  const ids = PLANES().map((p) => p.id);
  const planeFor = (d: Doc) => {
    const p = planeOf(d);
    if (p === undefined) {
      missingPlane.push(d.name);
      return fallback.get(d.name);
    }
    if (!ids.includes(p)) unknownPlane.push(`${d.name} (${p})`);
    return p;
  };
  const resolved = new Map(docs.map((d) => [d.name, planeFor(d)]));
  const pf = (d: Doc) => resolved.get(d.name);
  let text = index;
  const bootstrapped: string[] = [];
  const rows: Record<string, number> = {};
  for (const plane of PLANES()) {
    const table = renderPlane(plane, docs, pf);
    rows[plane.id] = table.split('\n').length - 2;
    const block = findBlocks(text).find((b) => b.id === blockId(plane));
    if (block) {
      text = replaceBlock(text, block, table);
      continue;
    }
    const lines = text.split('\n');
    const h = lines.findIndex((l) => l.startsWith(plane.heading));
    if (h === -1) throw new Error(`INDEX.md has no "${plane.heading}" heading and no ${blockId(plane)} block`);
    let e = h + 1;
    while (e < lines.length && !/^#{2,3} /.test(lines[e])) e++;
    const region = lines.slice(h + 1, e);
    const kept = region.filter((l) => l.trim() && !/^\|/.test(l) && !/repos\/[A-Za-z0-9_.-]+\.md/.test(l));
    const generated = [beginMarker(blockId(plane), HOW), table, endMarker(blockId(plane))];
    const next = [...kept, ...generated, ''];
    lines.splice(h + 1, e - h - 1, ...next);
    text = lines.join('\n');
    bootstrapped.push(plane.id);
  }
  const unplaced = docs.filter((d) => !resolved.get(d.name)).map((d) => d.name);
  return { text, bootstrapped, missingPlane, unplaced, unknownPlane, rows };
}

/** The doc text with `plane: <id>` added after `status:` (frontmatter). */
export function withPlane(d: Doc, plane: string): string {
  const status = d.front.find((e) => e.key === 'status');
  if (!status) throw new Error(`${d.file}: no status line to place plane after`);
  const fm = d.text.slice(0, d.frontEnd).replace(status.raw, `${status.raw}\nplane: ${plane}`);
  return fm + d.text.slice(d.frontEnd);
}
