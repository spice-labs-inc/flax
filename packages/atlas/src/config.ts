// The atlas config: every curated table the tools, the pipeline and the viewer
// read, taken from the `atlas:` section of the workspace's flax.yml. The shared
// keys (org, github, environments) come from the top level of that file.
// Defaults are the method (sections, budgets, enums, model env names); the org's
// own tables (planes, components, aliases) have no defaults beyond what a
// pipeline needs to run at all.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadWorkspace, section, type Workspace } from "@flax/core";
import type { ViewerConfig } from "./model/viewer-config.ts";

export type { ViewerConfig } from "./model/viewer-config.ts";

export interface PlaneDef {
  id: string;
  label: string;
  /** URL segment in the viewer's routes; the id when absent. */
  slug?: string;
  color?: string;
  /** Rowed in INDEX.md under `heading`. */
  index?: boolean;
  heading?: string;
  /** Drawn on the map. */
  map?: boolean;
  /** 3D layout anchor; a plane without one gathers at the origin. */
  anchor?: [number, number, number];
  /** Moved bodily onto its anchor after the simulation instead of pulled. */
  placed?: boolean;
  /** Anchor pull strength override. */
  pull?: number;
}

export interface ComponentSpec {
  id: string;
  label: string;
  role: string;
  kind?: string;
  visibility?: string;
}

export interface CuratedNode {
  id: string;
  label: string;
  role: string;
  kind?: string;
  plane?: string;
  doc?: string;
  /** Sites: a regex over the host named in the deploy line. */
  host?: string;
}

export interface CuratedEdge {
  id: string;
  source: string;
  target: string;
  layer: string;
  label: string;
  detail?: string;
  anchor?: string;
  /** Emitted before the per-doc delivery edges (the default) or after them; order moves the 3D layout. */
  phase?: "before" | "after";
}

export interface ViewDef {
  id: string;
  label: string;
  hint: string;
  layers: string[];
  planes: string[];
  byAdvisories?: boolean;
  mutedEdges?: boolean;
  subject?: string;
}

export interface InventoryDef {
  /** Generated block id, and the doc that must carry the block (main doc or one of its section files). */
  id: string;
  doc: string;
  repo: string;
  /** Sparse-checkout paths a clone needs. */
  paths: string[];
  /** A module, relative to the workspace, exporting `render(dir, helpers)`; see inventories.ts. */
  renderer: string;
}

export interface GitopsPathsCheck {
  /** Off by default: the check needs the gitops checkout or `gh` and network. */
  enabled: boolean;
  /** Path prefixes a doc may cite (regex sources over the path's first segments), e.g. `apps/(base|live)`. */
  prefixes: string[];
  /** A line containing one of these (regex sources) is history, not a live citation. */
  skipPhrases: string[];
  /** Sections never checked. */
  skipSections: string[];
}

