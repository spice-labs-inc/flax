// The atlas tools. Run as `flax atlas <cmd>` from the workspace (the directory holding flax.yml), or with --workspace <dir>:
//
//   flax atlas budgets                      every size and content budget (exit 1 on a FAIL)
//   flax atlas symmetry                     depends_on / used_by asymmetries (exit 1 when any)
//   flax atlas used-by     [--check|--write] [--doc a,b]   used_by = inverse of every depends_on
//   flax atlas outlines    [--check|--write] [--doc a,b]   outlines of sections that live in section files
//   flax atlas index       [--check|--write] [--seed-planes [--doc a,b]]   INDEX plane tables
//   flax atlas recent      [--check|--write] [--doc a,b]   ## recent against merged PRs (gh api)
//   flax atlas inventories [--check|--write] [--src <repo>=<dir>]   generated blocks rendered from another repo at head
//   flax atlas generated                    --check of used-by, outlines and index together (offline)
//   flax atlas check       [--stale]        every self-consistency check (template, shareability, INDEX coverage, symmetry, budgets, generated, cited gitops paths when enabled)
//   flax atlas drift                        docs whose analyzed_commit is behind the repo head (gh api); noise drift named as such
//
// Every command reads the atlas section of flax.yml through @flax/core.
//
// --check (the default) changes nothing and exits 1 when a file would change.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBudgets, printFindings } from "./budgets.js";
import { fsSource, readDoc, readDocs } from "./doc.js";
import { applyUsedBy, asymmetries, usedByChanges } from "./graph.js";
import { generateIndex, planeOf, planesFromIndex, withPlane, } from "./index-tables.js";
import { inventories, sparseClone } from "./inventories.js";
import { blockContent, diffSummary, findBlocks, replaceBlock, } from "./markdown.js";
import { applyOutlines, outlineChanges } from "./outline.js";
import { applyRecent, changed, listMerged, reviseRecent, } from "./recent.js";
import { readFileSync } from "node:fs";
import { config, loadAtlas } from "../config.js";
import { cmdCheck } from "./check.js";
import { cmdDrift } from "./drift.js";
function parseArgs(argv) {
    const a = {
        cmd: argv[0] ?? "help",
        write: false,
        seedPlanes: false,
        stale: false,
        verbose: false,
        src: {},
        workspace: process.cwd(),
        root: "",
    };
    for (let i = 1; i < argv.length; i++) {
        const x = argv[i];
        if (x === "--write")
            a.write = true;
        else if (x === "--check")
            a.write = false;
        else if (x === "--seed-planes")
            a.seedPlanes = true;
        else if (x === "--stale")
            a.stale = true;
        else if (x === "--verbose" || x === "-v")
            a.verbose = true;
        else if (x === "--doc")
            a.docs = (argv[++i] ?? "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        else if (x === "--workspace")
            a.workspace = resolve(argv[++i] ?? ".");
        else if (x === "--src") {
            const [k, v] = (argv[++i] ?? "").split("=");
            if (!k || !v)
                throw new Error("--src takes <repo>=<dir>");
            a.src[k] = resolve(v);
        }
        else
            throw new Error(`unknown option ${x}`);
    }
    return a;
}
const log = (s) => console.log(s);
function save(root, rel, text) {
    writeFileSync(join(root, rel), text);
}
function selected(all, docs) {
    if (!docs)
        return all;
    const unknown = docs.filter((d) => !all.some((x) => x.name === d));
    if (unknown.length)
        throw new Error(`no such doc: ${unknown.join(", ")}`);
    return all.filter((d) => docs.includes(d.name));
}
function cmdBudgets(a) {
    const findings = checkBudgets(a.root);
    const { fail, warn, byCode } = printFindings(findings, log);
    log("-- budget summary (count per rule) --");
    for (const [k, n] of Object.entries(byCode).sort())
        log(`${k}: ${n}`);
    log(`budgets: ${fail} FAIL, ${warn} WARN`);
    return fail ? 1 : 0;
}
function cmdSymmetry(a) {
    const lines = asymmetries(readDocs(fsSource(a.root)));
    for (const l of lines)
        log(l);
    log(`symmetry: ${lines.length} asymmetr${lines.length === 1 ? "y" : "ies"} (flax atlas used-by --write makes used_by the inverse of depends_on)`);
    return lines.length ? 1 : 0;
}
function cmdUsedBy(a) {
    const all = readDocs(fsSource(a.root));
    const changes = usedByChanges(all).filter((c) => !a.docs || a.docs.includes(c.doc.name));
    let added = 0;
    let dropped = 0;
    let notes = 0;
    for (const c of changes) {
        added += c.added.length;
        dropped += c.dropped.length;
        notes += c.notesDropped;
        const parts = [
            c.added.length ? `+${c.added.join(" +")}` : "",
            c.dropped.length ? `-${c.dropped.join(" -")}` : "",
            c.notesDropped ? `${c.notesDropped} notes dropped` : "",
        ].filter(Boolean);
        log(`${a.write ? "WROTE" : "WOULD-CHANGE"} ${c.doc.file} used_by: ${parts.join(", ") || "reformatted"}`);
        if (a.write)
            save(a.root, c.doc.file, applyUsedBy(c.doc, c.line));
    }
    log(`used-by: ${changes.length} docs ${a.write ? "written" : "differ"} (${added} names added, ${dropped} names dropped, ${notes} notes dropped)`);
    if (dropped && !a.write)
        log("  a dropped name is a consumer whose own depends_on does not list this doc: add it to that depends_on first if the edge is real");
    return !a.write && changes.length ? 1 : 0;
}
function cmdOutlines(a) {
    const docs = selected(readDocs(fsSource(a.root)), a.docs).filter((d) => Object.keys(d.sectionFiles).length);
    let n = 0;
    for (const d of docs) {
        const ch = outlineChanges(d);
        if (!ch.length)
            continue;
        n += ch.length;
        for (const c of ch) {
            log(`${a.write ? "WROTE" : "WOULD-CHANGE"} ${d.file} ## ${c.id} outline (from ${d.sectionFiles[c.id].file})`);
            if (a.verbose)
                for (const l of diffSummary(c.before, c.after))
                    log(l);
        }
        if (a.write)
            save(a.root, d.file, applyOutlines(d));
    }
    log(`outlines: ${n} sections in ${docs.length} docs with section files ${a.write ? "written" : "differ"}`);
    return !a.write && n ? 1 : 0;
}
function cmdIndex(a) {
    const src = fsSource(a.root);
    const all = readDocs(src);
    const index = readFileSync(join(a.root, "INDEX.md"), "utf8");
    const fallback = planesFromIndex(index);
    if (a.seedPlanes) {
        const targets = selected(all, a.docs).filter((d) => planeOf(d) === undefined);
        const unknown = [];
        for (const d of targets) {
            const p = fallback.get(d.name);
            if (!p) {
                unknown.push(d.name);
                continue;
            }
            log(`${a.write ? "WROTE" : "WOULD-ADD"} ${d.file} plane: ${p}`);
            if (a.write)
                save(a.root, d.file, withPlane(d, p));
        }
        for (const u of unknown)
            log(`NO-PLANE ${u}: not linked under any INDEX plane heading; add plane: by hand`);
        log(`seed-planes: ${targets.length - unknown.length} docs ${a.write ? "given" : "lack"} a plane: field${unknown.length ? `, ${unknown.length} with no INDEX plane to seed from` : ""}`);
        return !a.write && targets.length ? 1 : unknown.length ? 1 : 0;
    }
    const res = generateIndex(index, all, fallback);
    for (const p of Object.keys(res.rows))
        log(`plane ${p}: ${res.rows[p]} rows${res.bootstrapped.includes(p) ? " (no marker block yet: it replaces the table or link list under the heading)" : ""}`);
    if (res.missingPlane.length)
        log(`MISSING-PLANE ${res.missingPlane.length} docs have no plane: field (seed with flax atlas index --seed-planes --write); placed by where INDEX links them today`);
    if (res.unplaced.length)
        log(`UNPLACED ${res.unplaced.join(", ")}: no plane field and no INDEX plane link`);
    if (res.unknownPlane.length)
        log(`UNKNOWN-PLANE ${res.unknownPlane.join(", ")}`);
    const differ = res.text !== index;
    log(`index: INDEX.md ${(Buffer.byteLength(index) / 1024).toFixed(1)} KB now, ${(Buffer.byteLength(res.text) / 1024).toFixed(1)} KB generated; ${differ ? (a.write ? "written" : "differs") : "up to date"}`);
    if (a.verbose && differ)
        for (const l of diffSummary(index, res.text, 20))
            log(l);
    if (a.write && differ) {
        if (res.unplaced.length || res.unknownPlane.length)
            throw new Error("refusing to write INDEX.md while a doc has no plane or an unknown one");
        save(a.root, "INDEX.md", res.text);
    }
    return !a.write && (differ || res.missingPlane.length)
        ? 1
        : res.unplaced.length || res.unknownPlane.length
            ? 1
            : 0;
}
function cmdRecent(a) {
    const all = readDocs(fsSource(a.root));
    const docs = selected(all, a.docs).filter((d) => String(d.fm.analysis_source ?? "") !== "local-stale");
    const reps = [];
    const cache = new Map();
    for (const d of docs) {
        const repo = String(d.fm.repo ?? `${config().org.github}/${d.name}`);
        const base = String(d.fm.default_branch ?? "main") || "main";
        const key = `${repo}@${base}`;
        let prs = cache.get(key);
        if (!prs) {
            try {
                prs = listMerged(repo, base);
            }
            catch (e) {
                const msg = e.stderr
                    ?.toString()
                    .trim()
                    .split("\n")
                    .pop() ?? String(e);
                reps.push({
                    doc: d.name,
                    error: msg,
                    wrongDate: [],
                    wrongSha: [],
                    missingSha: [],
                    unknownPr: [],
                    reformat: 0,
                    noPr: 0,
                    dropped: 0,
                    added: [],
                    before: "",
                    after: "",
                });
                log(`ERROR ${d.file}: ${repo}: ${msg}`);
                continue;
            }
            cache.set(key, prs);
        }
        const r = reviseRecent(d, prs);
        reps.push(r);
        const bits = [
            r.wrongDate.length
                ? `${r.wrongDate.length} wrong date (${r.wrongDate.join("; ")})`
                : "",
            r.wrongSha.length
                ? `${r.wrongSha.length} wrong merge sha (${r.wrongSha.join("; ")})`
                : "",
            r.missingSha.length ? `${r.missingSha.length} without merge sha` : "",
            r.unknownPr.length
                ? `${r.unknownPr.length} PR not merged into ${base} (${r.unknownPr.join(" ")})`
                : "",
            r.reformat ? `${r.reformat} reformatted` : "",
            r.noPr ? `${r.noPr} without a PR of this repo` : "",
            r.dropped ? `${r.dropped} dropped (over ${5} or pointer)` : "",
            r.added.length ? `${r.added.length} new PRs` : "",
        ].filter(Boolean);
        if (changed(r)) {
            log(`${a.write ? "WROTE" : "WOULD-CHANGE"} ${d.file}: ${bits.join(", ")}`);
            if (a.verbose)
                for (const l of r.after.trim().split("\n"))
                    log(`    | ${l.length > 200 ? `${l.slice(0, 197)}...` : l}`);
            if (a.write)
                save(a.root, d.file, applyRecent(readDoc(fsSource(a.root), d.name), r.after));
        }
        else if (r.unknownPr.length)
            log(`CHECK ${d.file}: ${bits.join(", ")}`);
    }
    const sum = (f) => reps.reduce((n, r) => n + f(r), 0);
    log(`recent: ${reps.length} docs, ${reps.filter((r) => !r.error && changed(r)).length} ${a.write ? "written" : "would change"}; ` +
        `${sum((r) => r.wrongDate.length)} wrong dates, ${sum((r) => r.wrongSha.length)} wrong merge shas, ${sum((r) => r.missingSha.length)} lines without merge sha, ` +
        `${sum((r) => r.unknownPr.length)} PR numbers not merged into the default branch, ${sum((r) => r.reformat)} lines reformatted, ` +
        `${sum((r) => r.noPr)} lines without a PR of the repo, ${sum((r) => r.dropped)} lines dropped, ${sum((r) => r.added.length)} new PR lines; ` +
        `${reps.filter((r) => r.error).length} repos unreadable; ${cache.size} list calls`);
    return !a.write && reps.some((r) => !r.error && changed(r)) ? 1 : 0;
}
async function cmdInventories(a) {
    const src = fsSource(a.root);
    let differ = 0;
    for (const inv of await inventories(a.workspace)) {
        const dir = a.src[inv.repo] ?? sparseClone(inv.repo, inv.paths);
        const content = await inv.render(dir);
        const doc = readDoc(src, inv.doc);
        if (!doc)
            throw new Error(`no repos/${inv.doc}.md`);
        const files = [
            { rel: doc.file, text: doc.text },
            ...Object.values(doc.sectionFiles).map((f) => ({
                rel: f.file,
                text: f.text,
            })),
        ];
        const hit = files.flatMap((f) => findBlocks(f.text)
            .filter((b) => b.id === inv.id)
            .map((b) => ({ f, b })));
        if (hit.length !== 1) {
            differ++;
            log(`NO-BLOCK ${inv.id}: ${hit.length ? "more than one" : "no"} <!-- BEGIN GENERATED ${inv.id} --> block in repos/${inv.doc}.md or its section files; generated content (${content.split("\n").length} lines) from ${a.src[inv.repo] ? dir : `${inv.repo} head`}:`);
            for (const l of content.split("\n"))
                log(`    ${l}`);
            continue;
        }
        const { f, b } = hit[0];
        const now = blockContent(f.text, b);
        if (now.replace(/\n+$/, "") === content) {
            log(`${inv.id}: up to date in ${f.rel}`);
            continue;
        }
        differ++;
        log(`${a.write ? "WROTE" : "WOULD-CHANGE"} ${f.rel} block ${inv.id}`);
        for (const l of diffSummary(now, content))
            log(l);
        if (a.write)
            save(a.root, f.rel, replaceBlock(f.text, b, content));
    }
    return !a.write && differ ? 1 : 0;
}
export async function main(argv) {
    const a = parseArgs(argv);
    if (a.cmd === "help" && argv[1])
        a.cmd = argv[1];
    else if (a.cmd === "help")
        return usage(0);
    a.root = loadAtlas(a.workspace).atlasRoot;
    switch (a.cmd) {
        case "check":
            return cmdCheck(a.root, { stale: a.stale, log });
        case "drift":
            return cmdDrift(a.root, { log, noise: !a.verbose });
        case "budgets":
            return cmdBudgets(a);
        case "symmetry":
            return cmdSymmetry(a);
        case "used-by":
            return cmdUsedBy(a);
        case "outlines":
            return cmdOutlines(a);
        case "index":
            return cmdIndex(a);
        case "recent":
            return cmdRecent(a);
        case "inventories":
            return await cmdInventories(a);
        case "generated": {
            if (a.write)
                throw new Error("generated is check-only; run each generator with --write");
            const r = [cmdUsedBy(a), cmdOutlines(a), cmdIndex(a)];
            return r.some(Boolean) ? 1 : 0;
        }
        default:
            log(`unknown command ${a.cmd}`);
            return usage(2);
    }
}
function usage(code) {
    log(readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("\n")
        .filter((l) => l.startsWith("//"))
        .map((l) => l.replace(/^\/\/ ?/, ""))
        .join("\n"));
    return code;
}
//# sourceMappingURL=cli.js.map