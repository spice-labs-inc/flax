import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepFlowsResolving, withPrevious } from './flow-guard.js';
const FIXED = new Set(['worker', 'api', 'core']);
const infra = (origin, kind, ...ids) => ids.map((id) => ({ id, kind, label: id, origin }));
const edge = (origin, from, to) => ({ from, to, layer: 'network', label: 'calls', origin });
/** Resolves a name when it is a fixed component or some answer declared it. */
function probeFor(steps) {
    let calls = 0;
    const probe = async (w) => {
        calls++;
        const known = new Set([...FIXED, ...w.infra.map((i) => i.id)]);
        const nodeOf = (n) => (known.has(n) ? n : undefined);
        const broken = [];
        steps.forEach(([flow, from, to], i) => {
            const missing = [from, to].filter((n) => !nodeOf(n));
            if (missing.length)
                broken.push({ flow, step: i + 1, from, to, missing });
        });
        return { broken, nodeOf };
    };
    return { probe, calls: () => calls };
}
function wiring(docs) {
    const w = { edges: [], infra: [], keys: {}, sections: {}, replaced: {} };
    for (const [doc, { now, before }] of Object.entries(docs)) {
        w.edges.push(...now.edges);
        w.infra.push(...now.infra);
        w.keys[doc] = `wiring/${doc}.new`;
        w.sections[doc] = `${doc}-new-sections`;
        if (before)
            w.replaced[doc] = { answer: before, key: `wiring/${doc}.old`, sections: `${doc}-old-sections` };
    }
    return w;
}
const worker = {
    before: { edges: [edge('worker', 'worker', 'SMTP relay host')], infra: infra('worker', 'external', 'SMTP relay host') },
    now: { edges: [edge('worker', 'worker', 'SMTP relay')], infra: infra('worker', 'external', 'SMTP relay') },
};
const core = {
    before: { edges: [], infra: infra('core', 'store', 'notes-index') },
    now: { edges: [], infra: infra('core', 'store', 'notes-indexes') },
};
test('nothing re-extracted: no probe, wiring unchanged', async () => {
    const w = wiring({ worker: { now: worker.now } });
    const { probe, calls } = probeFor([['publish', 'worker', 'SMTP relay host']]);
    const out = await keepFlowsResolving(w, probe, () => { });
    assert.equal(out.wire, w);
    assert.equal(calls(), 0);
});
test('new answers that keep every flow resolving are kept', async () => {
    const w = wiring({ worker, core });
    const { probe } = probeFor([['publish', 'worker', 'SMTP relay']]);
    const out = await keepFlowsResolving(w, probe, () => { });
    assert.equal(out.wire, w);
    assert.deepEqual(out.held, []);
});
test('a doc whose new answer breaks a step keeps its previous answer; the others keep theirs', async () => {
    const w = wiring({ worker, core });
    const { probe } = probeFor([
        ['publish-a-note', 'core', 'worker'],
        ['publish-a-note', 'worker', 'SMTP relay host'],
    ]);
    const logs = [];
    const out = await keepFlowsResolving(w, probe, (m) => logs.push(m));
    assert.deepEqual(out.held.map((h) => h.doc), ['worker']);
    assert.deepEqual(out.held[0].steps.map((s) => s.step), [2]);
    assert.deepEqual(out.wire.infra.map((i) => i.id).sort(), ['SMTP relay host', 'notes-indexes']);
    assert.equal(out.wire.keys.worker, 'wiring/worker.old');
    assert.equal(out.wire.keys.core, 'wiring/core.new');
    // The previous sections keep the doc queued, as a failed re-extraction does.
    assert.equal(out.wire.sections.worker, 'worker-old-sections');
    assert.equal(out.wire.sections.core, 'core-new-sections');
    assert.equal((await probe(out.wire)).broken.length, 0);
    const line = logs.find((l) => l.includes('worker: its new wiring breaks flow'));
    assert.ok(line, logs.join('\n'));
    assert.match(line, /flow "publish-a-note" step 2 \(worker -> SMTP relay host\)/);
    assert.match(line, /previous answer called it "SMTP relay host", the new one "SMTP relay"/);
    assert.ok(logs.some((l) => /1 kept their previous wiring because the new answer breaks a curated flow: worker\./.test(l)));
});
test('the new name comes from a declaration of the same kind when no edge points at it', async () => {
    const w = wiring({ core });
    const { probe } = probeFor([['sync-a-folder', 'notes-index', 'api']]);
    const logs = [];
    await keepFlowsResolving(w, probe, (m) => logs.push(m));
    assert.ok(logs.some((l) => l.includes('the previous answer called it "notes-index", the new one "notes-indexes"')), logs.join('\n'));
});
test('a step that does not resolve with the previous answers either is drift: nothing kept', async () => {
    const w = wiring({ worker, core });
    const { probe } = probeFor([['sync-a-folder', 'notes-index-v2', 'api']]);
    const logs = [];
    const out = await keepFlowsResolving(w, probe, (m) => logs.push(m));
    assert.equal(out.wire, w);
    assert.deepEqual(out.held, []);
    assert.deepEqual(logs, []);
    assert.equal((await probe(out.wire)).broken.length, 1);
});
test('drift elsewhere does not stop a culprit from keeping its previous answer', async () => {
    const w = wiring({ worker, core });
    const { probe } = probeFor([
        ['sync-a-folder', 'notes-index-v2', 'api'],
        ['publish-a-note', 'worker', 'SMTP relay host'],
    ]);
    const out = await keepFlowsResolving(w, probe, () => { });
    assert.deepEqual(out.held.map((h) => h.doc), ['worker']);
    assert.deepEqual((await probe(out.wire)).broken.map((s) => s.flow), ['sync-a-folder']);
});
test('a step only several previous answers restore together keeps them all', async () => {
    // The step needs both names; each doc's previous answer declared one of them.
    const a = { before: { edges: [], infra: infra('a', 'store', 'x') }, now: { edges: [], infra: infra('a', 'store', 'x2') } };
    const b = { before: { edges: [], infra: infra('b', 'store', 'y') }, now: { edges: [], infra: infra('b', 'store', 'y2') } };
    const w = wiring({ a, b });
    const { probe } = probeFor([['f', 'x', 'y']]);
    const logs = [];
    const out = await keepFlowsResolving(w, probe, (m) => logs.push(m));
    assert.deepEqual(out.held.map((h) => h.doc).sort(), ['a', 'b']);
    assert.equal((await probe(out.wire)).broken.length, 0);
    assert.ok(logs.some((l) => l.includes('resolves only with the previous answers of a, b together')), logs.join('\n'));
});
test('withPrevious swaps only the named docs', () => {
    const w = wiring({ worker, core });
    const out = withPrevious(w, ['core']);
    assert.deepEqual(out.infra.map((i) => i.id).sort(), ['SMTP relay', 'notes-index']);
    assert.deepEqual(Object.keys(out.replaced), ['worker']);
    assert.equal(withPrevious(w, ['nobody']), w);
});
//# sourceMappingURL=flow-guard.test.js.map