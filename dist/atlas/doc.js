// The atlas doc model, shared by the map (read-atlas, wiring, wiring-eval) and the
// atlas tools (flax atlas <cmd>): a repo doc `repos/<name>.md` plus its section files
// `repos/<name>/<section>.md`, resolved into the 11 stable sections.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
/** The stable section ids, in template order (docs.sections in the atlas config). */
export const SECTION_IDS = () => config().docs.sections;
/** Sections that may live in a section file (every section but docs.mainOnly). */
export const SECTION_FILE_IDS = () => config().docs.sections.filter((s) => !config().docs.mainOnly.includes(s));
export const POINTER_RE = /^Outline below; full detail in (repos\/[A-Za-z0-9_.-]+\/[a-z-]+\.md)/;
export function pointerLine(name, section) {
    return `Outline below; full detail in repos/${name}/${section}.md (open it before relying on anything here).`;
}
export function fsSource(root) {
    return {
        read(rel) {
            const p = join(root, rel);
            return existsSync(p) && statSync(p).isFile() ? readFileSync(p, 'utf8') : undefined;
        },
        list(relDir) {
            const p = join(root, relDir);
            return existsSync(p) && statSync(p).isDirectory() ? readdirSync(p).sort() : [];
        },
    };
}
export function gitSource(root, commit) {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
    return {
        read(rel) {
            try {
                return git('show', `${commit}:${rel}`);
            }
            catch {
                return undefined;
            }
        },
        list(relDir) {
            try {
                return git('ls-tree', '--name-only', commit, `${relDir.replace(/\/+$/, '')}/`)
                    .split('\n')
                    .filter(Boolean)
                    .map((p) => p.slice(p.lastIndexOf('/') + 1))
                    .sort();
            }
            catch {
                return [];
            }
        },
    };
}
/** Splits on commas outside parentheses, brackets and quotes. */
export function splitTopLevel(s) {
    const out = [];
    let depth = 0;
    let quote = '';
    let cur = '';
    for (const ch of s) {
        if (quote) {
            if (ch === quote)
                quote = '';
        }
        else if (ch === '"' || ch === "'")
            quote = ch;
        else if (ch === '(' || ch === '[')
            depth++;
        else if (ch === ')' || ch === ']')
            depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0 && !quote) {
            out.push(cur.trim());
            cur = '';
        }
        else
            cur += ch;
    }
    if (cur.trim())
        out.push(cur.trim());
    return out.filter(Boolean).map((x) => x.replace(/^"(.*)"$/s, '$1'));
}
/** The repo name an entry like `notes-core (event schema)` refers to. */
export function entryName(entry) {
    return entry.trim().split(/[\s(]/)[0].replace(/[,;:]+$/, '');
}
export function parseFrontmatter(text) {
    const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m)
        return { front: [], end: 0 };
    const lines = m[1].split('\n');
    const front = [];
    for (let i = 0; i < lines.length; i++) {
        const mm = lines[i].match(/^([a-z_]+):\s*(.*)$/);
        if (!mm)
            continue;
        const key = mm[1];
        let rawValue = mm[2];
        const rawLines = [lines[i]];
        // A list may open on the next line and run over several (`key:\n  [\n  a,\n  ]`).
        if (rawValue === '' && i + 1 < lines.length && /^\s+\[/.test(lines[i + 1])) {
            rawValue = '';
            while (i + 1 < lines.length && /^\s/.test(lines[i + 1])) {
                i++;
                rawLines.push(lines[i]);
                rawValue += ' ' + lines[i].trim();
            }
            rawValue = rawValue.trim();
        }
        else if (rawValue.startsWith('[') && !rawValue.trimEnd().endsWith(']')) {
            while (i + 1 < lines.length && /^\s/.test(lines[i + 1])) {
                i++;
                rawLines.push(lines[i]);
                rawValue += ' ' + lines[i].trim();
            }
        }
        let value;
        if (rawValue.startsWith('[')) {
            const inner = rawValue.replace(/^\[/, '').replace(/\]\s*(#.*)?$/, '').trim();
            value = inner ? splitTopLevel(inner) : [];
        }
        else
            value = rawValue.trim();
        front.push({ key, raw: rawLines.join('\n'), value });
    }
    return { front, end: m[0].length };
}
/** Splits a markdown text into `## ` sections (headings inside code fences are ignored). */
export function splitSections(text, from = 0) {
    const sections = [];
    let fence = false;
    let pos = 0;
    const starts = [];
    for (const line of text.split('\n')) {
        const lineStart = pos;
        pos += line.length + 1;
        if (lineStart < from)
            continue;
        if (/^\s*```/.test(line))
            fence = !fence;
        if (fence)
            continue;
        const m = line.match(/^## (.+?)\s*$/);
        if (m)
            starts.push({ id: m[1].trim(), start: lineStart, bodyStart: Math.min(pos, text.length) });
    }
    for (let i = 0; i < starts.length; i++) {
        const end = i + 1 < starts.length ? starts[i + 1].start : text.length;
        const s = starts[i];
        sections.push({ id: s.id, start: s.start, bodyStart: s.bodyStart, end, body: text.slice(s.bodyStart, end) });
    }
    return sections;
}
/** Trimmed section bodies keyed by heading, as the map has always read them. */
export function parseSections(text) {
    const out = {};
    for (const s of splitSections(text))
        if (!(s.id in out))
            out[s.id] = s.body.trim();
    return out;
}
export function sectionFileBody(text) {
    const lines = text.split('\n');
    if (lines[0]?.startsWith('# '))
        lines.shift();
    return lines
        .filter((l) => !/^Moved verbatim from repos\//.test(l))
        .join('\n')
        .trim();
}
export function parseDoc(name, file, text, src) {
    const { front, end } = parseFrontmatter(text);
    const fm = {};
    for (const e of front)
        if (!(e.key in fm))
            fm[e.key] = e.value;
    const h1 = (text.slice(end).match(/^# .*$/m) ?? [''])[0];
    const sectionFiles = {};
    const otherFiles = [];
    if (src) {
        for (const f of src.list(`repos/${name}`)) {
            const rel = `repos/${name}/${f}`;
            const id = f.replace(/\.md$/, '');
            if (f.endsWith('.md') && SECTION_IDS().includes(id)) {
                const t = src.read(rel) ?? '';
                sectionFiles[id] = { id, file: rel, text: t, body: sectionFileBody(t) };
            }
            else
                otherFiles.push(rel);
        }
    }
    return { name, file, text, fm, front, frontEnd: end, h1, sections: splitSections(text, end), sectionFiles, otherFiles };
}
export function docNames(src) {
    return src
        .list('repos')
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, ''));
}
export function readDoc(src, name) {
    const file = `repos/${name}.md`;
    const text = src.read(file);
    return text === undefined ? undefined : parseDoc(name, file, text, src);
}
export function readDocs(src, only) {
    const out = [];
    for (const n of docNames(src)) {
        if (only && !only.includes(n))
            continue;
        const d = readDoc(src, n);
        if (d)
            out.push(d);
    }
    return out;
}
export function section(doc, id) {
    return doc.sections.find((s) => s.id === id);
}
/** The main doc's part of a section: everything before the outline pointer (all of it when there is none). */
export function sectionHead(body) {
    const lines = body.split('\n');
    const i = lines.findIndex((l) => POINTER_RE.test(l));
    if (i === -1)
        return { head: body, hasPointer: false };
    return { head: lines.slice(0, i).join('\n'), hasPointer: true };
}
/**
 * The whole of a section: the main doc's text before the outline pointer followed by
 * the section file body when the section lives in a file, else the main doc's body.
 */
export function fullSection(doc, id) {
    const s = section(doc, id);
    const file = doc.sectionFiles[id];
    if (!file)
        return s ? s.body.trim() : undefined;
    const head = s ? sectionHead(s.body).head.trim() : '';
    return [head, file.body].filter(Boolean).join('\n\n');
}
export function fullSections(doc) {
    const out = {};
    for (const s of doc.sections)
        if (!(s.id in out))
            out[s.id] = fullSection(doc, s.id) ?? '';
    for (const id of Object.keys(doc.sectionFiles))
        if (!(id in out))
            out[id] = fullSection(doc, id) ?? '';
    return out;
}
/** Frontmatter list as repo names (parenthesised notes dropped). */
export function names(doc, key) {
    const v = doc.fm[key];
    if (!Array.isArray(v))
        return [];
    return v.map(entryName).filter(Boolean);
}
/** The H1 one-liner after the doc name: `# notes-api: the HTTP API` gives `the HTTP API`. */
export function h1Role(doc) {
    let t = doc.h1.replace(/^#\s+/, '').trim();
    if (t.toLowerCase().startsWith(doc.name.toLowerCase()))
        t = t.slice(doc.name.length);
    return t.replace(/^\s*(—|–|:|-)\s*/, '').trim();
}
//# sourceMappingURL=doc.js.map