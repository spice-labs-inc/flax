import { config, surfaceConfig } from "../config.js";
import { ENVS, SURFACES, } from "../lib/types.js";
export const STATUSES = ["uncovered", "planned", "failing", "passing"];
/**
 * Combines surface files with check run results. Per env an item is failing
 * when a failed scenario touched it in the step that failed (or anywhere, when
 * the run did not record steps), passing when the steps that touched it proved
 * every coverage need it has (one touch when it lists none), and otherwise
 * uncovered, including every env without a run.
 */
export function buildCoverage(files, builtAt, evidence = { runs: [], planned: [] }) {
    const bySurface = new Map(files.map((f) => [f.surface, f]));
    const surfaces = SURFACES.map((surface) => {
        const f = bySurface.get(surface);
        const perEnv = Object.fromEntries(ENVS.map((e) => [
            e,
            f?.items.filter((i) => i.envs.includes(e)).length ?? 0,
        ]));
        return {
            surface,
            builtAt: f?.builtAt ?? null,
            items: f?.items.length ?? 0,
            areas: new Set(f?.items.map((i) => i.area)).size,
            perEnv,
            sources: f?.sources ?? [],
            notes: f
                ? f.notes
                : ["No surface file: the builder has not produced one."],
            outOfScope: f?.outOfScope ?? [],
        };
    });
    const runs = new Map(evidence.runs.map((r) => [r.env, r]));
    const items = SURFACES.flatMap((s) => bySurface.get(s)?.items ?? []).map((i) => {
        const needs = coverageNeeds(i.details);
        const status = {};
        const proven = {};
        const alsoProven = {};
        const laterFailed = {};
        const scenarios = new Set();
        for (const e of i.envs) {
            const touching = (runs.get(e)?.scenarios ?? []).filter((s) => s.touches.some((t) => t.item === i.id));
            for (const s of touching)
                scenarios.add(s.id);
            const own = touching.map((s) => ({
                s,
                touches: s.touches.filter((t) => t.item === i.id),
            }));
            const met = new Set(own
                .filter(({ s }) => s.status === "passed" || s.status === "failed")
                .flatMap(({ s, touches }) => touches.filter((t) => !failedOn(s, t)))
                .map((t) => t.need ?? ""));
            const failedHere = own.some(({ s, touches }) => touches.some((t) => failedOn(s, t)));
            const before = own
                .filter(({ s, touches }) => s.status === "failed" && !touches.some((t) => failedOn(s, t)))
                .map(({ s }) => s.id);
            if (before.length > 0)
                laterFailed[e] = before.sort();
            const metNeeds = needs.filter((n) => met.has(n));
            if (metNeeds.length > 0 && needs.some((n) => n !== ""))
                proven[e] = metNeeds;
            const extra = [...met].filter((n) => n !== "" && !needs.includes(n));
            if (extra.length > 0)
                alsoProven[e] = extra.sort();
            status[e] = failedHere
                ? "failing"
                : metNeeds.length === needs.length
                    ? "passing"
                    : "uncovered";
        }
        return {
            id: i.id,
            label: i.label,
            surface: i.surface,
            area: i.area,
            envs: i.envs,
            status,
            scenarios: [...scenarios].sort(),
            ...(Object.keys(proven).length > 0 ? { proven } : {}),
            ...(Object.keys(alsoProven).length > 0 ? { alsoProven } : {}),
            ...(Object.keys(laterFailed).length > 0 ? { laterFailed } : {}),
        };
    });
    return {
        builtAt,
        envs: [...ENVS],
        surfaces,
        items,
        runs: evidence.runs.map((r) => ({
            env: r.env,
            runId: r.runId,
            startedAt: r.startedAt,
            scenarios: r.scenarios.length,
            passed: r.scenarios.filter((s) => s.status === "passed").length,
            failed: r.scenarios.filter((s) => s.status === "failed").length,
        })),
        planned: evidence.planned,
    };
}
/**
 * Whether a touch shares its scenario's failure: made in the failing step or
 * after it, or in a hook when one failed. Without the failing step or the
 * touches' steps, every touch fails.
 */
