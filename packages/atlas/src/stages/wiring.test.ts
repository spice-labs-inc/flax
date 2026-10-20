import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Ctx } from '../pipeline/machine.ts';

// The model is read when llm.ts loads. No test here reaches a model call.
const { orgLikeConfig } = await import('../test/fixture-config.ts');
orgLikeConfig();
process.env.ATLAS_WIRING_MODEL = 'test-model';
delete process.env.ATLAS_WIRING_FALLBACK_MODEL;
delete process.env.ATLAS_MODEL_SOCKET;
const { sha } = await import('../pipeline/machine.ts');
const { wiring } = await import('./wiring.ts');

const TEMPLATE = 'extract {{REPO}} {{OWN_COMPONENTS}} {{SECTIONS}} {{COMPONENT_IDS}}';
const ROLE = 'alpha calls beta over HTTP.';
const SECTIONS = `## role\n\n${ROLE}`;
const OLD = { edges: [{ from: 'alpha', to: 'beta-old', layer: 'network', label: 'calls' }], infra: [] };
const NEW = { edges: [{ from: 'alpha', to: 'beta-new', layer: 'network', label: 'calls' }], infra: [], model: 'test-model' };

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A viz root where alpha's sections changed since its pinned answer. */
function vizRoot(cached: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'wiring-test-'));
  dirs.push(root);
  mkdirSync(join(root, 'prompts'));
  mkdirSync(join(root, 'data'));
  mkdirSync(join(root, 'cache', 'wiring', 'wiring'), { recursive: true });
  writeFileSync(join(root, 'prompts', 'extract-wiring.md'), TEMPLATE);
  writeFileSync(join(root, 'data', 'wiring-keys.json'), JSON.stringify({ alpha: 'wiring/alpha.old' }));
  writeFileSync(join(root, 'data', 'wiring-sections.json'), JSON.stringify({ alpha: 'made-from-older-text' }));
  for (const [key, value] of Object.entries({ 'wiring/alpha.old': OLD, ...cached })) {
    writeFileSync(join(root, 'cache', 'wiring', `${key}.json`), JSON.stringify(value));
  }
  return root;
}

async function run(root: string, maxExtractions: number) {
  const logs: string[] = [];
  const ctx: Ctx = {
    atlasRoot: root,
    vizRoot: root,
    out: {
      atlas: { repos: [{ name: 'alpha', file: 'alpha.md', fm: {}, sections: { role: ROLE } }], architecture: '', machines: '', index: '' },
      components: { nodes: [], ownerOf: { alpha: 'alpha' }, componentsOf: { alpha: ['alpha'] } },
    },
    reuseStale: true,
    reextractChanged: true,
    maxExtractions,
    log: (m) => logs.push(m),
  };
  const out = await wiring.run(ctx);
  return { out, logs };
}

test('a doc deferred because the model calls are used up says deferred, not failed, and keeps its previous answer', async () => {
  const { out, logs } = await run(vizRoot({}), 0);
  const line = logs.find((l) => l.includes('alpha: re-extraction'));
  assert.equal(line?.trim(), "! alpha: re-extraction deferred to a later run (this run's model calls are used up), keeping the previous answer");
  assert.ok(!logs.some((l) => l.includes('failed')), logs.join('\n'));
  assert.deepEqual(out.edges.map((e: { to: string }) => e.to), ['beta-old']);
  assert.equal(out.keys.alpha, 'wiring/alpha.old');
  assert.equal(out.sections.alpha, 'made-from-older-text');
  assert.deepEqual(out.replaced, {});
});

test('a re-extracted doc records the previous answer it replaced; a cached new answer needs no model call', async () => {
  const newKey = `wiring/alpha.${sha(`test-model\n${sha(TEMPLATE)}\n${SECTIONS}`)}`;
  const { out, logs } = await run(vizRoot({ [newKey]: NEW }), 0);
  assert.ok(logs.some((l) => l.includes('1 re-extracted because their sections changed: alpha')), logs.join('\n'));
  assert.deepEqual(out.edges.map((e: { to: string }) => e.to), ['beta-new']);
  assert.equal(out.keys.alpha, newKey);
  assert.equal(out.sections.alpha, sha(SECTIONS));
  assert.deepEqual(Object.keys(out.replaced), ['alpha']);
  assert.equal(out.replaced.alpha.key, 'wiring/alpha.old');
  assert.equal(out.replaced.alpha.sections, 'made-from-older-text');
  assert.deepEqual(out.replaced.alpha.answer.edges.map((e: { to: string; origin?: string }) => [e.to, e.origin]), [['beta-old', 'alpha']]);
});
