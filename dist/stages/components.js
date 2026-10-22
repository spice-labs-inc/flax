// Stages 2-4 (code): repo visibility, the repo -> component split, and the
// build-dependency layer.
//
// A repo is not the unit of architecture. Several repos ship more than one
// deployable thing (one workspace repo can build an engine, its job store, a
// storage proxy and a CLI image), so components are discovered from each doc's
// `artifacts:` line and enriched from map.components in flax.yml.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
export const planeFor = (doc) => {
    const rules = config().map.planeRules;
    for (const [plane, repos] of Object.entries(rules.byRepo))
        if (repos.includes(doc.name))
            return plane;
    const type = String(doc.fm.type ?? '');
    if (type === 'infra' && rules.byType.infra === undefined) {
        // Terraform/OpenTofu repos say how an environment is PROVISIONED, not what
        // runs in one; their module catalogues read as runtime wiring, so they go
        // with delivery. Infra repos that ship something that runs stay in infra.
        return new RegExp(rules.infraLanguages, 'i').test(String(doc.fm.language ?? '')) ? rules.infraLanguagePlane : config().map.infraPlane;
    }
    return rules.byType[type] ?? rules.fallback;
};
function normStatus(raw) {
    const s = raw.toLowerCase();
    for (const c of config().enums.status)
        if (s.startsWith(c))
            return c;
    return config().enums.status[0] ?? 'active';
}
/** Image basenames declared in the doc's `artifacts:` line, under the org's registry prefix. */
function imagesFrom(artifacts) {
    const out = [];
    const reg = config().org.registry;
    if (!reg)
        return out;
    const re = new RegExp(reg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/([a-z0-9_.-]+)', 'i');
    for (const a of artifacts) {
        const m = a.match(re);
        if (m && !m[1].startsWith('charts'))
            out.push(m[1].toLowerCase());
    }
    return [...new Set(out)];
}
// -- Stage 2 -----------------------------------------------------------------
export const visibility = {
    id: 'visibility',
    kind: 'code',
    title: 'Repo visibility from GitHub (public / internal / private)',
    async run(ctx) {
        const cachePath = join(ctx.vizRoot, 'data', 'visibility.json');
        try {
            if (!config().org.github)
                throw new Error('no org.github in config');
            const raw = execFileSync('gh', ['api', '--paginate', `orgs/${config().org.github}/repos?per_page=100`, '--jq', '.[] | {name, visibility}'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
            const map = {};
            for (const line of raw.trim().split('\n')) {
                if (!line)
                    continue;
                const { name, visibility } = JSON.parse(line);
                map[name] = visibility;
            }
            writeFileSync(cachePath, JSON.stringify(map, null, 1));
            ctx.log(`        ${Object.keys(map).length} repos from gh`);
            return map;
        }
        catch (e) {
            if (existsSync(cachePath)) {
                ctx.log(`        gh unavailable, using cached visibility.json`);
                return JSON.parse(readFileSync(cachePath, 'utf8'));
            }
            ctx.log(`        gh unavailable and no cache; visibility unknown`);
            return {};
        }
    },
};
export const components = {
    id: 'components',
    kind: 'code',
    title: 'Split repos into components',
    async run(ctx) {
        const atlas = ctx.out.atlas;
        const vis = ctx.out.visibility;
        const repoNames = new Set(atlas.repos.map((r) => r.name));
        const nodes = [];
        const ownerOf = {};
        const componentsOf = {};
        for (const doc of atlas.repos) {
            const artifacts = doc.fm.artifacts ?? [];
            const declared = config().map.components[doc.name];
            // Discovered images that belong to THIS repo (an image whose name matches
            // a different repo is that repo's component, built here as a convenience).
            const discovered = imagesFrom(artifacts).filter((img) => img === doc.name || !repoNames.has(img));
            const specs = declared
                ? [...declared]
                : [{ id: doc.name, label: doc.name, role: '' }];
            if (declared) {
                for (const img of discovered) {
                    if (!specs.some((s) => s.id === img || s.label === img)) {
                        specs.push({ id: img, label: img, role: `Image built from the ${doc.name} repo.` });
                    }
                }
            }
            const tldr = (doc.sections.tldr ?? '').replace(/\s+/g, ' ').trim();
            const plane = planeFor(doc);
            const status = normStatus(String(doc.fm.status ?? 'active'));
            const visibilityValue = vis[doc.name] ?? 'internal';
            const ids = specs.map((s) => s.id);
            for (const spec of specs) {
                nodes.push({
                    id: spec.id,
                    label: spec.label,
                    kind: spec.kind ?? (String(doc.fm.type) === 'library' ? 'library' : 'component'),
                    plane,
                    status,
                    visibility: spec.visibility ?? visibilityValue,
                    repo: doc.name,
                    siblings: ids.filter((i) => i !== spec.id),
                    language: doc.fm.language ? String(doc.fm.language) : undefined,
                    type: doc.fm.type ? String(doc.fm.type) : undefined,
                    deploy: doc.fm.deploy ? String(doc.fm.deploy) : undefined,
                    artifacts,
                    tldr: spec.id === doc.name || specs.length === 1 ? tldr : undefined,
                    role: spec.role || undefined,
                    doc: doc.file,
                });
                ownerOf[spec.id] = doc.name;
            }
            componentsOf[doc.name] = ids;
        }
        const compound = Object.entries(componentsOf).filter(([, v]) => v.length > 1);
        ctx.log(`        ${nodes.length} components from ${atlas.repos.length} repos (${compound.length} compound)`);
        return { nodes, ownerOf, componentsOf };
    },
};
// -- Stage 4 -----------------------------------------------------------------
export const buildEdges = {
    id: 'buildEdges',
    kind: 'code',
    title: 'Build/code dependency layer from depends_on',
    async run(ctx) {
        const atlas = ctx.out.atlas;
        const idx = ctx.out.components;
        const edges = [];
        const seen = new Set();
        /** depends_on entries carry parenthesised notes: "notes-core (fork, worker image)". */
        const resolve = (entry) => {
            const note = (entry.match(/\(([^)]*)\)/)?.[1] ?? '').trim();
            const bare = entry.replace(/\([^)]*\)/g, '').trim().toLowerCase();
            if (!bare)
                return null;
            if (idx.ownerOf[bare])
                return { target: bare, note };
            const primary = idx.componentsOf[bare]?.[0];
            return primary ? { target: primary, note } : null;
        };
        for (const doc of atlas.repos) {
            const sources = idx.componentsOf[doc.name] ?? [];
            const from = sources[0];
            if (!from)
                continue;
            for (const entry of (doc.fm.depends_on ?? [])) {
                const r = resolve(entry);
                if (!r || r.target === from)
                    continue;
                const id = `build:${from}->${r.target}`;
                if (seen.has(id))
                    continue;
                seen.add(id);
                edges.push({
                    id,
                    source: from,
                    target: r.target,
                    layer: 'build',
                    label: r.note || 'depends on',
                    detail: `${doc.name} declares ${entry} in depends_on.`,
                    anchor: `${doc.file} frontmatter`,
                });
            }
        }
        ctx.log(`        ${edges.length} build edges`);
        return edges;
    },
};
//# sourceMappingURL=components.js.map