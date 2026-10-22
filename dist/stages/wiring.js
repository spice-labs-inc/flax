// Stage 5 (ai): extract network / queue / data edges from the prose sections.
//
// Frontmatter gives us build dependencies for free. Everything about how the
// system behaves at runtime lives in `## role`, `## data` and `## interfaces`,
// which have no schema, so this is the one place the pipeline needs a model.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cache, pmap, sha } from '../pipeline/machine.js';
import { ask, DeferredError, FALLBACK_MODEL, MODEL, pickBackend, previousAnswer } from '../pipeline/llm.js';
import { MODEL_CALLS_AT_ONCE } from '../pipeline/model-socket.js';
import { config } from '../config.js';
export const SECTIONS = () => config().docs.wiringSections;
const LAYERS = ['network', 'queue', 'data'];
/** Docs with no runtime surface worth a model call. */
export function skip(fm) {
    const type = String(fm.type ?? '');
    const status = String(fm.status ?? '');
    if (config().map.wiringSkipTypes.includes(type))
        return true;
    // Parked and dead repos still appear as nodes; they just aren't worth a call.
    if (/^(archived|deprecated|parked)/.test(status))
        return true;
    return false;
}
export function validate(raw, ownIds) {
    if (!raw || typeof raw !== 'object')
        throw new Error('expected a JSON object');
    const edges = [];
    for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
        if (!e || typeof e !== 'object')
            continue;
        const { from, to, layer, label } = e;
        if (typeof from !== 'string' || typeof to !== 'string')
            continue;
        if (!from.trim() || !to.trim() || from === to)
            continue;
        if (!LAYERS.includes(layer))
            throw new Error(`layer must be one of ${LAYERS.join('|')}, got ${JSON.stringify(layer)}`);
        if (typeof label !== 'string' || !label.trim())
            throw new Error('every edge needs a non-empty label');
        edges.push({
            from: from.trim(),
            to: to.trim(),
            layer,
            label: label.trim().slice(0, 60),
            detail: typeof e.detail === 'string' ? e.detail.trim() : undefined,
            anchor: typeof e.anchor === 'string' ? e.anchor.trim() : undefined,
            unverified: e.unverified === true,
        });
    }
    const infra = [];
    for (const n of Array.isArray(raw.infra) ? raw.infra : []) {
        if (!n || typeof n.id !== 'string' || !n.id.trim())
            continue;
        const kind = ['queue', 'broker', 'store', 'external', 'registry'].includes(n.kind) ? n.kind : 'store';
        infra.push({
            id: n.id.trim(),
            kind,
            label: typeof n.label === 'string' && n.label.trim() ? n.label.trim() : n.id.trim(),
            role: typeof n.role === 'string' ? n.role.trim() : undefined,
        });
    }
    if (edges.length === 0 && infra.length === 0 && ownIds.length && raw.edges === undefined) {
        throw new Error('missing "edges" key');
    }
    return { edges, infra, ...(typeof raw.model === 'string' ? { model: raw.model } : {}) };
}
export const wiring = {
    id: 'wiring',
    kind: 'ai',
    title: 'Extract network / queue / data wiring from prose',
    async run(ctx) {
        const atlas = ctx.out.atlas;
        const idx = ctx.out.components;
        const cache = new Cache(join(ctx.vizRoot, 'cache', 'wiring'), !ctx.noCache);
        // The workspace may carry its own prompt under <viz>/prompts/; the package's is the default.
        const own = join(ctx.vizRoot, 'prompts', 'extract-wiring.md');
        const template = readFileSync(existsSync(own) ? own : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'extract-wiring.md'), 'utf8');
        const componentIds = Object.keys(idx.ownerOf).sort().join(', ');
        const targets = atlas.repos.filter((d) => !skip(d.fm));
        ctx.log(`        ${targets.length} docs to analyse (backend: ${pickBackend()}, model: ${MODEL || 'none'}${FALLBACK_MODEL ? `, fallback: ${FALLBACK_MODEL}` : ''})`);
        // Which cache entry each doc's wiring came from, last time a graph was
        // emitted. A prompt-hash miss reuses exactly that entry rather than
        // whichever old extraction happens to be newest on disk: there are up to
        // nine per doc, and a fresh clone gives them all the same mtime, so
        // "newest" is not a real answer. Written by the emit stage.
        const pins = (() => {
            const p = join(ctx.vizRoot, 'data', 'wiring-keys.json');
            if (!existsSync(p))
                return {};
            try {
                return JSON.parse(readFileSync(p, 'utf8'));
            }
            catch {
                return {};
            }
        })();
        // The wiring sections each answer in use was made from, written by the emit
        // stage. A doc with no entry yet counts as unchanged, so the first run
        // records a baseline instead of re-extracting every doc.
        const madeFrom = (() => {
            const p = join(ctx.vizRoot, 'data', 'wiring-sections.json');
            if (!existsSync(p))
                return {};
            try {
                return JSON.parse(readFileSync(p, 'utf8'));
            }
            catch {
                return {};
            }
        })();
        const usedKeys = {};
        const usedSections = {};
        let callsLeft = ctx.maxExtractions ?? Infinity;
        let done = 0;
        let reused = 0;
        const reusedOlder = [];
        const reextracted = [];
        const fellBack = [];
        const replaced = {};
        const results = await pmap(targets, MODEL_CALLS_AT_ONCE(), async (doc) => {
            const sections = SECTIONS().filter((s) => doc.sections[s])
                .map((s) => `## ${s}\n\n${doc.sections[s]}`)
                .join('\n\n');
            if (!sections.trim())
                return { edges: [], infra: [] };
            const ownIds = idx.componentsOf[doc.name] ?? [];
            const prompt = template
                .replace('{{REPO}}', doc.name)
                .replace('{{OWN_COMPONENTS}}', ownIds.join(', ') || doc.name)
                .replace('{{SECTIONS}}', sections)
                .replace('{{COMPONENT_IDS}}', componentIds);
            const sectionsHash = sha(sections);
            const before = madeFrom[doc.name];
            const changed = before !== undefined && before !== sectionsHash;
            const extractAgain = ctx.reextractChanged === true && changed;
            let reusedOld = false;
            const cacheKey = `wiring/${doc.name}`;
            const parse = (raw) => validate(raw, ownIds);
            const askFor = (reuseStale) => ask({
                cacheKey,
                // Keyed by this doc's wiring sections (section files included) and the
                // extraction instructions, so only a doc whose own text changed re-extracts.
                keyInput: `${sha(template)}\n${sections}`,
                prompt,
                cache,
                reuseStale,
                reuseKey: pins[doc.name],
                onReuse: () => { reusedOld = true; },
                onResolved: (k) => { usedKeys[doc.name] = k; },
                parse,
                mayCall: () => callsLeft-- > 0,
                fallback: true,
                onFallback: (why) => ctx.log(`        ! ${doc.name}: ${MODEL} failed, asking ${FALLBACK_MODEL} once: ${why}`),
                onAnswer: (model) => {
                    ctx.log(`        ${doc.name}: answer made by ${model}`);
                    if (model === FALLBACK_MODEL)
                        fellBack.push(doc.name);
                },
                withModel: (value, model) => ({ ...value, model }),
            });
            try {
                let res;
                // Read before asking: once a new answer is cached, the newest entry is no longer the previous one.
                const previous = extractAgain ? previousAnswer({ cacheKey, reuseKey: pins[doc.name], parse, cache }) : undefined;
                try {
                    res = await askFor(ctx.reuseStale && !extractAgain);
                    if (extractAgain)
                        reextracted.push(doc.name);
                    if (previous && previous.key !== usedKeys[doc.name]) {
                        for (const e of previous.value.edges)
                            e.origin = doc.name;
                        for (const i of previous.value.infra)
                            i.origin = doc.name;
                        replaced[doc.name] = { answer: previous.value, key: previous.key, sections: before ?? sectionsHash };
                    }
                }
                catch (e) {
                    if (!extractAgain)
                        throw e;
                    if (e instanceof DeferredError) {
                        ctx.log(`        ! ${doc.name}: re-extraction deferred to a later run (this run's model calls are used up), keeping the previous answer`);
                    }
                    else {
                        ctx.log(`        ! ${doc.name}: re-extraction failed, keeping the previous answer: ${e instanceof Error ? e.message : String(e)}`);
                    }
                    res = await askFor(true);
                }
                // A reused answer keeps the sections it was made from, so a later run still sees the change.
                usedSections[doc.name] = reusedOld ? (before ?? sectionsHash) : sectionsHash;
                if (reusedOld) {
                    reused++;
                    if (changed)
                        reusedOlder.push(doc.name);
                }
                for (const e of res.edges)
                    e.origin = doc.name;
                for (const i of res.infra)
                    i.origin = doc.name;
                return res;
            }
            catch (e) {
                ctx.log(`        ! ${doc.name}: ${e instanceof Error ? e.message : String(e)}`);
                return { edges: [], infra: [] };
            }
            finally {
                if (++done % 10 === 0)
                    ctx.log(`        ${done}/${targets.length}`);
            }
        });
        if (reextracted.length) {
            ctx.log(`        ${reextracted.length} re-extracted because their sections changed: ${reextracted.sort().join(', ')}`);
        }
        if (fellBack.length) {
            ctx.log(`        ${fellBack.length} answered by the fallback model ${FALLBACK_MODEL}: ${fellBack.sort().join(', ')}`);
        }
        if (reused) {
            ctx.log(`        ${reused}/${targets.length} reused an earlier extraction (no model calls)`);
        }
        if (reusedOlder.length) {
            ctx.log(`        ${reusedOlder.length} of them were made from older text of their wiring sections; ` +
                `the map shows their old wiring until a run with --reextract-changed: ${reusedOlder.sort().join(', ')}`);
        }
        // A per-doc failure is survivable; losing most of them is not. Silently
        // emitting an empty graph once produced a green build that deployed a map
        // with no connections on it.
        const failed = results.filter((r) => r.edges.length === 0 && r.infra.length === 0).length;
        if (targets.length && failed / targets.length > 0.3) {
            throw new Error(`wiring extraction failed for ${failed}/${targets.length} documents — refusing to ` +
                `emit a graph this incomplete. Either set ${config().llm.modelEnv} and make its backend ` +
                'reachable (a model socket, ANTHROPIC_API_KEY, or the claude CLI on ' +
                'PATH) to re-extract, or pass --reuse-wiring to keep the wiring already in the cache.');
        }
        const edges = results.flatMap((r) => r.edges);
        const infra = results.flatMap((r) => r.infra);
        ctx.log(`        ${edges.length} raw edges, ${infra.length} raw infra nodes`);
        return { edges, infra, keys: usedKeys, sections: usedSections, replaced };
    },
};
//# sourceMappingURL=wiring.js.map