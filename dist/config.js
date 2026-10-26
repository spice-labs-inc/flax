// The atlas config: every curated table the tools, the pipeline and the viewer
// read, taken from the `atlas:` section of the workspace's flax.yml. The shared
// keys (org, github, environments) come from the top level of that file.
// Defaults are the method (sections, budgets, enums, model env names); the org's
// own tables (planes, components, aliases) have no defaults beyond what a
// pipeline needs to run at all.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadWorkspace, section } from "@flax/core";
export const DEFAULTS = {
    root: ".",
    viz: "viz",
    org: { github: "", registry: "", packageGroups: [], ownHosts: [] },
    site: { title: "", cname: "", searchPlaceholder: "search", timezone: "UTC" },
    docs: {
        sections: [
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
        ],
        mainOnly: ["tldr", "recent"],
        wiringSections: [
            "role",
            "data",
            "interfaces",
            "architecture",
            "configuration",
        ],
        frontmatter: [
            "name",
            "repo",
            "language",
            "type",
            "status",
            "deploy",
            "depends_on",
            "used_by",
            "artifacts",
            "default_branch",
            "analyzed_commit",
            "analysis_source",
        ],
        rootPages: [
            "INDEX.md",
            "ARCHITECTURE.md",
            "GLOSSARY.md",
            "GAPS.md",
            "MACHINES.md",
            "PLAYBOOKS.md",
            "MAINTENANCE.md",
            "README.md",
            "_TEMPLATE.md",
        ],
        noVolatile: ["INDEX.md", "GLOSSARY.md", "ARCHITECTURE.md"],
        budgets: {
            line: 1500,
            bullet: 2048,
            doc: 32 * 1024,
            section: 8 * 1024,
            sectionFile: 40 * 1024,
            tldr: 800,
            h1Role: 72,
            recent: 5,
            index: 24 * 1024,
            glossaryEntry: 400,
            glossary: 25 * 1024,
            gapsEntry: 500,
        },
        recentNoise: "^(?:Release [\\w.-]+ v?\\d+\\.\\d+|Bump |chore\\(deps)",
        symmetryExempt: [],
        gapsTags: ["atlas", "org"],
        localRefs: ["~/dev/", "/home/", "\\.jdks/", "~/Downloads"],
        localRefsAllow: [],
        driftNoise: {},
    },
    enums: {
        type: [
            "service",
            "library",
            "cli",
            "ui",
            "gh-action",
            "infra",
            "gitops",
            "docs",
            "sample",
            "data",
            "tool",
            "fork",
        ],
        status: [
            "active",
            "maintenance",
            "parked",
            "deprecated",
            "archived",
            "sample",
        ],
        statusOrder: [
            "active",
            "maintenance",
            "parked",
            "sample",
            "deprecated",
            "archived",
        ],
    },
    planes: [],
    map: {
        defaultPlanes: [],
        planeRules: {
            byRepo: {},
            byType: {},
            infraLanguages: "\\b(hcl|terraform|tofu)\\b",
            infraLanguagePlane: "delivery",
            fallback: "delivery",
        },
        externalPlane: "external",
        infraPlane: "infra",
        deliveryPlane: "delivery",
        planeFix: {},
        wiringSkipTypes: ["gh-action", "docs", "sample"],
        views: [],
        components: {},
        environments: [],
        deliveryNodes: [],
        sites: [],
        outlets: [],
        curatedEdges: [],
        delivery: {
            registryMatch: "",
            registryNode: "",
            pinActions: { immediate: [], pr: [] },
        },
        gitops: {
            repo: "",
            checkout: "",
            overlays: {},
            curated: {},
            machinesSkip: ["base", "systemd"],
        },
        manifests: { checkouts: ".." },
        resolve: {
            aliases: {},
            canonical: {},
            generic: [
                "postgres",
                "postgresql",
                "database",
                "db",
                "sqlite",
                "rocksdb",
                "duckdb",
                "filesystem",
                "disk",
                "local disk",
                "cache",
                "redis",
                "blob",
                "bucket",
                "object storage",
            ],
            envTokens: [],
            storeMerge: {},
            storeNames: {},
            ownedDb: {},
            transit: [],
            proxyEdges: [],
            minGraph: { nodes: 100, edges: 100 },
        },
    },
    inventories: [],
    checks: {
        gitopsPaths: {
            enabled: false,
            prefixes: [],
            skipPhrases: [
                "[Dd]eleted",
                "DELETED",
                "removed",
                "parked",
                "moved",
                "is gone",
                "then,",
                "then`",
            ],
            skipSections: ["recent"],
        },
    },
    llm: {
        modelEnv: "ATLAS_WIRING_MODEL",
        fallbackEnv: "ATLAS_WIRING_FALLBACK_MODEL",
        socketEnv: "ATLAS_MODEL_SOCKET",
        socketModelEnv: "ATLAS_SOCKET_MODEL",
        concurrency: 2,
        maxTokens: 32000,
    },
    sources: {
        containment: "data/containment.json",
        advisories: "data/advisories.json",
    },
};
export const SECTION = "atlas";
function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
}
/** Deep merge of plain objects; arrays and scalars in `over` replace. */
function merge(base, over) {
    if (!isObj(over) || !isObj(base))
        return over === null || over === undefined ? base : over;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
        const b = base[k];
        out[k] = isObj(v) && isObj(b) ? merge(b, v) : v;
    }
    return out;
}
export function validate(c) {
    const problems = [];
    const ids = new Set(c.planes.map((p) => p.id));
    if (!c.planes.length)
        problems.push("planes: at least one plane is needed");
    for (const p of c.planes)
        if (!p.id || !p.label)
            problems.push(`planes: every plane needs an id and a label (${JSON.stringify(p)})`);
    for (const p of c.planes)
        if (p.index && !p.heading)
            problems.push(`planes.${p.id}: an index plane needs a heading`);
    for (const [k, v] of Object.entries(c.map.planeRules.byType))
        if (!ids.has(v))
            problems.push(`map.planeRules.byType.${k}: unknown plane ${v}`);
    for (const [k, v] of Object.entries(c.map.planeFix))
        if (!ids.has(v))
            problems.push(`map.planeFix.${k}: unknown plane ${v}`);
    for (const k of Object.keys(c.map.planeRules.byRepo))
        if (!ids.has(k))
            problems.push(`map.planeRules.byRepo.${k}: unknown plane`);
    for (const p of [
        c.map.externalPlane,
        c.map.infraPlane,
        c.map.deliveryPlane,
        c.map.planeRules.fallback,
    ])
        if (!ids.has(p))
            problems.push(`plane ${p} is referenced but not in planes[] (externalPlane, infraPlane, deliveryPlane and planeRules.fallback must exist)`);
    if (c.map.tenancy && !ids.has(c.map.tenancy.plane))
        problems.push(`map.tenancy.plane ${c.map.tenancy.plane}: unknown plane`);
    for (const v of c.map.views)
        for (const p of v.planes)
            if (!ids.has(p))
                problems.push(`map.views.${v.id}: unknown plane ${p}`);
    for (const p of c.map.defaultPlanes)
        if (!ids.has(p))
            problems.push(`map.defaultPlanes: unknown plane ${p}`);
    for (const s of c.docs.mainOnly)
        if (!c.docs.sections.includes(s))
            problems.push(`docs.mainOnly: ${s} is not a section`);
    for (const s of c.docs.wiringSections)
        if (!c.docs.sections.includes(s))
            problems.push(`docs.wiringSections: ${s} is not a section`);
    if (c.map.tenancy) {
        const single = new Set([
            ...c.map.tenancy.inNamespace,
            ...c.map.tenancy.perProjectData,
            ...c.map.tenancy.customerSide,
        ]);
        for (const id of c.map.tenancy.sharedDespite)
            if (single.has(id))
                problems.push(`tenancy: ${id} is shared, not single-tenant`);
    }
    for (const [i, inv] of c.inventories.entries()) {
        for (const k of ["id", "doc", "repo", "renderer"])
            if (typeof inv[k] !== "string" || !inv[k])
                problems.push(`inventories[${i}]: ${k} is required`);
    }
    if (c.checks.gitopsPaths.enabled && !c.map.gitops.repo)
        problems.push("checks.gitopsPaths: map.gitops.repo must name the gitops repository");
    if (c.checks.gitopsPaths.enabled && !c.checks.gitopsPaths.prefixes.length)
        problems.push("checks.gitopsPaths: prefixes must list at least one path prefix");
    return problems;
}
/** Environment nodes from the workspace list, each with the role sentence the atlas section gives it. */
function environmentNodes(ws, given) {
    if (Array.isArray(given))
        return given;
    const roles = isObj(given) ? given : {};
    for (const id of Object.keys(roles)) {
        if (!ws.environments.some((e) => e.id === id))
            throw new Error(`atlas.map.environments: ${id} is not a workspace environment`);
    }
    return ws.environments.map((e) => ({
        id: `env:${e.id}`,
        label: e.label ?? e.id,
        role: String(roles[e.id] ?? ""),
    }));
}
/** The atlas config of a parsed workspace: the `atlas:` section over the defaults, with the shared keys folded in. */
export function configOf(ws) {
    const raw = section(ws, SECTION);
    const envs = environmentNodes(ws, isObj(raw["map"]) ? raw["map"]["environments"] : undefined);
    const c = merge(structuredClone(DEFAULTS), raw);
    c.map.environments = envs;
    if (!c.org.github)
        c.org.github = ws.github ?? ws.org;
    if (!c.site.title)
        c.site.title = `${ws.org} atlas`;
    if (!c.map.resolve.envTokens.length)
        c.map.resolve.envTokens = ws.environments.map((e) => e.id);
    const problems = validate(c);
    if (problems.length)
        throw new Error(`flax.yml atlas section:\n  ${problems.join("\n  ")}`);
    return c;
}
let current;
let currentPaths;
/** Loads <dir>/flax.yml and makes its atlas section the active config. */
export function loadAtlas(dir) {
    const workspace = loadWorkspace(dir);
    const config = configOf(workspace);
    const atlasRoot = resolve(workspace.dir, config.root);
    if (!existsSync(join(atlasRoot, "repos")))
        throw new Error(`no repos/ directory under ${atlasRoot} (atlas.root in flax.yml names the atlas directory)`);
    const vizRoot = resolve(atlasRoot, config.viz);
    current = config;
    currentPaths = { workspace, config, atlasRoot, vizRoot };
    return currentPaths;
}
/** Sets the active config directly (tests). */
export function setConfig(c) {
    current = merge(structuredClone(DEFAULTS), c);
    return current;
}
export function config() {
    if (!current)
        throw new Error("atlas config not loaded (loadAtlas(workspace) first)");
    return current;
}
export function paths() {
    if (!currentPaths)
        throw new Error("atlas workspace not loaded (loadAtlas(workspace) first)");
    return currentPaths;
}
export const planeById = (id) => config().planes.find((p) => p.id === id);
export const planeIds = () => config().planes.map((p) => p.id);
export const indexPlanes = () => config().planes.filter((p) => p.index);
/** What the viewer needs, embedded into the built page. */
export function viewerConfig(c = config()) {
    return {
        site: c.site,
        org: { github: c.org.github },
        planes: c.planes
            .filter((p) => p.map !== false)
            .map((p) => ({
            id: p.id,
            label: p.label,
            slug: p.slug ?? p.id,
            color: p.color ?? "#8496A4",
        })),
        views: c.map.views,
        defaultPlanes: c.map.defaultPlanes,
    };
}
//# sourceMappingURL=config.js.map