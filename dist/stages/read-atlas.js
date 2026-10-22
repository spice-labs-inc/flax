// Stage 1 (code): parse every atlas doc into frontmatter + stable-id sections.
// A section that lives in a section file (repos/<name>/<section>.md) is read
// whole from there, so later stages see the full text, not the main doc's outline.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fsSource, fullSections, readDocs } from '../atlas/doc.js';
export { parseSections } from '../atlas/doc.js';
export const readAtlas = {
    id: 'atlas',
    kind: 'code',
    title: 'Read atlas docs (frontmatter + sections, section files resolved)',
    async run(ctx) {
        const repos = [];
        for (const doc of readDocs(fsSource(ctx.atlasRoot))) {
            const name = String(doc.fm.name ?? doc.name);
            if (ctx.only && !ctx.only.includes(name))
                continue;
            repos.push({ name, file: doc.file, fm: doc.fm, sections: fullSections(doc) });
        }
        ctx.log(`        ${repos.length} repo docs`);
        const optional = (f) => (existsSync(join(ctx.atlasRoot, f)) ? readFileSync(join(ctx.atlasRoot, f), 'utf8') : '');
        return {
            repos,
            architecture: optional('ARCHITECTURE.md'),
            machines: optional('MACHINES.md'),
            index: optional('INDEX.md'),
        };
    },
};
//# sourceMappingURL=read-atlas.js.map