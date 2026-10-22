// Stage 7 (code): read the curated guided flows.
//
// These used to be generated. They aren't any more: a flow is a teaching
// narrative, and the people who know what a journey should say are faster at
// writing it than at correcting a model that keeps almost getting it right.
// Everything else in the graph is still derived from the atlas.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, planeIds } from '../config.js';
const LAYERS = ['network', 'queue', 'data', 'build', 'delivery'];
function parseFrontmatter(txt) {
    const m = txt.match(/^---\n([\s\S]*?)\n---/);
    const fm = {};
    if (!m)
        return fm;
    for (const line of m[1].split('\n')) {
        const mm = line.match(/^([a-z]+):\s*(.*)$/);
        if (mm)
            fm[mm[1]] = mm[2].trim();
    }
    return fm;
}
/**
 * One step per `## ` heading. The heading is the step title; `key: value` lines
 * under it carry the wiring; everything after the blank line is the detail
 * shown in the player.
 */
function parseSteps(body, file, warn) {
    const steps = [];
    for (const chunk of body.split(/\n## /).slice(1)) {
        const nl = chunk.indexOf('\n');
        const title = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
        const rest = nl === -1 ? '' : chunk.slice(nl + 1);
        const meta = {};
        const detailLines = [];
        let inDetail = false;
        for (const line of rest.split('\n')) {
            const kv = line.match(/^([a-z]+):\s*(.*)$/);
            if (!inDetail && kv) {
                meta[kv[1]] = kv[2].trim();
                continue;
            }
            if (!inDetail && !line.trim()) {
                inDetail = true;
                continue;
            }
            inDetail = true;
            detailLines.push(line);
        }
        if (!meta.from || !meta.to) {
            warn(`${file}: step "${title}" is missing from:/to: — skipped`);
            continue;
        }
        if (meta.layer && !LAYERS.includes(meta.layer)) {
            warn(`${file}: step "${title}" has layer "${meta.layer}", expected one of ${LAYERS.join('|')}`);
        }
        steps.push({
            from: meta.from,
            to: meta.to,
            layer: (LAYERS.includes(meta.layer) ? meta.layer : 'network'),
            title,
            detail: detailLines.join('\n').replace(/\s*\n\s*/g, ' ').trim(),
            anchor: meta.anchor || undefined,
        });
    }
    return steps;
}
export const flows = {
    id: 'flows',
    kind: 'code',
    title: 'Read curated guided flows',
    async run(ctx) {
        const dir = join(ctx.vizRoot, 'flows');
        if (!existsSync(dir)) {
            ctx.log('        no flows/ directory — skipping');
            return [];
        }
        const out = [];
        const warnings = [];
        const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
        const PLANES = planeIds();
        const fallbackPlane = config().planes[0].id;
        for (const file of files) {
            const txt = readFileSync(join(dir, file), 'utf8');
            const fm = parseFrontmatter(txt);
            const id = fm.id || file.replace(/^\d+[-.]?/, '').replace(/\.md$/, '');
            if (fm.plane && !PLANES.includes(fm.plane)) {
                warnings.push(`${file}: plane "${fm.plane}" is not a known plane`);
            }
            const steps = parseSteps(txt, file, (w) => warnings.push(w));
            if (!steps.length) {
                warnings.push(`${file}: no usable steps`);
                continue;
            }
            out.push({
                id,
                name: fm.name || id,
                plane: (PLANES.includes(fm.plane) ? fm.plane : fallbackPlane),
                summary: fm.summary || '',
                steps,
            });
        }
        for (const w of warnings)
            ctx.log(`        ! ${w}`);
        ctx.log(`        ${out.length} flows, ${out.reduce((n, f) => n + f.steps.length, 0)} steps, from ${files.length} files`);
        return out;
    },
};
//# sourceMappingURL=flows.js.map