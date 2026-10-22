import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, setConfig } from "../config.js";
import { checkGitopsPaths, citedGitopsPaths, cmdCheck } from "./check.js";
const SECTIONS = [
    "tldr",
    "role",
    "architecture",
    "data",
    "interfaces",
    "configuration",
    "build-test-run",
    "cicd",
    "keyfiles",
    "invariants",
    "recent",
];
function page(name, deps, usedBy, extra = "") {
    const body = SECTIONS.map((s) => `## ${s}\n${s === "tldr" ? `What ${name} does.` : s === "keyfiles" ? "| to change | file |\n|---|---|\n| the build | `Makefile` |" : "none"}${s === "role" ? extra : ""}\n`).join("\n");
    return `---\nname: ${name}\nrepo: notes-co/${name}\nlanguage: Go\ntype: service\nstatus: active\nplane: app\ndeploy: none\ndepends_on: [${deps.join(", ")}]\nused_by: [${usedBy.join(", ")}]\nartifacts: []\ndefault_branch: main\nanalyzed_commit: 0a1b2c3 2026-10-01\nanalysis_source: fresh-clone\n---\n\n# ${name}: a ${name} service\n\n${body}`;
}
function atlas() {
    setConfig({
        org: { github: "notes-co" },
        planes: [
            {
                id: "app",
                label: "App",
                index: true,
                heading: "## App plane",
                map: true,
            },
            { id: "delivery", label: "D" },
            { id: "infra", label: "I" },
            { id: "external", label: "X" },
        ],
        map: { gitops: { repo: "notes-gitops", checkout: "../notes-gitops" } },
        checks: { gitopsPaths: { enabled: true, prefixes: ["apps/(test|live)"] } },
    });
    const root = mkdtempSync(join(tmpdir(), "atlas-check-"));
    mkdirSync(join(root, "repos"));
    writeFileSync(join(root, "repos", "notes-api.md"), page("notes-api", [], ["notes-web"]));
    writeFileSync(join(root, "repos", "notes-web.md"), page("notes-web", ["notes-api"], []));
    writeFileSync(join(root, "INDEX.md"), "# INDEX\n\n## App plane\n<!-- BEGIN GENERATED index-plane:app (flax atlas index; do not edit by hand) -->\n| doc | status | role |\n|---|---|---|\n| repos/notes-api.md | active | a notes-api service |\n| repos/notes-web.md | active | a notes-web service |\n<!-- END GENERATED index-plane:app -->\n");
    return root;
}
function run(root, tree = new Set()) {
    const lines = [];
    const code = cmdCheck(root, { log: (s) => lines.push(s), gitopsTree: tree });
    return { code, lines };
}
test("a consistent atlas passes every section", () => {
    const { code, lines } = run(atlas());
    assert.equal(code, 0, lines.join("\n"));
    assert.ok(lines.some((l) => l.startsWith("== 5. Cited notes-gitops paths")));
    assert.equal(lines.at(-1), "== done (fail=0) ==");
});
test("a missing heading, a bad enum, a local path, a dead INDEX link and an asymmetry each fail", () => {
    const root = atlas();
    const api = join(root, "repos", "notes-api.md");
    writeFileSync(api, readFileSync(api, "utf8")
        .replace("## invariants\nnone\n", "")
        .replace("status: active", "status: busy")
        .replace("What notes-api does.", "Checkout at /home/someone/dev/notes-api."));
    const web = join(root, "repos", "notes-web.md");
    writeFileSync(web, readFileSync(web, "utf8").replace("depends_on: [notes-api]", "depends_on: []"));
    writeFileSync(join(root, "INDEX.md"), `${readFileSync(join(root, "INDEX.md"), "utf8")}\nSee repos/notes-gone.md.\n`);
    const { code, lines } = run(root);
    assert.equal(code, 1);
    const codes = lines.map((l) => l.split(/[ :]/)[0]);
    for (const want of [
        "HEADINGS",
        "ENUM",
        "repos/notes-api.md",
        "DEAD-INDEX-LINK",
        "ASYMMETRY",
    ])
        assert.ok(codes.includes(want), `${want} in\n${lines.join("\n")}`);
});
test("cited gitops paths are read from live sentences only and checked against the tree", () => {
    const root = atlas();
    const c = config();
    const text = page("notes-gitops", [], [], "\n- Pins live in notes-gitops apps/live/notes-api/ and apps/test/notes-api/.\n- apps/live/old-thing/ was removed in 2025.\n- Unrelated: docs/apps/live/x.\n");
    writeFileSync(join(root, "repos", "notes-gitops.md"), text);
    assert.deepEqual(citedGitopsPaths("repos/notes-gitops.md", text, c), [
        "apps/live/notes-api",
        "apps/test/notes-api",
    ]);
    const other = page("notes-api", [], [], "\n- Its pin: notes-gitops apps/live/notes-api/version-patch.yml.\n- Not about the gitops repo: apps/live/elsewhere.\n");
    assert.deepEqual(citedGitopsPaths("repos/notes-api.md", other, c), [
        "apps/live/notes-api/version-patch.yml",
    ]);
    const warned = [];
    const n = checkGitopsPaths(root, c, (s) => warned.push(s), new Set([
        "apps/live/notes-api/version-patch.yml",
        "apps/live/notes-api/kustomization.yml",
    ]));
    assert.equal(n, 1);
    assert.deepEqual(warned, [
        "WARN-GITOPS-PATH apps/test/notes-api: repos/notes-gitops.md",
    ]);
    const none = [];
    assert.equal(checkGitopsPaths(root, c, (s) => none.push(s), undefined), 0);
    assert.match(none[0], /not reachable/);
});
//# sourceMappingURL=check.test.js.map