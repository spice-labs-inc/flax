// The tag -> component join, read from subjects.md.
//
// Shared by the shared-dependency and advisory stages: both start from the same
// survey tags and both have to answer "which component is this". Keeping one
// reader means a mapping fixed for one is fixed for the other, and an ignore
// list maintained once.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Parse subjects.md. Fenced blocks are examples, not data — the file documents
 * its own format, and reading the samples as real entries would silently seed
 * mappings nobody wrote.
 */
export function readSubjectMap(vizRoot) {
    const explicit = new Map();
    const exact = new Set();
    const prefixes = [];
    const path = join(vizRoot, 'subjects.md');
    if (existsSync(path)) {
        let section = '';
        let fenced = false;
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            if (line.startsWith('```')) {
                fenced = !fenced;
                continue;
            }
            if (fenced)
                continue;
            const head = line.match(/^##\s+(.*)$/);
            if (head) {
                section = head[1].trim().toLowerCase();
                continue;
            }
            const text = line.trim();
            if (!text || text.startsWith('<!--') || text.startsWith('#'))
                continue;
            if (section === 'mappings') {
                // Both sides must look like a bare identifier. A loose match reads the
                // section's own prose as data — "One `tag -> component` per line"
                // parses perfectly well as a mapping otherwise.
                const m = text.match(/^([\w.@/-]+)\s*->\s*([\w.@/-]+)$/);
                if (m)
                    explicit.set(m[1], m[2]);
            }
            else if (section === 'ignore') {
                if (!/^[\w.@/*-]+$/.test(text))
                    continue;
                if (text.endsWith('*'))
                    prefixes.push(text.slice(0, -1));
                else
                    exact.add(text);
            }
        }
    }
    return {
        explicit,
        ignored: (name) => exact.has(name) || prefixes.some((p) => name.startsWith(p)),
    };
}
/**
 * Which component a tag is, or undefined when nothing says. A tag named exactly
 * like a component id or label matches automatically, so subjects.md only ever
 * has to carry the exceptions.
 */
export function componentForSubject(subject, map, byId, byLabel) {
    const explicit = map.explicit.get(subject);
    if (explicit)
        return explicit;
    if (byId.has(subject))
        return subject;
    return byLabel.get(subject.toLowerCase());
}
/** Every curated target must name a real node; a typo silently drops a component. */
export function assertTargetsExist(map, byId) {
    for (const [subject, target] of map.explicit) {
        if (!byId.has(target)) {
            throw new Error(`subjects.md maps "${subject}" to "${target}", which is not a node in the graph. ` +
                'A typo here would quietly drop a component out of the layer, so this is fatal.');
        }
    }
}
//# sourceMappingURL=subject-map.js.map