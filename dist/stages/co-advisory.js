// Stage 9.5 (code): who is exposed to the same advisory as who.
//
// Advisories are an attribute of a component, not a thing in the architecture,
// so they hang off nodes rather than being drawn. That answers "what does this
// carry" perfectly and "who else carries it" not at all — and the second
// question is the one that decides whether an upgrade is one team's problem or
// everyone's.
//
// This is measured, like the shared-dependency layer and unlike everything the
// model extracts: two components are joined here because the same published
// advisory id appears on both, which is a fact about what they contain.
export const coAdvisory = {
    id: 'coAdvisory',
    kind: 'code',
    title: 'Join components exposed to the same advisory',
    async run(ctx) {
        const r = ctx.out.resolve;
        const carriers = r.nodes.filter((n) => (n.advisoryIds?.length ?? 0) > 0);
        const edges = [];
        for (let i = 0; i < carriers.length; i++) {
            for (let j = i + 1; j < carriers.length; j++) {
                const a = carriers[i];
                const b = carriers[j];
                const other = new Set(b.advisoryIds);
                const common = a.advisoryIds.filter((id) => other.has(id));
                if (!common.length)
                    continue;
                edges.push({
                    id: `advisory:${a.id}->${b.id}:${common.length}shared`,
                    source: a.id,
                    target: b.id,
                    layer: 'advisory',
                    label: `${common.length} shared`,
                    detail: `${a.label} and ${b.label} are both exposed to ${common.length} of the same ` +
                        'published advisories. Fixing one may well fix the other.',
                    // Same reading as the shared-dependency layer: evidence of common
                    // exposure, not a statement that anyone designed the two to be
                    // related. The viewer draws derived edges differently for that reason.
                    derived: true,
                    // No list baked onto the edge. Both endpoints already carry their own
                    // advisoryIds, so the viewer can intersect them and show ALL of them —
                    // a complete answer AND less to download than a truncated one.
                    sharedTotal: common.length,
                });
            }
        }
        r.edges.push(...edges);
        ctx.log(`        ${edges.length} pairs across ${carriers.length} components carrying advisories`);
        return { edges: edges.length };
    },
};
//# sourceMappingURL=co-advisory.js.map