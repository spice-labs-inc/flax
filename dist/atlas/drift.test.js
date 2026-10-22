import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../config.js";
import { findDrift, isNoise } from "./drift.js";
const PIN = "^apps/[^/]+/[^/]+/[^/]+-patch\\.yml$";
const COMPOSE = "^apps/boxes/[^/]+/[^/]+/docker-compose\\.yml$";
test("drift is noise only in a listed repo and only for its listed paths", () => {
    setConfig({
        docs: {
            driftNoise: { "notes-gitops": { paths: [PIN], imagePinsIn: [COMPOSE] } },
        },
    });
    assert.equal(isNoise("notes-gitops", [
        { filename: "apps/live/notes-api/version-patch.yml", status: "modified" },
    ]), true);
    assert.equal(isNoise("notes-gitops", [
        { filename: "apps/live/notes-api/version-patch.yml", status: "modified" },
        { filename: "README.md", status: "modified" },
    ]), false);
    assert.equal(isNoise("notes-api", [
        { filename: "apps/live/notes-api/version-patch.yml", status: "modified" },
    ]), false);
    assert.equal(isNoise("notes-gitops", []), false);
    assert.equal(isNoise("notes-gitops", undefined), false);
});
test("a compose file is noise only when every changed line is an image pin", () => {
    setConfig({
        docs: {
            driftNoise: { "notes-gitops": { paths: [PIN], imagePinsIn: [COMPOSE] } },
        },
    });
    const file = "apps/boxes/box1/worker/docker-compose.yml";
    const pins = "@@ -1,3 +1,3 @@\n-    image: ghcr.io/notes-co/worker:sha-1\n+    image: ghcr.io/notes-co/worker:sha-2\n";
    const more = `${pins}-    restart: always\n+    restart: unless-stopped\n`;
    assert.equal(isNoise("notes-gitops", [
        { filename: file, status: "modified", patch: pins },
    ]), true);
    assert.equal(isNoise("notes-gitops", [
        { filename: file, status: "modified", patch: more },
    ]), false);
    assert.equal(isNoise("notes-gitops", [{ filename: file, status: "added", patch: pins }]), false);
    assert.equal(isNoise("notes-gitops", [{ filename: file, status: "modified" }]), false);
});
test("findDrift reports docs behind their head, classifies noise and skips local-stale docs", () => {
    setConfig({
        org: { github: "notes-co" },
        docs: { driftNoise: { "notes-gitops": { paths: [PIN] } } },
    });
    const root = mkdtempSync(join(tmpdir(), "atlas-drift-"));
    mkdirSync(join(root, "repos"));
    const doc = (name, sha, source = "fresh-clone") => writeFileSync(join(root, "repos", `${name}.md`), `---\nname: ${name}\nrepo: notes-co/${name}\nanalyzed_commit: ${sha} 2026-10-01\nanalysis_source: ${source}\n---\n\n# ${name}: x\n`);
    doc("notes-api", "aaaaaaa");
    doc("notes-gitops", "bbbbbbb");
    doc("notes-old", "ccccccc", "local-stale");
    doc("notes-gone", "ddddddd");
    doc("notes-web", "eeeeeee");
    const heads = {
        "notes-co/notes-api": "aaaaaaa".padEnd(40, "0"),
        "notes-co/notes-gitops": "1".repeat(40),
        "notes-co/notes-web": "2".repeat(40),
    };
    const compared = [];
    const r = findDrift(root, true, {
        headOf: (repo) => heads[repo],
        compare: (repo) => {
            compared.push(repo);
            return [
                {
                    filename: "apps/live/notes-api/version-patch.yml",
                    status: "modified",
                },
            ];
        },
    });
    assert.deepEqual(r.unresolved, ["notes-gone"]);
    assert.deepEqual(r.drifted.map((d) => [d.name, d.noise]), [
        ["notes-gitops", true],
        ["notes-web", false],
    ]);
    assert.deepEqual(compared, ["notes-co/notes-gitops"]);
});
//# sourceMappingURL=drift.test.js.map