function failedOn(s, t) {
    if (s.status !== "failed")
        return false;
    const at = s.failure?.at;
    if (at === undefined || !s.touches.some((x) => x.step !== undefined))
        return true;
    if (t.step === undefined)
        return at < 0;
    return at !== -2 && t.step >= at;
}
/** Runs of one env, oldest first, as one run: each scenario's latest result, named after the newest run. */
export function mergeRuns(runs) {
    const newest = runs.at(-1);
    if (!newest)
        return undefined;
    const scenarios = new Map(runs.flatMap((r) => r.scenarios).map((s) => [s.id, s]));
    return {
        ...newest,
        startedAt: runs[0]?.startedAt ?? newest.startedAt,
        scenarios: [...scenarios.values()].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })),
    };
}
/** The needs an item lists in details.coverageNeeds; one unnamed need when it lists none. */
function coverageNeeds(details) {
    const needs = details?.["coverageNeeds"];
    return Array.isArray(needs) && needs.every((n) => typeof n === "string")
        ? needs
        : [""];
}
export function surfaceTitle(s) {
    return surfaceConfig(s)?.title ?? s;
}
function isGap(i) {
    return Object.values(i.status).some((s) => s !== "passing");
}
function md(text) {
    return text.replace(/([\\`*_[\]<>|])/g, "\\$1");
}
/** A code span that shows `text` exactly, with a longer fence when it contains backticks. */
function codeSpan(text) {
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = "`".repeat(longest + 1);
    const pad = longest > 0 ? " " : "";
    return `${fence}${pad}${text}${pad}${fence}`;
}
/** GAPS.md: counts per surface, then every uncovered or failing item by name, grouped by surface and area. */
/** Times people read are in the configured timezone with the zone named. */
export function pacific(iso) {
    return new Intl.DateTimeFormat("en-US", {
        timeZone: config().timezone,
        dateStyle: "medium",
        timeStyle: "short",
    })
        .formatToParts(new Date(iso))
        .map((p) => p.value)
        .join("")
        .replace(/\u202f/g, " ")
        .concat(" ", zoneName(iso));
}
function zoneName(iso) {
    return (new Intl.DateTimeFormat("en-US", {
        timeZone: config().timezone,
        timeZoneName: "short",
    })
        .formatToParts(new Date(iso))
        .find((p) => p.type === "timeZoneName")?.value ?? "PT");
}
export function renderGaps(map) {
    const gaps = map.items.filter(isGap);
    const out = [
        "# Coverage gaps",
        "",
        `Generated by \`pnpm coverage\` from \`coverage-map.json\` (built ${pacific(map.builtAt)}). Do not edit by hand.`,
        "",
        "An item is a gap until a scenario passes against it in every environment it applies to.",
        "",
        'A refusal proven beyond what an item needs, shows as "also proven" and never makes the item pass on its own.',
        "",
    ];
    for (const env of map.envs) {
        const r = map.runs.find((x) => x.env === env);
        out.push(r
            ? `- ${env}: newest run ${codeSpan(r.runId)}, with results since ${pacific(r.startedAt)}: ${r.scenarios} scenarios, ${r.passed} passed, ${r.failed} failed`
            : `- ${env}: no run, so every item counts as uncovered there`);
    }
    out.push("", `| Surface | Items | Gaps | Failing | Areas | ${ENVS.join(" | ")} |`, `| --- | ---: | ---: | ---: | ---: | ${ENVS.map(() => "---:").join(" | ")} |`);
    const failing = (i) => Object.values(i.status).includes("failing");
    for (const s of map.surfaces) {
        const mine = gaps.filter((g) => g.surface === s.surface);
        out.push(`| ${surfaceTitle(s.surface)} | ${s.items} | ${mine.length} | ${mine.filter(failing).length} | ${s.areas} | ${ENVS.map((e) => s.perEnv[e] ?? 0).join(" | ")} |`);
    }
    out.push(`| **Total** | ${map.items.length} | ${gaps.length} | ${gaps.filter(failing).length} | ${ENVS.map(() => "").join(" | ")} |`, "");
    for (const s of map.surfaces) {
        const mine = gaps.filter((g) => g.surface === s.surface);
        out.push(`## ${surfaceTitle(s.surface)} (${mine.length})`, "");
        for (const n of s.notes)
            out.push(`- ${md(n)}`);
        if (s.notes.length > 0)
            out.push("");
        if (s.outOfScope.length > 0) {
            out.push("Out of scope:", "");
            for (const o of s.outOfScope)
                out.push(`- ${md(o.label)}: ${md(o.reason)}`);
            out.push("");
        }
        const areas = [...new Set(mine.map((g) => g.area))].sort();
        for (const area of areas) {
            const inArea = mine.filter((g) => g.area === area);
            out.push(`### ${md(area)} (${inArea.length})`, "");
            for (const g of inArea) {
                const envs = g.envs.length === ENVS.length ? "" : ` (${g.envs.join(", ")})`;
                out.push(`- ${md(g.label)}${envs}: ${codeSpan(g.id)}${progress(g)}`);
            }
            out.push("");
        }
    }
    if (map.planned.length > 0) {
        out.push(`## Planned scenarios (${map.planned.length})`, "");
        out.push("Written for features not built yet; never run.", "");
        for (const p of map.planned)
            out.push(`- ${md(p.feature)}: ${md(p.name)} (${codeSpan(p.id)})`);
        out.push("");
    }
    return out.join("\n");
}
/** What runs showed about a gap, per env, when it is more than "uncovered", then what they proved beyond its needs. */
function progress(i) {
    const byState = new Map();
    const add = (state, e) => byState.set(state, [...(byState.get(state) ?? []), e]);
    for (const e of i.envs) {
        const status = i.status[e];
        const proven = i.proven?.[e];
        const state = status === "failing" || status === "passing"
            ? status
            : proven
                ? `${proven.join(" and ")} proven`
                : undefined;
        if (state)
            add(state, e);
    }
    for (const e of i.envs) {
        const also = i.alsoProven?.[e];
        if (also)
            add(`also proven: ${also.join(" and ")}`, e);
    }
    const parts = [...byState].map(([state, envs]) => envs.length === i.envs.length && envs.length > 1
        ? `${state} everywhere`
        : `${state} on ${envs.join(", ")}`);
    return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}
//# sourceMappingURL=map.js.map