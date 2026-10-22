// Markdown helpers for the atlas tools: the units budgets apply to, and generated blocks.
export const bytes = (s) => Buffer.byteLength(s, 'utf8');
export const chars = (s) => [...s].length;
const BULLET = /^(?:[-*+]|\d+\.)\s/;
/**
 * Top-level units of a markdown body: a bullet with its continuation and nested
 * bullets, a table row, a heading, a paragraph or a fenced block. A table under a
 * bullet is not part of the bullet: each row is its own unit.
 */
export function units(text) {
    const out = [];
    let cur;
    let blank = false;
    let fence = false;
    text.split('\n').forEach((line, i) => {
        const n = i + 1;
        if (fence) {
            cur.lines.push(line);
            if (/^\s*```/.test(line))
                fence = false;
            return;
        }
        if (/^\s*```/.test(line)) {
            if (/^\s/.test(line) && cur?.kind === 'bullet')
                cur.lines.push(line);
            else
                out.push((cur = { kind: 'fence', line: n, lines: [line] }));
            fence = true;
            blank = false;
            return;
        }
        if (!line.trim()) {
            blank = true;
            return;
        }
        if (/^#{1,6}\s/.test(line)) {
            out.push((cur = { kind: 'heading', line: n, lines: [line] }));
        }
        else if (/^\s*\|/.test(line)) {
            out.push((cur = { kind: 'row', line: n, lines: [line] }));
        }
        else if (BULLET.test(line)) {
            out.push((cur = { kind: 'bullet', line: n, lines: [line] }));
        }
        else if (/^\s/.test(line) && (cur?.kind === 'bullet' || cur?.kind === 'para')) {
            cur.lines.push(line);
        }
        else if (!blank && (cur?.kind === 'bullet' || cur?.kind === 'para')) {
            cur.lines.push(line);
        }
        else {
            out.push((cur = { kind: 'para', line: n, lines: [line] }));
        }
        blank = false;
    });
    return out;
}
export const unitText = (u) => u.lines.join('\n');
const beginRe = /^<!-- BEGIN GENERATED ([a-z0-9:_-]+)(?: [^\n]*?)? -->$/gm;
/** Generated blocks: `<!-- BEGIN GENERATED <id> ... -->` ... `<!-- END GENERATED <id> -->`. */
export function findBlocks(text) {
    const out = [];
    for (const m of text.matchAll(beginRe)) {
        const id = m[1];
        const begin = m.index;
        const contentStart = begin + m[0].length + 1;
        const endMarker = `<!-- END GENERATED ${id} -->`;
        const contentEnd = text.indexOf(endMarker, contentStart - 1);
        if (contentEnd === -1)
            throw new Error(`generated block ${id} has no END marker`);
        out.push({ id, begin, contentStart: Math.min(contentStart, contentEnd), contentEnd, end: contentEnd + endMarker.length });
    }
    return out;
}
export function blockContent(text, b) {
    return text.slice(b.contentStart, b.contentEnd);
}
export function beginMarker(id, how) {
    return `<!-- BEGIN GENERATED ${id} (${how}; do not edit by hand) -->`;
}
export function endMarker(id) {
    return `<!-- END GENERATED ${id} -->`;
}
/** Replaces a block's content; the content gets exactly one trailing newline. */
export function replaceBlock(text, b, content) {
    const body = content.replace(/\n*$/, '\n');
    return text.slice(0, b.contentStart) + body + text.slice(b.contentEnd);
}
export function renderTable(header, rows) {
    const cell = (s) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    return [
        `| ${header.join(' | ')} |`,
        `|${header.map(() => '---').join('|')}|`,
        ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
    ].join('\n');
}
/** A short unified-style summary of how two texts differ, for --check output. */
export function diffSummary(before, after, max = 6) {
    const a = before.split('\n');
    const b = after.split('\n');
    const setA = new Set(a);
    const setB = new Set(b);
    const removed = a.filter((l) => !setB.has(l));
    const added = b.filter((l) => !setA.has(l));
    const clip = (l) => (l.length > 160 ? `${l.slice(0, 157)}...` : l);
    const out = [
        ...removed.slice(0, max).map((l) => `    - ${clip(l)}`),
        ...(removed.length > max ? [`    - ... ${removed.length - max} more`] : []),
        ...added.slice(0, max).map((l) => `    + ${clip(l)}`),
        ...(added.length > max ? [`    + ... ${added.length - max} more`] : []),
    ];
    return out;
}
//# sourceMappingURL=markdown.js.map