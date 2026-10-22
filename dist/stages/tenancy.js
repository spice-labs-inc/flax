// Stage 12.5 (code): split the product plane by tenancy.
//
// Most of what we build runs once and serves every customer. The rest belongs to
// exactly ONE customer, and that difference is the most security-relevant fact
// in the architecture — the map could not show it, because both halves were
// simply "Product".
//
// Single-tenant covers two things, and both answer "whose is this?" with a name:
//
//   - what runs in the customer's own Kubernetes namespace,
//     `project-{serviceUuid}`, which an operator creates and fills with the
//     per-customer engine's HelmRelease;
//   - what runs on the CUSTOMER'S side entirely — the CLI they invoke, the
//     builders it drives, the libraries it uploads through. Those never touch a
//     shared instance of anything, and they are the part of the product our
//     infrastructure does not run at all.
//
// It is curated, and it has to be. There is no frontmatter field for "runs in
// project-{uuid}" and no manifest that says so: the fact lives in the operator's
// code and the engine's chart, so the only honest way to get it here is to
// write it down with a citation (map.tenancy in flax.yml).
import { config } from '../config.js';
export const tenancy = {
    id: 'tenancy',
    kind: 'code',
    title: 'Correct planes: tenancy split, the free trial, the collector',
    async run(ctx) {
        const r = ctx.out.resolve;
        const PLANE_FIX = config().map.planeFix;
        const t = config().map.tenancy;
        const SINGLE = new Set(t ? [...t.inNamespace, ...t.perProjectData, ...t.customerSide] : []);
        let moved = 0;
        let fixed = 0;
        for (const n of r.nodes) {
            const to = PLANE_FIX[n.id];
            if (to && n.plane !== to) {
                n.plane = to;
                fixed++;
            }
        }
        const missing = new Set(SINGLE);
        for (const n of r.nodes) {
            missing.delete(n.id);
            if (!SINGLE.has(n.id))
                continue;
            n.plane = t.plane;
            moved++;
        }
        ctx.log(`        ${moved} single-tenant, ${t ? r.nodes.filter((n) => n.plane === t.from).length : 0} multi-tenant, ${fixed} plane corrections`);
        // A name in the list that matches nothing is a silent hole in a security
        // claim: the map would say a component is shared when nobody ever asked.
        if (t && missing.size)
            ctx.log(`        WARNING: named but not in the graph: ${[...missing].join(', ')}`);
        return moved;
    },
};
//# sourceMappingURL=tenancy.js.map