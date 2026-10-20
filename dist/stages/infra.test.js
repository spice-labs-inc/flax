import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outletsOf } from './infra.js';
import { orgLikeConfig } from '../test/fixture-config.js';
orgLikeConfig();
const ids = (type, deploy) => outletsOf(type, deploy.toLowerCase()).map((o) => `${o.id} ${o.label}`);
test('each published site goes to its own product surface', () => {
    assert.deepEqual(ids('docs', 'GitHub Pages at www.notes.example via deploy.yml'), ['ship:website www.notes.example']);
    assert.deepEqual(ids('docs', 'GitHub Pages at docs.notes.example via deploy.yml'), ['ship:docs docs.notes.example']);
    assert.deepEqual(ids('docs', 'GitHub Pages at blog.notes.example via deploy.yml'), ['ship:blog blog.notes.example']);
    assert.deepEqual(ids('cli', 'GitHub Release binaries (5 targets) + install.sh; docs to GitHub Pages'), ['ship:docs GitHub Pages', 'ship:releases GitHub Release + installer']);
    assert.deepEqual(ids('docs', 'GitHub Pages via pages.yml (historic)'), []);
});
test('an action ships as the tag its callers pin', () => {
    assert.deepEqual(ids('gh-action', 'none (consumed by ref; dominant pin @v5)'), ['ship:actions @v5']);
    assert.deepEqual(ids('gh-action', 'none (consumed via workflow_call)'), ['ship:actions by ref']);
});
test('Docker Hub and package registries are named, a cluster deploy is not a release', () => {
    assert.deepEqual(ids('service', 'Docker Hub image notes-co/notes-api on v*.*.* tag'), ['ship:releases Docker Hub']);
    assert.deepEqual(ids('cli', 'Maven Central + GitHub Packages (co.notes:notes-core_3) + Docker Hub image + fat jar on GitHub Releases'), ['ship:libraries Maven Central + GitHub Packages', 'ship:releases Docker Hub + GitHub Release']);
    assert.deepEqual(ids('tool', 'test/live via notes-gitops HelmRelease (Docker Hub image notes-co/notes-installer + OCI chart)'), []);
    assert.deepEqual(ids('cli', 'none (historical Docker Hub image notes-co/notes-old)'), []);
});
//# sourceMappingURL=infra.test.js.map