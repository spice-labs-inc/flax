// Stage 6 (code): environments, the machine fleet, and the delivery layer.
import { config } from '../config.js';
const sites = () => config().map.sites.map((s) => ({ id: s.id, label: s.label, role: s.role, host: new RegExp(s.host ?? '$^') }));
/** Published sites, one target per product surface, chosen by the host the deploy line names. */
function siteOf(deploy) {
    const SITES = sites();
    const host = deploy.match(/github pages at ([a-z0-9.-]+)/)?.[1];
    const site = (host && SITES.find((s) => s.host.test(host))) || (/\bdocs\b/.test(deploy) && SITES.find((s) => s.host.test('docs.'))) || SITES[0];
    return site ? { id: site.id, label: host ?? 'GitHub Pages' } : { id: 'ship:site', label: host ?? 'GitHub Pages' };
}
/** Where things ship when it is not a cluster or a box: the sites plus the configured outlets. */
const outlets = () => [...config().map.sites.map(({ id, label, role }) => ({ id, label, role })), ...config().map.outlets];
/**
 * The delivery outlets a repo doc's `type` and `deploy` frontmatter name, with
 * the edge label each one gets. Read from the atlas, never inferred from code.
 */
export function outletsOf(type, deploy) {
    const out = [];
    const historic = /historical|historic\)/.test(deploy);
    const named = (pairs) => pairs.filter(([re]) => re.test(deploy)).map(([, l]) => l);
    if (type === 'gh-action') {
        const ref = deploy.match(/@(v\d[\w.-]*)/)?.[1] ?? deploy.match(/tags: (v\d[\w.-]*)/)?.[1];
        out.push({ id: 'ship:actions', label: ref ? `@${ref}` : 'by ref' });
    }
    if (deploy.includes('github pages') && !historic) {
        out.push(siteOf(deploy));
    }
    if (!deploy.startsWith('none') && !historic && (type === 'library' || /maven central|github packages/.test(deploy))) {
        const regs = named([[/maven central|maven \(central/, 'Maven Central'], [/github packages/, 'GitHub Packages'], [/\bnpm\b/, 'npm'], [/\bcrates\b/, 'crates.io']]);
        if (regs.length)
            out.push({ id: 'ship:libraries', label: regs.join(' + ') });
    }
    const envNames = config().map.environments.map((e) => e.label).join('|');
    const gitops = config().map.gitops.repo;
    const viaCluster = new RegExp(`^(${envNames || '$^'})\\b${gitops ? `|${gitops}` : ''}`).test(deploy);
    if (type !== 'gh-action' && type !== 'library' && !viaCluster && !historic) {
        const channels = named([[/docker hub/, 'Docker Hub'], [/github release (binaries|assets|tarball)|release assets|on github releases/, 'GitHub Release'], [/install\.(sh|ps1)|installer/, 'installer']]);
        if (channels.length)
            out.push({ id: 'ship:releases', label: channels.join(' + ') });
    }
    if (/github actions workflows run on|runs entirely as scheduled github actions|gh action syncs/.test(deploy)) {
        out.push({ id: 'ship:ci', label: deploy.includes('agents') ? 'agents pool' : 'scheduled workflow' });
    }
    return out;
}
/**
 * Which known components a MACHINES.md `runs` cell names.
 *
 * The cell is prose written for people: "notes-worker + notes.example", "notes-core
 * fixtures, mirror data", "idle dev/scratch (notes-worker)". Splitting it into
 * tokens and demanding an exact match finds the
 * first of those and misses the other two, so instead the whole cell is scanned
 * for each component name as a whole word — which reads a name wherever it sits
 * in the sentence, parentheses included.
 *
 * Names shorter than three characters are skipped: they match inside ordinary
 * words far more often than they identify anything.
 */