export interface AtlasConfig {
  /** The atlas directory, relative to the workspace (`.` when flax.yml sits in the atlas). */
  root: string;
  /** The directory holding data/, cache/, flows/, prompts/ and dist/, relative to the atlas root. */
  viz: string;
  org: {
    /** GitHub org; repo URLs, visibility and clones derive from it. The workspace's `github` key. */
    github: string;
    /** Container registry host and path prefix the artifacts lines name, e.g. ghcr.io/acme. */
    registry: string;
    /** Package group ids manifests name the org by (maven groupId, sbt organization). */
    packageGroups: string[];
    /** Hostname suffixes that are the org's own; a wiring answer naming one is not a third party. */
    ownHosts: string[];
  };
  site: {
    title: string;
    cname: string;
    searchPlaceholder: string;
    timezone: string;
  };
  docs: {
    sections: string[];
    /** Sections that never move to a section file. */
    mainOnly: string[];
    /** Sections the wiring stage reads. */
    wiringSections: string[];
    frontmatter: string[];
    rootPages: string[];
    noVolatile: string[];
    budgets: {
      line: number;
      bullet: number;
      doc: number;
      section: number;
      sectionFile: number;
      tldr: number;
      h1Role: number;
      recent: number;
      index: number;
      glossaryEntry: number;
      glossary: number;
      gapsEntry: number;
    };
    /** PR titles that never make a `## recent` line (regex source). */
    recentNoise: string;
    symmetryExempt: string[];
    gapsTags: string[];
    /** Shareability: patterns that mark a machine-local reference (regex sources) and lines to allow. */
    localRefs: string[];
    localRefsAllow: string[];
    /** Repos whose drift can be noise, with the path patterns that are noise there. */
    driftNoise: Record<string, { paths: string[]; imagePinsIn?: string[] }>;
  };
  enums: { type: string[]; status: string[]; statusOrder: string[] };
  planes: PlaneDef[];
  map: {
    /** Planes the viewer opens with. */
    defaultPlanes: string[];
    planeRules: {
      byRepo: Record<string, string[]>;
      byType: Record<string, string>;
      /** Type whose plane depends on language: HCL-like infra is delivery. */
      infraLanguages: string;
      infraLanguagePlane: string;
      fallback: string;
    };
    externalPlane: string;
    infraPlane: string;
    deliveryPlane: string;
    planeFix: Record<string, string>;
    /** Doc types that get no wiring call. */
    wiringSkipTypes: string[];
    views: ViewDef[];
    components: Record<string, ComponentSpec[]>;
    /**
     * One node per workspace environment, in the workspace's order, with the id `env:<id>`.
     * In flax.yml this is a mapping of environment id to its role sentence; the list form
     * is accepted as a full override.
     */
    environments: CuratedNode[];
    deliveryNodes: CuratedNode[];
    sites: CuratedNode[];
    outlets: CuratedNode[];
    curatedEdges: CuratedEdge[];
    delivery: {
      /** Substring of a deploy or artifacts line that means the image goes to the registry node. */
      registryMatch: string;
      registryNode: string;
      /** Actions whose presence in depends_on means a gitops pin is written. */
      pinActions: { immediate: string[]; pr: string[] };
      /** A direct-apply tool named in deploy lines: "<env> via <name>"; `title` is its name in prose (`name` when absent). */
      applyTool?: { name: string; title?: string; label: string; detail: string };
    };
    gitops: {
      repo: string;
      /** Checkout, relative to the atlas root. */
      checkout: string;
      overlays: Record<string, string>;
      curated: Record<string, string>;
      /** Directory under apps/ holding per-machine compose stacks; absent means no machine walk. */
      machinesDir?: string;
      machinesSkip: string[];
      /** The node that reconciles compose stacks onto machines; a machine edge's source. */
      machineReconciler?: string;
    };
    manifests: { checkouts: string };
    resolve: {
      aliases: Record<string, string>;
      canonical: Record<string, { label?: string; role: string }>;
      generic: string[];
      /** Environment words a wiring answer may suffix a store with; the workspace environment ids when unset. */
      envTokens: string[];
      storeMerge: Record<string, string>;
      storeNames: Record<string, { label: string; role?: string }>;
      ownedDb: Record<string, string>;
      gateway?: {
        node: string;
        target: string;
        clients: Record<string, { note: string; unverified?: boolean }>;
      };
      transit: string[];
      proxyEdges: Array<{ source: string; target: string }>;
      minGraph: { nodes: number; edges: number };
    };
    tenancy?: {
      plane: string;
      from: string;
      inNamespace: string[];
      perProjectData: string[];
      sharedDespite: string[];
      customerSide: string[];
    };
  };
  inventories: InventoryDef[];
  checks: { gitopsPaths: GitopsPathsCheck };
  llm: {
    modelEnv: string;
    fallbackEnv: string;
    socketEnv: string;
    socketModelEnv: string;
    concurrency: number;
    maxTokens: number;
  };
  sources: { containment: string; advisories: string };
}

export const DEFAULTS: AtlasConfig = {
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

type Plain = Record<string, unknown>;

function isObj(v: unknown): v is Plain {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge of plain objects; arrays and scalars in `over` replace. */
function merge<T>(base: T, over: unknown): T {
  if (!isObj(over) || !isObj(base))
    return over === null || over === undefined ? base : (over as T);
  const out: Plain = { ...(base as Plain) };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as Plain)[k];
    out[k] = isObj(v) && isObj(b) ? merge(b, v) : v;
  }
  return out as T;
}

