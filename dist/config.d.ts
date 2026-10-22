import { type Workspace } from "@flax/core";
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
        driftNoise: Record<string, {
            paths: string[];
            imagePinsIn?: string[];
        }>;
    };
    enums: {
        type: string[];
        status: string[];
        statusOrder: string[];
    };
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
            pinActions: {
                immediate: string[];
                pr: string[];
            };
            /** A direct-apply tool named in deploy lines: "<env> via <name>"; `title` is its name in prose (`name` when absent). */
            applyTool?: {
                name: string;
                title?: string;
                label: string;
                detail: string;
            };
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
        manifests: {
            checkouts: string;
        };
        resolve: {
            aliases: Record<string, string>;
            canonical: Record<string, {
                label?: string;
                role: string;
            }>;
            generic: string[];
            /** Environment words a wiring answer may suffix a store with; the workspace environment ids when unset. */
            envTokens: string[];
            storeMerge: Record<string, string>;
            storeNames: Record<string, {
                label: string;
                role?: string;
            }>;
            ownedDb: Record<string, string>;
            gateway?: {
                node: string;
                target: string;
                clients: Record<string, {
                    note: string;
                    unverified?: boolean;
                }>;
            };
            transit: string[];
            proxyEdges: Array<{
                source: string;
                target: string;
            }>;
            minGraph: {
                nodes: number;
                edges: number;
            };
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
    checks: {
        gitopsPaths: GitopsPathsCheck;
    };
    llm: {
        modelEnv: string;
        fallbackEnv: string;
        socketEnv: string;
        socketModelEnv: string;
        concurrency: number;
        maxTokens: number;
    };
    sources: {
        containment: string;
        advisories: string;
    };
}
export declare const DEFAULTS: AtlasConfig;
export declare const SECTION = "atlas";
export declare function validate(c: AtlasConfig): string[];
/** The atlas config of a parsed workspace: the `atlas:` section over the defaults, with the shared keys folded in. */
export declare function configOf(ws: Workspace): AtlasConfig;
export interface AtlasPaths {
    workspace: Workspace;
    config: AtlasConfig;
    /** The directory holding INDEX.md and repos/. */
    atlasRoot: string;
    /** The directory holding data/, cache/, flows/, prompts/ and dist/. */
    vizRoot: string;
}
/** Loads <dir>/flax.yml and makes its atlas section the active config. */
export declare function loadAtlas(dir: string): AtlasPaths;
/** Sets the active config directly (tests). */
export declare function setConfig(c: unknown): AtlasConfig;
export declare function config(): AtlasConfig;
export declare function paths(): AtlasPaths;
export declare const planeById: (id: string) => PlaneDef | undefined;
export declare const planeIds: () => string[];
export declare const indexPlanes: () => PlaneDef[];
/** What the viewer needs, embedded into the built page. */
export declare function viewerConfig(c?: AtlasConfig): ViewerConfig;
