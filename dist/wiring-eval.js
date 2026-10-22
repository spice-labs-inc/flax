// Wiring parity: re-extract a sample of docs with another model and compare its
// edges with the cached answer the map uses today. It reads the cache and never
// writes it, so an evaluation run changes nothing in viz/.
//
//   flax atlas wiring-eval [options]
//
//   --sample N        how many docs (default 20), spread from the richest to the
//                     sparest of the docs with a cached answer
//   --docs a,b,c      exactly these docs instead of a sample
//   --socket <path>   a model socket (POST /v1/messages; the runner picks the
//                     model). Default: the variable llm.socketEnv names
//   --base-url <url>  an OpenAI-compatible endpoint instead (POST <url>/chat/completions),
//                     with the key in WIRING_EVAL_API_KEY
//   --model <id>      the model to ask through --base-url; with a socket only a label
//                     (default: the variable llm.socketModelEnv names)
//   --concurrency N   model calls at once (default llm.concurrency)
//   --json <file>     also write the full comparison as JSON (never inside viz/cache)
//   --workspace <dir> the directory holding flax.yml (default: the current directory)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { config, loadAtlas } from "./config.js";
import { Cache, pmap } from "./pipeline/machine.js";
import { parseAnswer } from "./pipeline/llm.js";
import { MAX_TOKENS, MODEL_CALLS_AT_ONCE, patient, viaSocket, } from "./pipeline/model-socket.js";
import { readAtlas } from "./stages/read-atlas.js";
import { fullSections, gitSource, readDoc } from "./atlas/doc.js";
import { components } from "./stages/components.js";
import { SECTIONS, skip, validate, } from "./stages/wiring.js";
const ATTEMPTS = 3;
function norm(s) {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
function tokens(s) {
    return new Set(norm(s).split("-").filter(Boolean));
}
/** Two endpoint names for the same thing: equal once normalised, or sharing most of their words. */
function sameEnd(a, b) {
    if (norm(a) === norm(b))
        return { same: true, fuzzy: false };
    const ta = tokens(a);
    const tb = tokens(b);
    const shared = [...ta].filter((t) => tb.has(t)).length;
    const union = new Set([...ta, ...tb]).size;
    return { same: union > 0 && shared / union >= 0.5, fuzzy: true };
}
function dedupe(edges) {
    const seen = new Set();
    return edges.filter((e) => {
        const k = `${e.layer}|${norm(e.from)}|${norm(e.to)}`;
        if (seen.has(k))
            return false;
        seen.add(k);
        return true;
    });
}
/** Pairs each candidate edge with a cached one of the same layer and direction: exact names first, then near names. */
export function compareEdges(cached, candidate) {
    const left = dedupe(cached);
    const right = dedupe(candidate);
    const matched = [];
    for (const pass of ["exact", "fuzzy"]) {
        for (let i = 0; i < right.length; i++) {
            const c = right[i];
            const j = left.findIndex((o) => {
                if (o.layer !== c.layer)
                    return false;
                const from = sameEnd(o.from, c.from);
                const to = sameEnd(o.to, c.to);
                if (!from.same || !to.same)
                    return false;
                return pass === "fuzzy" || (!from.fuzzy && !to.fuzzy);
            });
            if (j === -1)
                continue;
            matched.push({ cached: left[j], candidate: c, fuzzy: pass === "fuzzy" });
            left.splice(j, 1);
            right.splice(i, 1);
            i--;
        }
    }
    return { matched, extra: right, missing: left };
}
/** Evenly spaced picks over the docs sorted by how many edges their cached answer has. */
export function spread(items, n, weight) {
    const sorted = [...items].sort((a, b) => weight(b) - weight(a));
    if (n >= sorted.length)
        return sorted;
    const step = sorted.length / n;
    return Array.from({ length: n }, (_, i) => sorted[Math.floor(i * step)]);
}
function viaOpenAi(baseUrl, model, key) {
    return async (prompt) => {
        const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
                model,
                max_tokens: MAX_TOKENS,
                messages: [{ role: "user", content: prompt }],
            }),
            signal: AbortSignal.timeout(600_000),
        });
        const text = await res.text();
        if (!res.ok)
            throw new Error(`model call HTTP ${res.status}: ${text.slice(0, 300)}`);
        const reply = JSON.parse(text);
        const choice = reply.choices?.[0];
        return {
            text: String(choice?.message?.content ?? ""),
            stopReason: choice?.finish_reason === "length"
                ? "max_tokens"
                : choice?.finish_reason,
        };
    };
}
function wiringSections(sections) {
    return SECTIONS()
        .filter((s) => sections[s])
        .map((s) => `## ${s}\n\n${sections[s]}`)
        .join("\n\n");
}
/** The same prompt the wiring stage sends for this doc. */
function promptFor(template, doc, idx, componentIds) {
    const sections = wiringSections(doc.sections);
    const ownIds = idx.componentsOf[doc.name] ?? [];
    return template
        .replace("{{REPO}}", doc.name)
        .replace("{{OWN_COMPONENTS}}", ownIds.join(", ") || doc.name)
        .replace("{{SECTIONS}}", sections)
        .replace("{{COMPONENT_IDS}}", componentIds);
}
/** Compares the doc's wiring sections now with the doc at the commit that added the cached answer. */
function sectionsChangedSince(atlasRoot, vizRoot, doc, key) {
    const git = (...args) => execFileSync("git", ["-C", atlasRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    try {
        if (git("rev-parse", "--is-shallow-repository") === "true")
            return undefined;
        const entry = relative(atlasRoot, join(vizRoot, "cache", "wiring", `${key}.json`));
        const added = git("log", "-1", "--format=%H", "--diff-filter=A", "--", entry);
        if (!added)
            return undefined;
        // The doc as it stood then, with the section files it had then.
        const then = readDoc(gitSource(atlasRoot, added), doc.file.replace(/^repos\/|\.md$/g, ""));
        if (!then)
            return undefined;
        return wiringSections(fullSections(then)) !== wiringSections(doc.sections);
    }
    catch {
        return undefined;
    }
}
async function extract(ask, prompt, ownIds) {
    let lastErr = "";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const p = attempt === 1
            ? prompt
            : `${prompt}\n\nYour previous answer could not be used: ${lastErr}\nReturn only the JSON document, with no prose and no code fence.`;
        try {
            return {
                value: validate(parseAnswer(await ask(p)), ownIds),
                attempts: attempt,
            };
        }
        catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
        }
    }
    throw Object.assign(new Error(lastErr), { attempts: ATTEMPTS });
}
const changed = (r) => r.sectionsChanged === undefined ? "?" : r.sectionsChanged ? "yes" : "no";
const pct = (n, d) => d === 0 ? "-" : `${Math.round((100 * n) / d)}%`;
const edgeLine = (e) => `\`${e.from}\` -> \`${e.to}\` (${e.layer}, ${e.label})${e.anchor ? ` anchor: ${e.anchor}` : ""}${e.detail ? `: ${e.detail}` : ""}`;
export function report(model, results) {
    const ok = results.filter((r) => r.error === undefined);
    const sum = (f) => ok.reduce((n, r) => n + f(r), 0);
    const matched = sum((r) => r.matched?.length ?? 0);
    const fuzzy = sum((r) => r.matched?.filter((m) => m.fuzzy).length ?? 0);
    const extra = sum((r) => r.extra?.length ?? 0);
    const missing = sum((r) => r.missing?.length ?? 0);
    const lines = [
        `# Wiring parity: ${model}`,
        "",
        `${results.length} docs, ${results.length - ok.length} failed. Against the cached answers: ` +
            `${matched} edges agree (${fuzzy} by near names), ${extra} extra, ${missing} missing; ` +
            `precision ${pct(matched, matched + extra)}, recall ${pct(matched, matched + missing)}.`,
        "",
        "Extra edges are the ones to check against the doc: an extra edge the doc does not state is an invented one. " +
            '"Doc changed" means its wiring sections changed since the cached answer was made, so a difference there may be the doc, not the model.',
        "",
        "| Doc | Doc changed | Cached | Candidate | Agree | Extra | Missing | Precision | Recall | Attempts | Seconds |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ];
    for (const r of results) {
        if (r.error !== undefined) {
            lines.push(`| ${r.doc} | ${changed(r)} | ${r.cachedEdges} | failed: ${r.error.replace(/\|/g, "/").slice(0, 120)} | | | | | | ${r.attempts} | ${r.seconds} |`);
            continue;
        }
        const m = r.matched.length;
        const x = r.extra.length;
        const s = r.missing.length;
        lines.push(`| ${r.doc} | ${changed(r)} | ${r.cachedEdges} | ${r.candidateEdges} | ${m} | ${x} | ${s} | ${pct(m, m + x)} | ${pct(m, m + s)} | ${r.attempts} | ${r.seconds} |`);
    }
    for (const r of ok) {
        if (!r.extra.length &&
            !r.missing.length &&
            !r.matched.some((m) => m.fuzzy))
            continue;
        lines.push("", `## ${r.doc}`);
        if (r.extra.length)
            lines.push("", "Extra (only the candidate):", ...r.extra.map((e) => `- ${edgeLine(e)}`));
        if (r.missing.length)
            lines.push("", "Missing (only the cached answer):", ...r.missing.map((e) => `- ${edgeLine(e)}`));
        const near = r.matched.filter((m) => m.fuzzy);
        if (near.length)
            lines.push("", "Agree by near names (cached / candidate):", ...near.map((m) => `- \`${m.cached.from}\` -> \`${m.cached.to}\` / \`${m.candidate.from}\` -> \`${m.candidate.to}\``));
    }
    return lines.join("\n") + "\n";
}
function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--"))
            continue;
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
            args[a.slice(2)] = next;
            i++;
        }
        else
            args[a.slice(2)] = true;
    }
    return args;
}
export async function main(argv) {
    const args = parseArgs(argv);
    const str = (k) => typeof args[k] === "string" ? args[k] : undefined;
    const { atlasRoot, vizRoot } = loadAtlas(resolvePath(str("workspace") ?? process.cwd()));
    const jsonOut = str("json") ? resolvePath(str("json")) : undefined;
    if (jsonOut !== undefined &&
        !relative(join(vizRoot, "cache"), jsonOut).startsWith(".."))
        throw new Error("--json must not be inside viz/cache: an evaluation never writes the cache");
    const baseUrl = str("base-url");
    const socket = str("socket") ?? process.env[config().llm.socketEnv] ?? "";
    const model = str("model") ?? process.env[config().llm.socketModelEnv] ?? "";
    let ask;
    if (baseUrl !== undefined) {
        const key = process.env.WIRING_EVAL_API_KEY ?? "";
        if (!model)
            throw new Error("--base-url needs --model");
        if (!key)
            throw new Error("--base-url needs WIRING_EVAL_API_KEY");
        ask = patient(viaOpenAi(baseUrl, model, key));
    }
    else if (socket) {
        ask = patient(viaSocket(socket, model));
    }
    else {
        throw new Error(`no model to ask: pass --socket or --base-url (or set ${config().llm.socketEnv})`);
    }
    const label = model || "(the socket model)";
    const ctx = { atlasRoot, vizRoot, out: {}, log: () => { } };
    ctx.out.atlas = await readAtlas.run(ctx);
    // Visibility does not reach the prompt; reading the committed file keeps this from calling gh or writing it.
    const visPath = join(vizRoot, "data", "visibility.json");
    ctx.out.visibility = existsSync(visPath)
        ? JSON.parse(readFileSync(visPath, "utf8"))
        : {};
    const idx = (await components.run(ctx));
    const atlas = ctx.out.atlas;
    // The workspace's own prompt when it has one, else the package's (the same rule as the wiring stage).
    const own = join(vizRoot, "prompts", "extract-wiring.md");
    const template = readFileSync(existsSync(own)
        ? own
        : join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "extract-wiring.md"), "utf8");
    const componentIds = Object.keys(idx.ownerOf).sort().join(", ");
    const pins = JSON.parse(readFileSync(join(vizRoot, "data", "wiring-keys.json"), "utf8"));
    const cache = new Cache(join(vizRoot, "cache", "wiring"), true);
    const eligible = atlas.repos
        .filter((d) => !skip(d.fm) && SECTIONS().some((s) => d.sections[s]))
        .map((doc) => {
        const key = pins[doc.name];
        const cached = key === undefined ? undefined : cache.get(key);
        return {
            doc,
            key,
            cached,
            changed: key === undefined
                ? undefined
                : sectionsChangedSince(atlasRoot, vizRoot, doc, key),
        };
    })
        .filter((c) => c.cached !== undefined && c.key !== undefined);
    let chosen;
    const docs = str("docs");
    if (docs !== undefined) {
        const names = docs
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        const unknown = names.filter((n) => !eligible.some((c) => c.doc.name === n));
        if (unknown.length)
            throw new Error(`no cached answer to compare with for ${unknown.join(", ")}`);
        chosen = eligible.filter((c) => names.includes(c.doc.name));
    }
    else {
        const n = Number(str("sample") ?? 20);
        if (!Number.isInteger(n) || n < 1)
            throw new Error("--sample takes a whole number of docs");
        // Docs whose sections are as they were when answered make the fair comparison; take those when there are enough.
        const unchanged = eligible.filter((c) => c.changed === false);
        chosen = spread(unchanged.length >= n ? unchanged : eligible, n, (c) => c.cached.edges.length);
    }
    const concurrency = Number(str("concurrency") ?? MODEL_CALLS_AT_ONCE);
    console.log(`wiring parity: ${label}, ${chosen.length} of ${eligible.length} docs with a cached answer`);
    const results = await pmap(chosen, concurrency, async ({ doc, key, cached, changed }) => {
        const prompt = promptFor(template, doc, idx, componentIds);
        const ownIds = idx.componentsOf[doc.name] ?? [];
        const base = {
            doc: doc.name,
            cachedKey: key,
            ...(changed === undefined ? {} : { sectionsChanged: changed }),
            cachedEdges: cached.edges.length,
        };
        const t0 = Date.now();
        const seconds = () => Math.round((Date.now() - t0) / 1000);
        try {
            const { value, attempts } = await extract(ask, prompt, ownIds);
            const result = {
                ...base,
                candidateEdges: value.edges.length,
                attempts,
                seconds: seconds(),
                ...compareEdges(cached.edges, value.edges),
            };
            console.log(`  ${doc.name}: ${result.matched.length} agree, ${result.extra.length} extra, ${result.missing.length} missing`);
            return result;
        }
        catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            console.log(`  ${doc.name}: failed: ${error.slice(0, 200)}`);
            return {
                ...base,
                attempts: e.attempts ?? 1,
                error,
                seconds: seconds(),
            };
        }
    });
    const text = report(label, results);
    console.log("");
    console.log(text);
    if (jsonOut !== undefined)
        writeFileSync(jsonOut, JSON.stringify({ model: label, results }, null, 1));
    return 0;
}
//# sourceMappingURL=wiring-eval.js.map