function componentsNamedIn(runs, candidates) {
    const cell = runs.toLowerCase();
    // A parenthetical is as likely to record a departure as a resident: one box's
    // reads "(notes-worker moved to box2 2026-07-30; proxy retired)", and taking
    // names out of it asserts the opposite of what it says. So the aside counts
    // only when it is not describing something leaving.
    const departure = /moved|retired|removed|migrated|no longer|formerly|decommission/;
    const searchable = [cell.replace(/\([^)]*\)/g, ' ')];
    for (const [, aside] of cell.matchAll(/\(([^)]*)\)/g)) {
        if (!departure.test(aside))
            searchable.push(aside);
    }
    const haystack = searchable.join(' ');
    return candidates.filter((id) => {
        if (id.length < 3)
            return false;
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^a-z0-9-])${escaped}([^a-z0-9-]|$)`).test(haystack);
    });
}
/** Parse the fleet table in MACHINES.md rather than hardcoding the boxes. */
function parseMachines(machinesMd) {
    const nodes = [];
    const runsOn = new Map();
    const deployOf = new Map();
    const rows = machinesMd.split('\n').filter((l) => l.startsWith('| ') && l.split('|').length > 6);
    for (const row of rows) {
        const cells = row.split('|').map((c) => c.trim());
        const name = cells[1]?.replace(/\*\*/g, '');
        if (!name || ['box', 'total', ''].includes(name.toLowerCase()))
            continue;
        if (!/^[a-z][a-z0-9-]*$/.test(name))
            continue;
        const [cpu, ram, , , runners, deploy, runs] = cells.slice(2);
        nodes.push({
            id: `machine:${name}`,
            label: name,
            kind: 'machine',
            plane: config().map.infraPlane,
            status: 'active',
            visibility: 'n/a',
            curated: true,
            role: `${cpu}, ${ram} RAM. Runs: ${runs || 'nothing'}.${runners && runners !== '—' ? ` ${runners.replace(/\*\*/g, '')} GHA runners.` : ''}`,
            deploy: deploy && deploy !== '—' ? deploy.replace(/\*\*/g, '') : undefined,
            doc: 'MACHINES.md',
        });
        runsOn.set(`machine:${name}`, runs ?? '');
        deployOf.set(`machine:${name}`, (deploy ?? '').replace(/\*\*/g, '').toLowerCase());
    }
    return { nodes, runsOn, deployOf };
}
export const infra = {
    id: 'infra',
    kind: 'code',
    title: 'Environments, machine fleet, delivery layer',
    async run(ctx) {
        const atlas = ctx.out.atlas;
        const idx = ctx.out.components;
        const nodes = [];
        const edges = [];
        const c = config().map;
        const envNames = c.environments.map((e) => e.label).join('|') || '$^';
        for (const e of c.environments) {
            nodes.push({ id: e.id, label: e.label, kind: 'env', plane: e.plane ?? c.infraPlane, status: 'active', visibility: 'n/a', role: e.role, curated: true, doc: e.doc ?? 'ARCHITECTURE.md' });
        }
        for (const d of c.deliveryNodes) {
            nodes.push({ id: d.id, label: d.label, kind: d.kind ?? 'component', plane: d.plane ?? c.deliveryPlane, status: 'active', visibility: 'n/a', role: d.role, curated: true, doc: d.doc ?? 'ARCHITECTURE.md' });
        }
        for (const o of outlets()) {
            nodes.push({ id: o.id, label: o.label, kind: 'outlet', plane: c.deliveryPlane, status: 'active', visibility: 'n/a', role: o.role, curated: true });
        }
        const { nodes: machines, runsOn, deployOf } = parseMachines(atlas.machines);
        nodes.push(...machines);
        const machineIds = new Set(machines.map((m) => m.label));
        const push = (e) => {
            if (!edges.some((x) => x.id === e.id))
                edges.push(e);
        };
        // Curated delivery and network edges from the config (reconcilers, gateways, fan-outs).
        const curated = (phase) => {
            for (const { phase: p, ...e } of c.curatedEdges)
                if ((p ?? 'before') === phase)
                    push({ ...e, layer: e.layer });
        };
        curated('before');
        for (const doc of atlas.repos) {
            const primary = idx.componentsOf[doc.name]?.[0];
            if (!primary)
                continue;
            const deploy = String(doc.fm.deploy ?? '').toLowerCase();
            for (const o of outletsOf(String(doc.fm.type ?? '').toLowerCase(), deploy)) {
                push({ id: `delivery:${primary}->${o.id}`, source: primary, target: o.id, layer: 'delivery', label: o.label, detail: `${doc.name} deploy: ${String(doc.fm.deploy ?? 'none')}`, anchor: `${doc.file} deploy` });
            }
            if (!deploy || deploy === 'none')
                continue;
            const deps = (doc.fm.depends_on ?? []).map((d) => d.toLowerCase());
            const has = (s) => deps.some((d) => d.startsWith(s));
            const apply = c.delivery.applyTool;
            const applied = apply ? deploy.match(new RegExp(`^(${envNames}) via ${apply.name}`))?.[1] : undefined;
            if (apply && applied) {
                const env = c.environments.find((e) => e.label === applied);
                push({ id: `delivery:${primary}->${env.id}`, source: primary, target: env.id, layer: 'delivery', label: apply.label, detail: `${doc.name} is applied to ${applied} by ${apply.title ?? apply.name}: ${apply.detail}`, anchor: `${doc.file} deploy` });
            }
            // A Docker Hub image is not a registry one, so a bare "image" proves nothing.
            const artifacts = String(doc.fm.artifacts ?? '').toLowerCase();
            const reg = c.delivery;
            const pin = (names) => names.some(has);
            if (reg.registryNode && doc.fm.type !== 'gh-action' && (deploy.includes(reg.registryMatch) || artifacts.includes(reg.registryMatch) || has('action-publish-image'))) {
                push({ id: `delivery:${primary}->registry`, source: primary, target: reg.registryNode, layer: 'delivery', label: 'publish.yml', detail: `${doc.name} publishes its image${deploy.includes('chart') ? ' and chart' : ''} to ${reg.registryMatch} on merge to main.`, anchor: `${doc.file} ## cicd` });
                // Build images, CI caches and released tools land on the registry without a gitops pin.
                if (c.gitops.repo && (has(c.gitops.repo) || pin(reg.pinActions.immediate) || pin(reg.pinActions.pr) || deploy.includes(c.gitops.repo)))
                    push({ id: `delivery:registry->${c.gitops.repo}:${primary}`, source: reg.registryNode, target: c.gitops.repo, layer: 'delivery', label: pin(reg.pinActions.pr) ? 'pin (PR for prod)' : 'pin commit', detail: pin(reg.pinActions.pr) ? `${reg.pinActions.immediate.join('/')} writes the staging pin; ${reg.pinActions.pr.join('/')} opens a reviewed PR for prod.` : `${reg.pinActions.immediate.join('/') || 'the release action'} commits the pin straight to ${c.gitops.repo} main.`, anchor: [...reg.pinActions.immediate, ...reg.pinActions.pr].join(' / ') });
            }
            // Compose stacks name their box in the deploy line. Whole word:
            // a substring test gives `stor` every deploy line mentioning "storage".
            for (const box of machineIds) {
                if (new RegExp(`(^|[^a-z0-9-])${box}([^a-z0-9-]|$)`).test(deploy)) {
                    if (c.gitops.machineReconciler)
                        push({ id: `delivery:${primary}->machine:${box}`, source: c.gitops.machineReconciler, target: `machine:${box}`, layer: 'delivery', label: `${doc.name} stack`, detail: `${doc.name} runs on ${box} as a gitops-managed compose stack.`, anchor: `${c.gitops.repo} apps/${c.gitops.machinesDir}/${box}/` });
                    push({ id: `data:${primary}->machine:${box}`, source: primary, target: `machine:${box}`, layer: 'data', label: 'runs on', detail: `${doc.name} executes on the ${box} bare-metal box.`, anchor: 'MACHINES.md' });
                }
            }
        }
        curated('after');
        const componentIds = Object.keys(idx.ownerOf);
        // What each box runs, per the MACHINES.md `runs` column.
        //
        // Read, but NOT drawn. The gitops repo is the source of truth for what is
        // deployed on a box (it is what the reconcile timer actually applies),
        // whereas this column is prose maintained by hand and drifts: it keeps
        // crediting a box with a stack long after another one replaced it. The
        // deployments stage draws the gitops answer; this feeds a drift report so stale prose is
        // visible instead of silently contradicting the map.
        const machineRuns = {};
        for (const machine of machines) {
            machineRuns[machine.id] = componentsNamedIn(runsOn.get(machine.id) ?? '', componentIds);
        }
        ctx.log(`        ${nodes.length} infra nodes, ${edges.length} delivery edges`);
        return { nodes, edges, machineRuns };
    },
};
//# sourceMappingURL=infra.js.map