export function validate(c: AtlasConfig): string[] {
  const problems: string[] = [];
  const ids = new Set(c.planes.map((p) => p.id));
  if (!c.planes.length) problems.push("planes: at least one plane is needed");
  for (const p of c.planes)
    if (!p.id || !p.label)
      problems.push(
        `planes: every plane needs an id and a label (${JSON.stringify(p)})`,
      );
  for (const p of c.planes)
    if (p.index && !p.heading)
      problems.push(`planes.${p.id}: an index plane needs a heading`);
  for (const [k, v] of Object.entries(c.map.planeRules.byType))
    if (!ids.has(v))
      problems.push(`map.planeRules.byType.${k}: unknown plane ${v}`);
  for (const [k, v] of Object.entries(c.map.planeFix))
    if (!ids.has(v)) problems.push(`map.planeFix.${k}: unknown plane ${v}`);
  for (const k of Object.keys(c.map.planeRules.byRepo))
    if (!ids.has(k)) problems.push(`map.planeRules.byRepo.${k}: unknown plane`);
  for (const p of [
    c.map.externalPlane,
    c.map.infraPlane,
    c.map.deliveryPlane,
    c.map.planeRules.fallback,
  ])
    if (!ids.has(p))
      problems.push(
        `plane ${p} is referenced but not in planes[] (externalPlane, infraPlane, deliveryPlane and planeRules.fallback must exist)`,
      );
  if (c.map.tenancy && !ids.has(c.map.tenancy.plane))
    problems.push(`map.tenancy.plane ${c.map.tenancy.plane}: unknown plane`);
  for (const v of c.map.views)
    for (const p of v.planes)
      if (!ids.has(p)) problems.push(`map.views.${v.id}: unknown plane ${p}`);
  for (const p of c.map.defaultPlanes)
    if (!ids.has(p)) problems.push(`map.defaultPlanes: unknown plane ${p}`);
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
    for (const k of ["id", "doc", "repo", "renderer"] as const)
      if (typeof inv[k] !== "string" || !inv[k])
        problems.push(`inventories[${i}]: ${k} is required`);
  }
  if (c.checks.gitopsPaths.enabled && !c.map.gitops.repo)
    problems.push(
      "checks.gitopsPaths: map.gitops.repo must name the gitops repository",
    );
  if (c.checks.gitopsPaths.enabled && !c.checks.gitopsPaths.prefixes.length)
    problems.push(
      "checks.gitopsPaths: prefixes must list at least one path prefix",
    );
  return problems;
}

/** Environment nodes from the workspace list, each with the role sentence the atlas section gives it. */
function environmentNodes(ws: Workspace, given: unknown): CuratedNode[] {
  if (Array.isArray(given)) return given as CuratedNode[];
  const roles = isObj(given) ? given : {};
  for (const id of Object.keys(roles)) {
    if (!ws.environments.some((e) => e.id === id))
      throw new Error(
        `atlas.map.environments: ${id} is not a workspace environment`,
      );
  }
  return ws.environments.map((e) => ({
    id: `env:${e.id}`,
    label: e.label ?? e.id,
    role: String(roles[e.id] ?? ""),
  }));
}

/** The atlas config of a parsed workspace: the `atlas:` section over the defaults, with the shared keys folded in. */
export function configOf(ws: Workspace): AtlasConfig {
  const raw = section(ws, SECTION);
  const envs = environmentNodes(
    ws,
    isObj(raw["map"]) ? raw["map"]["environments"] : undefined,
  );
  const c = merge(structuredClone(DEFAULTS), raw);
  c.map.environments = envs;
  if (!c.org.github) c.org.github = ws.github ?? ws.org;
  if (!c.site.title) c.site.title = `${ws.org} atlas`;
  if (!c.map.resolve.envTokens.length)
    c.map.resolve.envTokens = ws.environments.map((e) => e.id);
  const problems = validate(c);
  if (problems.length)
    throw new Error(`flax.yml atlas section:\n  ${problems.join("\n  ")}`);
  return c;
}

export interface AtlasPaths {
  workspace: Workspace;
  config: AtlasConfig;
  /** The directory holding INDEX.md and repos/. */
  atlasRoot: string;
  /** The directory holding data/, cache/, flows/, prompts/ and dist/. */
  vizRoot: string;
}

let current: AtlasConfig | undefined;
let currentPaths: AtlasPaths | undefined;

/** Loads <dir>/flax.yml and makes its atlas section the active config. */
export function loadAtlas(dir: string): AtlasPaths {
  const workspace = loadWorkspace(dir);
  const config = configOf(workspace);
  const atlasRoot = resolve(workspace.dir, config.root);
  if (!existsSync(join(atlasRoot, "repos")))
    throw new Error(
      `no repos/ directory under ${atlasRoot} (atlas.root in flax.yml names the atlas directory)`,
    );
  const vizRoot = resolve(atlasRoot, config.viz);
  current = config;
  currentPaths = { workspace, config, atlasRoot, vizRoot };
  return currentPaths;
}

/** Sets the active config directly (tests). */
export function setConfig(c: unknown): AtlasConfig {
  current = merge(structuredClone(DEFAULTS), c);
  return current;
}

export function config(): AtlasConfig {
  if (!current)
    throw new Error("atlas config not loaded (loadAtlas(workspace) first)");
  return current;
}

export function paths(): AtlasPaths {
  if (!currentPaths)
    throw new Error("atlas workspace not loaded (loadAtlas(workspace) first)");
  return currentPaths;
}

export const planeById = (id: string): PlaneDef | undefined =>
  config().planes.find((p) => p.id === id);
export const planeIds = (): string[] => config().planes.map((p) => p.id);
export const indexPlanes = (): PlaneDef[] =>
  config().planes.filter((p) => p.index);

/** What the viewer needs, embedded into the built page. */
export function viewerConfig(c: AtlasConfig = config()): ViewerConfig {
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
