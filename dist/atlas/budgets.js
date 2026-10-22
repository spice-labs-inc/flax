// Size and content budgets for every atlas file (MAINTENANCE.md §Doc layout and budgets).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { POINTER_RE, SECTION_FILE_IDS, docNames, entryName, fsSource, readDoc, sectionHead } from './doc.js';
import { bytes, chars, units, unitText } from './markdown.js';
import { config } from '../config.js';
export const BUDGET = () => config().docs.budgets;
/** Root pages a session reads; the noVolatile ones must also carry no fast-moving facts. */
const SHARED = () => config().docs.rootPages;
const NO_VOLATILE = () => config().docs.noVolatile;
const GAPS_EXTRA_TAGS = () => config().docs.gapsTags;
export const VOLATILE = [
    ['date', /\b20\d\d-\d\d(?:-\d\d)?\b/g],
    ['version', /(?<![\w.])v\d+(?:\.\d+)+\b|(?<![\w.-])\d+\.\d+\.\d+(?![\w.])/g],
    ['pr', /\bPR\s*#\d+|\b[A-Za-z][\w.-]*#\d+\b|(?<![\w&/#])#\d+\b/g],
    ['cron', /(?<![\w*,/-])[\d*,/-]+(?: [\d*,/-]+){4}(?![\w*,/-])/g],
    [
        'schedule',
        /\b(?:daily|nightly|hourly|weekly|fortnightly|monthly|twice an? (?:day|week|hour)|every (?:other )?(?:day|night|hour|week|month|\d+ (?:seconds?|minutes?|hours?|days?|weeks?))|\d{1,2}:\d\d ?(?:UTC|PT|PDT|PST|Pacific))\b/gi,
    ],
    // "shadow" as a state; the concept words (shadow mode, shadow runs, #agents-shadow) are not status.
    ['status', /(?<![-\w#])shadow\b(?! (?:mode|runs?)\b)|\b(?:is|are|went|goes|go|now|not yet|still|running|runs) live\b|\blive since\b/gi],
];
/** Fast-moving tokens in one line: versions, dates, PR numbers, schedules, live/shadow status. */
export function volatileTokens(line) {
    const out = [];
    for (const [kind, re] of VOLATILE) {
        for (const m of line.matchAll(re)) {
            const t = m[0].trim();
            if (kind === 'cron' && !(/\*/.test(t) && /\d/.test(t)))
                continue;
            out.push(`${kind} "${t}"`);
        }
    }
    return out;
}
function lineNo(text, offset) {
    let n = 1;
    for (let i = 0; i < offset && i < text.length; i++)
        if (text.charCodeAt(i) === 10)
            n++;
    return n;
}
function lineChecks(file, text, out) {
    text.split('\n').forEach((l, i) => {
        const c = chars(l);
        if (c > BUDGET().line)
            out.push({ level: 'FAIL', code: 'LINE', file, line: i + 1, detail: `${c} chars (budget ${BUDGET().line})` });
    });
}
function bulletChecks(file, text, firstLine, out) {
    const us = units(text);
    for (const u of us) {
        if (u.kind !== 'bullet')
            continue;
        const b = bytes(unitText(u));
        if (b > BUDGET().bullet)
            out.push({ level: 'FAIL', code: 'BULLET', file, line: firstLine + u.line - 1, detail: `${b} bytes (budget ${BUDGET().bullet})` });
    }
    return us;
}
function movedTldrChecks(file, text, out) {
    text.split('\n').forEach((l, i) => {
        if (/Summary moved from tldr|Former title line/i.test(l))
            out.push({ level: 'FAIL', code: 'MOVED-TLDR', file, line: i + 1, detail: 'tldr text moved out of the tldr; trim the tldr instead and lift still-true facts into the right section' });
    });
}
/** The H1 is `# <name>: <role>`; the INDEX row shows the role. */
function h1Check(doc, out) {
    const line = doc.h1 ? lineNo(doc.text, doc.text.indexOf(doc.h1, doc.frontEnd)) : undefined;
    const fail = (detail) => void out.push({ level: 'FAIL', code: 'H1', file: doc.file, line, detail });
    const prefix = `# ${doc.name}: `;
    if (!doc.h1.startsWith(prefix)) {
        fail(`H1 must read "${prefix}<role>"`);
        return;
    }
    const role = doc.h1.slice(prefix.length).trim();
    if (!role)
        fail('H1 has no role after the colon');
    if (chars(role) > BUDGET().h1Role)
        fail(`H1 role ${chars(role)} chars (budget ${BUDGET().h1Role})`);
    if (/—/.test(doc.h1))
        fail('H1 has an em-dash');
}
function docChecks(doc, out) {
    const file = doc.file;
    const size = bytes(doc.text);
    if (size > BUDGET().doc)
        out.push({ level: 'FAIL', code: 'DOC-SIZE', file, detail: `${(size / 1024).toFixed(1)} KB (budget ${BUDGET().doc / 1024} KB)` });
    lineChecks(file, doc.text, out);
    h1Check(doc, out);
    bulletChecks(file, doc.text.slice(doc.frontEnd), lineNo(doc.text, doc.frontEnd), out);
    movedTldrChecks(file, doc.text, out);
    for (const s of doc.sections) {
        const sb = bytes(doc.text.slice(s.start, s.end));
        if (sb > BUDGET().section)
            out.push({ level: 'FAIL', code: 'SECTION-SIZE', file, line: lineNo(doc.text, s.start), detail: `## ${s.id} ${(sb / 1024).toFixed(1)} KB (budget ${BUDGET().section / 1024} KB; ${SECTION_FILE_IDS().includes(s.id) ? `move it to repos/${doc.name}/${s.id}.md` : "trim it; it never moves to a section file"})` });
        if (s.id === 'tldr') {
            const c = chars(s.body.trim());
            if (c > BUDGET().tldr)
                out.push({ level: 'FAIL', code: 'TLDR', file, line: lineNo(doc.text, s.start), detail: `${c} chars (budget ${BUDGET().tldr})` });
        }
        if (s.id === 'recent') {
            const n = s.body.split('\n').filter((l) => l.trim()).length;
            if (n > BUDGET().recent)
                out.push({ level: 'FAIL', code: 'RECENT', file, line: lineNo(doc.text, s.start), detail: `${n} lines (budget ${BUDGET().recent})` });
        }
        const m = sectionHead(s.body).hasPointer ? s.body.split('\n').find((l) => POINTER_RE.test(l)).match(POINTER_RE) : undefined;
        if (m && m[1] !== `repos/${doc.name}/${s.id}.md`)
            out.push({ level: 'FAIL', code: 'SECTION-FILE', file, line: lineNo(doc.text, s.start), detail: `## ${s.id} points at ${m[1]}; it must be repos/${doc.name}/${s.id}.md` });
        if (m && !doc.sectionFiles[s.id])
            out.push({ level: 'FAIL', code: 'SECTION-FILE', file, line: lineNo(doc.text, s.start), detail: `## ${s.id} points at ${m[1]}, which does not exist` });
    }
    for (const sf of Object.values(doc.sectionFiles)) {
        const sz = bytes(sf.text);
        if (sz > BUDGET().sectionFile)
            out.push({ level: 'FAIL', code: 'SECTION-FILE-SIZE', file: sf.file, detail: `${(sz / 1024).toFixed(1)} KB (budget ${BUDGET().sectionFile / 1024} KB)` });
        if (!SECTION_FILE_IDS().includes(sf.id))
            out.push({ level: 'FAIL', code: 'SECTION-FILE', file: sf.file, detail: `## ${sf.id} never moves to a section file; it stays in the main doc` });
        else if (!doc.sections.some((s) => s.id === sf.id && sectionHead(s.body).hasPointer))
            out.push({ level: 'FAIL', code: 'SECTION-FILE', file: sf.file, detail: `${doc.file} ## ${sf.id} has no outline pointer to this file (run flax atlas outlines --write)` });
        lineChecks(sf.file, sf.text, out);
        bulletChecks(sf.file, sf.text, 1, out);
        movedTldrChecks(sf.file, sf.text, out);
    }
    for (const f of doc.otherFiles) {
        if (f.endsWith('/history.md'))
            out.push({ level: 'FAIL', code: 'HISTORY-FILE', file: f, detail: 'history files are retired: git and the PR list are the record; lift still-true rationale into the doc, then delete it' });
        else
            out.push({ level: 'FAIL', code: 'SECTION-FILE', file: f, detail: `not a section file (repos/${doc.name}/<one of ${SECTION_FILE_IDS().join(', ')}>.md)` });
    }
    for (const key of ['depends_on', 'used_by']) {
        const v = doc.fm[key];
        if (!Array.isArray(v))
            continue;
        const noted = v.filter((e) => e.trim() !== entryName(e));
        if (noted.length)
            out.push({ level: 'WARN', code: 'FRONT-NOTES', file, detail: `${key} has ${noted.length} entr${noted.length === 1 ? 'y' : 'ies'} with notes; frontmatter lists carry names only (the note belongs in ## role or ## interfaces)` });
    }
}
function glossaryChecks(file, text, us, out) {
    const size = bytes(text);
    if (size > BUDGET().glossary)
        out.push({ level: 'FAIL', code: 'GLOSSARY-SIZE', file, detail: `${(size / 1024).toFixed(1)} KB (budget ${BUDGET().glossary / 1024} KB)` });
    for (const u of us) {
        if (u.kind !== 'bullet')
            continue;
        const t = unitText(u);
        const c = chars(t);
        if (c > BUDGET().glossaryEntry)
            out.push({ level: 'FAIL', code: 'GLOSSARY-ENTRY', file, line: u.line, detail: `${c} chars (budget ${BUDGET().glossaryEntry})` });
        const plain = t.replace(/`[^`]*`/g, '');
        const term = plain.split(/ = |\*\*: |: /)[0];
        if ((plain.match(/ = /g) ?? []).length > 1 || / \/ |, /.test(term.replace(/^- /, '')))
            out.push({ level: 'WARN', code: 'GLOSSARY-TERMS', file, line: u.line, detail: 'looks like more than one term in one entry (one term per entry)' });
    }
}
function gapsChecks(file, text, us, known, out) {
    for (const u of us) {
        if (u.kind === 'heading' && /^#+\s+Resolved\b/i.test(u.lines[0]))
            out.push({ level: 'FAIL', code: 'GAPS-RESOLVED', file, line: u.line, detail: 'no Resolved section: delete answered entries (git keeps them)' });
        if (u.kind !== 'bullet')
            continue;
        const t = unitText(u);
        const c = chars(t);
        if (c > BUDGET().gapsEntry)
            out.push({ level: 'FAIL', code: 'GAPS-ENTRY', file, line: u.line, detail: `${c} chars (budget ${BUDGET().gapsEntry})` });
        const m = t.match(/^- (?:\*\*)?((?:\[[A-Za-z0-9_., -]+\]\s*)+)(?!\()/);
        if (!m) {
            out.push({ level: 'FAIL', code: 'GAPS-TAG', file, line: u.line, detail: 'entry does not start with its repo tag, e.g. "- [notes-api] ..."' });
            continue;
        }
        const tags = [...m[1].matchAll(/\[([^\]]+)\]/g)].flatMap((x) => x[1].split(',').map((s) => s.trim()));
        const unknown = tags.filter((tg) => !known.has(tg) && !GAPS_EXTRA_TAGS().includes(tg));
        if (unknown.length)
            out.push({ level: 'WARN', code: 'GAPS-TAG', file, line: u.line, detail: `unknown tag ${unknown.join(', ')} (a repo doc name, or ${GAPS_EXTRA_TAGS().join('/')})` });
    }
}
export function checkBudgets(root) {
    const out = [];
    const src = fsSource(root);
    const known = new Set(docNames(src));
    for (const n of known)
        docChecks(readDoc(src, n), out);
    // Section-file folders without a main doc.
    for (const d of readdirSync(join(root, 'repos'), { withFileTypes: true })) {
        if (d.isDirectory() && !known.has(d.name))
            out.push({ level: 'FAIL', code: 'SECTION-FILE', file: `repos/${d.name}/`, detail: 'folder without a repos/<name>.md' });
    }
    for (const f of SHARED()) {
        const p = join(root, f);
        if (!existsSync(p))
            continue;
        const text = readFileSync(p, 'utf8');
        lineChecks(f, text, out);
        const us = bulletChecks(f, text, 1, out);
        if (f === 'INDEX.md' && bytes(text) > BUDGET().index)
            out.push({ level: 'FAIL', code: 'INDEX-SIZE', file: f, detail: `${(bytes(text) / 1024).toFixed(1)} KB (budget ${BUDGET().index / 1024} KB)` });
        if (NO_VOLATILE().includes(f)) {
            let fence = false;
            text.split('\n').forEach((l, i) => {
                if (/^\s*```/.test(l))
                    fence = !fence;
                if (fence)
                    return;
                const toks = volatileTokens(l);
                if (toks.length)
                    out.push({ level: 'FAIL', code: 'VOLATILE', file: f, line: i + 1, detail: toks.join(', ') });
            });
        }
        if (f === 'GLOSSARY.md')
            glossaryChecks(f, text, us, out);
        if (f === 'GAPS.md')
            gapsChecks(f, text, us, known, out);
    }
    // Other markdown a session or the map reads: the line budget applies everywhere.
    for (const dir of ['viz', 'viz/flows', 'viz/prompts']) {
        const p = join(root, dir);
        if (!existsSync(p))
            continue;
        for (const f of readdirSync(p).sort())
            if (f.endsWith('.md'))
                lineChecks(`${dir}/${f}`, readFileSync(join(p, f), 'utf8'), out);
    }
    return out;
}
export function printFindings(findings, log) {
    const byCode = {};
    for (const f of findings) {
        log(`${f.level}-${f.code} ${f.detail}: ${f.file}${f.line ? `:${f.line}` : ''}`);
        const k = `${f.level}-${f.code}`;
        byCode[k] = (byCode[k] ?? 0) + 1;
    }
    return {
        fail: findings.filter((f) => f.level === 'FAIL').length,
        warn: findings.filter((f) => f.level === 'WARN').length,
        byCode,
    };
}
//# sourceMappingURL=budgets.js.map