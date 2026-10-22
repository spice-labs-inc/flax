// Stage 8 (code): what is actually deployed, and where, read from the gitops
// repository rather than from prose.
//
// Two questions the map could not answer before:
//
//   "what runs in prod?"      — every cluster overlay in app-gitops lists
//                               exactly which applications it includes, and a
//                               Flux Kustomization in each cluster points at
//                               one of those overlays. That is the deployment,
//                               not a description of it.
//   "what runs on that box?"  — apps/<machinesDir>/<box>/ holds the compose stacks
//                               a timer reconciles onto each machine (optional).
//
// Both were previously inferred: environment membership was not modelled at
// all (only a generic Flux-to-environment arrow), and machine workloads came
// from the `runs` column of MACHINES.md, which is prose maintained by hand.
// Where the two disagree, the gitops repo wins and the difference is reported
// — a box whose prose and whose compose stacks disagree is worth someone
// looking at.
//
// Nothing here reaches the network. With no app-gitops checkout beside the
// atlas the stage emits nothing and says so, exactly like the manifest check.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
/** Entries under `resources:` that name a sibling directory, not a file. */
function resourceDirs(kustomization) {
    const out = [];
    let inResources = false;
    for (const line of kustomization.split('\n')) {
        if (/^resources:\s*$/.test(line)) {
            inResources = true;
            continue;
        }
        // Any other top-level key ends the block.
        if (inResources && /^[a-zA-Z]/.test(line))
            break;
        if (!inResources)
            continue;
        const m = line.match(/^\s+-\s+(.+?)\s*$/);
        if (!m)
            continue;
        const v = m[1].trim();
        // Skip files and parent-relative includes; we want local app directories.
        if (v.includes('/') || v.includes('.'))
            continue;
        out.push(v);
    }
    return out;
}
export const deployments = {
    id: 'deployments',
    kind: 'code',
    title: 'Deployments from the gitops repository',
    async run(ctx) {
        const idx = ctx.out.components;
        const g = config().map.gitops;
        const gitops = join(ctx.atlasRoot, g.checkout || `../${g.repo}`);
        const edges = [];
        const unmapped = new Set();
        const machineDrift = [];
        if (!g.repo || !existsSync(join(gitops, 'apps'))) {
            ctx.log(`        no ${g.repo || 'gitops'} checkout at ${gitops}; skipped`);
            return { edges: [], unmapped: [], machineDrift: [] };
        }
        // Stack names that are third-party software the org runs but does not build, so no
        // repo doc will ever name them. Curated in the config rather than left unmapped.
        const CURATED = g.curated;
        /**
         * A gitops directory name to a component id.
         *
         * Stack directories are named for what they run, but not always exactly:
         * `notes-worker-backups` and `notes-worker-replica` are both notes-worker. Trailing
         * qualifiers are stripped only after an exact match fails, so a real
         * component whose name happens to contain a hyphen is never truncated.
         */
        const resolve = (name) => {
            if (CURATED[name])
                return CURATED[name];
            if (idx.ownerOf[name])
                return name;
            const primary = idx.componentsOf[name]?.[0];
            if (primary)
                return primary;
            const parts = name.split('-');
            for (let i = parts.length - 1; i > 0; i--) {
                const stem = parts.slice(0, i).join('-');
                if (idx.ownerOf[stem])
                    return stem;
                const p = idx.componentsOf[stem]?.[0];
                if (p)
                    return p;
            }
            return undefined;
        };
        // -- cluster overlays ----------------------------------------------------
        for (const [overlay, env] of Object.entries(g.overlays)) {
            const dir = join(gitops, 'apps', overlay);
            const kust = ['kustomization.yml', 'kustomization.yaml']
                .map((f) => join(dir, f))
                .find((p) => existsSync(p));
            if (!kust)
                continue;
            for (const app of resourceDirs(readFileSync(kust, 'utf8'))) {
                const component = resolve(app);
                if (!component) {
                    unmapped.add(`${overlay}/${app}`);
                    continue;
                }
                edges.push({
                    id: `delivery:${component}->${env}`,
                    source: component,
                    target: env,
                    layer: 'delivery',
                    label: 'deployed here',
                    detail: `${component} is included in the ${overlay} overlay, which Flux reconciles into ${env.replace('env:', '')}.`,
                    anchor: `${g.repo} apps/${overlay}/kustomization.yml`,
                });
            }
        }
        // -- machines (compose stacks per box) ----------------------------------
        const machines = join(gitops, 'apps', g.machinesDir ?? '');
        if (g.machinesDir && existsSync(machines)) {
            for (const box of readdirSync(machines, { withFileTypes: true })) {
                if (!box.isDirectory() || g.machinesSkip.includes(box.name))
                    continue;
                const machineId = `machine:${box.name}`;
                for (const stack of readdirSync(join(machines, box.name), { withFileTypes: true })) {
                    if (!stack.isDirectory())
                        continue;
                    const component = resolve(stack.name);
                    if (!component) {
                        unmapped.add(`${g.machinesDir}/${box.name}/${stack.name}`);
                        continue;
                    }
                    edges.push({
                        id: `delivery:${component}->${machineId}`,
                        source: component,
                        target: machineId,
                        layer: 'delivery',
                        label: `${stack.name} stack`,
                        detail: `${component} runs on ${box.name} as the ${stack.name} compose stack, reconciled by the gitops-reconcile timer.`,
                        anchor: `${g.repo} apps/${g.machinesDir}/${box.name}/${stack.name}`,
                    });
                }
            }
        }
        // Compare the gitops answer against the MACHINES.md prose. app-gitops wins;
        // the difference is reported so a stale fleet table gets noticed rather than
        // quietly disagreeing with the map.
        const prose = ctx.out.infra?.machineRuns ?? {};
        const gitopsByMachine = {};
        for (const e of edges) {
            if (!e.target.startsWith('machine:'))
                continue;
            (gitopsByMachine[e.target] ??= new Set()).add(e.source);
        }
        for (const [machine, claimed] of Object.entries(prose)) {
            const actual = gitopsByMachine[machine] ?? new Set();
            const onlyProse = claimed.filter((c) => !actual.has(c));
            const onlyGitops = [...actual].filter((c) => !claimed.includes(c) && !c.startsWith('svc:'));
            if (onlyProse.length || onlyGitops.length) {
                machineDrift.push(`${machine.replace('machine:', '')}: ` +
                    (onlyProse.length ? `MACHINES.md claims ${onlyProse.join(', ')} with no gitops stack` : '') +
                    (onlyProse.length && onlyGitops.length ? '; ' : '') +
                    (onlyGitops.length ? `gitops runs ${onlyGitops.join(', ')} which the fleet table omits` : ''));
            }
        }
        const envEdges = edges.filter((e) => e.target.startsWith('env:')).length;
        ctx.log(`        ${envEdges} environment placements, ${edges.length - envEdges} box placements` +
            (unmapped.size ? `; ${unmapped.size} stack names matched no component` : ''));
        if (unmapped.size) {
            for (const u of [...unmapped].sort().slice(0, 8))
                ctx.log(`        ?   ${u}`);
        }
        for (const m of machineDrift)
            ctx.log(`        ! ${m}`);
        return { edges, unmapped: [...unmapped].sort(), machineDrift };
    },
};
//# sourceMappingURL=deployments.js.map