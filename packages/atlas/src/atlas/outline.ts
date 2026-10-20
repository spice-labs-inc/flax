// Outlines: a main doc keeps, for each section that lives in a section file, the
// pointer line and one short bullet per top-level unit of that file. Generated, so
// nobody keeps the two in step by hand.

import { pointerLine, section, sectionHead, type Doc } from './doc.ts';
import { chars, units, type UnitKind } from './markdown.ts';

const MAX = 150;

/** One outline line: the unit's first line, em-dashes made colons, cut at a word near 150 characters. */
export function clip(text: string, max = MAX): string {
  let t = text.replace(/\s+—\s+/g, ': ').replace(/—/g, ': ').replace(/\s+/g, ' ').trim();
  if (chars(t) <= max) return t;
  const cut = [...t].slice(0, max - 10).join('');
  const sp = cut.lastIndexOf(' ');
  t = (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:(]+$/, '');
  if (((t.match(/`/g) ?? []).length) % 2) t += '`';
  if (((t.match(/\*\*/g) ?? []).length) % 2) t += '**';
  return `${t} ...`;
}

const MARKER = /^<!-- (?:BEGIN|END) GENERATED [^\n]*-->\s*$/;

export function outlineBullets(body: string): string[] {
  const out: string[] = [];
  let prev: UnitKind | undefined;
  for (const u of units(body)) {
    if (u.kind === 'para' && MARKER.test(u.lines[0])) {
      const rest = u.lines.filter((l) => !MARKER.test(l));
      prev = undefined;
      if (rest.length) out.push(`- ${clip(rest.join(' '))}`);
      continue;
    }
    if (u.kind === 'bullet') out.push(`- ${clip(u.lines[0].replace(/^(?:[-*+]|\d+\.)\s+/, ''))}`);
    else if (u.kind === 'heading') out.push(`- **${clip(u.lines[0].replace(/^#+\s+/, ''))}**`);
    else if (u.kind === 'para') out.push(`- ${clip(u.lines.join(' '))}`);
    // A table under a bullet belongs to that bullet; a standalone one gets its header.
    else if (u.kind === 'row' && prev !== 'row' && prev !== 'bullet') {
      const cells = u.lines[0].split('|').map((c) => c.trim()).filter(Boolean);
      out.push(`- ${clip(`table: ${cells.join(', ')}`)}`);
    }
    prev = u.kind;
  }
  return out;
}

export interface OutlineChange {
  doc: Doc;
  id: string;
  before: string;
  after: string;
}

/** The section body (text after the heading line) the main doc should carry. */
export function outlineBody(doc: Doc, id: string): string {
  const s = section(doc, id);
  const head = s ? sectionHead(s.body).head.trim() : '';
  const bullets = outlineBullets(doc.sectionFiles[id].body);
  return `${head ? `${head}\n\n` : ''}${pointerLine(doc.name, id)}\n\n${bullets.join('\n')}\n\n`;
}

export function outlineChanges(doc: Doc): OutlineChange[] {
  const out: OutlineChange[] = [];
  for (const id of Object.keys(doc.sectionFiles)) {
    const s = section(doc, id);
    if (!s) continue; // budgets report a section file without a heading
    const after = outlineBody(doc, id);
    const before = s.end === doc.text.length ? s.body.replace(/\n*$/, '\n\n') : s.body;
    if (before !== after) out.push({ doc, id, before, after });
  }
  return out;
}

export function applyOutlines(doc: Doc): string {
  // Replace from the last section backwards so earlier offsets stay valid.
  const sections = [...doc.sections].filter((s) => doc.sectionFiles[s.id]).sort((a, b) => b.start - a.start);
  let text = doc.text;
  for (const s of sections) {
    const body = outlineBody(doc, s.id);
    const tail = s.end === doc.text.length ? body.replace(/\n+$/, '\n') : body;
    text = text.slice(0, s.bodyStart) + tail + text.slice(s.end);
  }
  return text;
}
