import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TARGET_SHELL_RADIUS } from '../model/types.js';
import { placeTargets } from './layout.js';
import { orgLikeConfig } from '../test/fixture-config.js';
orgLikeConfig();
const node = (id, plane, kind = 'component') => ({ id, label: id, kind, plane, status: 'active', visibility: 'n/a' });
const ship = (source, target) => ({ id: `${source}->${target}`, source, target, layer: 'delivery', label: '' });
test('delivery targets leave the delivery plane for a row of their own, ordered by what ships to them', () => {
    const nodes = [
        ...['a', 'b', 'c'].map((id) => node(id, 'delivery')),
        ...['p', 'q', 'r'].map((id) => node(id, 'product')),
        node('ship:left', 'delivery', 'outlet'),
        node('ship:right', 'delivery', 'outlet'),
    ];
    const positions = {
        a: [0, 0, 0], b: [100, 0, 0], c: [50, 80, 0],
        p: [-900, 300, 0], q: [-800, 350, 0], r: [-850, 420, 0],
        'ship:left': [50, 20, 0], 'ship:right': [60, 30, 0],
    };
    const placed = placeTargets(nodes, [ship('p', 'ship:left'), ship('b', 'ship:right')], positions);
    assert.equal(placed, 2);
    const [lx, ly] = positions['ship:left'];
    const [rx, ry] = positions['ship:right'];
    assert.equal(ly, ry);
    assert.ok(lx < rx, 'the target product ships to sits on the product side');
    assert.ok(rx - lx >= 2 * TARGET_SHELL_RADIUS, 'neighboring target shells do not touch');
    for (const id of ['a', 'b', 'c', 'p', 'q', 'r']) {
        assert.ok(ly - TARGET_SHELL_RADIUS > positions[id][1], `the row clears ${id}`);
    }
});
//# sourceMappingURL=layout.test.js.map