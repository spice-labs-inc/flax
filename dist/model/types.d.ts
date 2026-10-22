export type Layer = 'network' | 'queue' | 'build' | 'data' | 'delivery' | 'shared-deps'
/** Two components carrying the same published advisory. Derived, not declared. */
 | 'advisory';
/** A plane id from the atlas config `planes[]`; the config is the closed list, not the type. */
export type Plane = string;
export type NodeKind = 'component' | 'library' | 'queue' | 'broker' | 'store' | 'external' | 'registry' | 'env' | 'outlet' | 'machine';
export type Visibility = 'public' | 'internal' | 'private' | 'n/a';
/** A status from the atlas config `enums.status`. */
export type Status = string;
export interface GraphNode {
    id: string;
    label: string;
    kind: NodeKind;
    plane: Plane;
    status: Status;
    visibility: Visibility;
    /** Owning atlas repo. Several repos ship more than one component. */
    repo?: string;
    /** Other components built from the same repo, for the inspector. */
    siblings?: string[];
    language?: string;
    type?: string;
    deploy?: string;
    artifacts?: string[];
    /** First sentences of the atlas ## tldr section. */
    tldr?: string;
    /** One line saying what this component is, when it differs from the repo. */
    role?: string;
    /** Machines or environments this runs on. */
    runsOn?: string[];
    /** Path within the atlas repo, for "read more". */
    doc?: string;
    /** Set when the node was curated rather than read from frontmatter. */
    curated?: boolean;
    /**
     * A waypoint rather than a destination. Nothing ever means to talk to it; it
     * is on the path to something else. Selection reads straight through it.
     */
    transit?: boolean;
    /**
     * Advisories this component carries, worst first, as ids into
     * {@link Graph.advisories}. An advisory is an attribute of a component, not a
     * thing in the architecture, so it hangs here rather than being a node.
     */
    advisoryIds?: string[];
    /** Precomputed layout position, so the viewer never runs a simulation. */
    x?: number;
    y?: number;
    z?: number;
    /** Number of edges touching this node, across all layers. */
    degree?: number;
    /**
     * Precomputed 2D position per grouping, for the 2D view. Keyed by
     * {@link GroupKey}: a node sits in a different place depending on which
     * question the boxes are answering.
     */
    pos2d?: Partial<Record<GroupKey, [number, number]>>;
    /**
     * Which group this node falls in, per grouping. Baked so both views agree:
     * the flat view draws boxes from it and the 3D view draws force fields, and
     * they must not disagree about what is inside what.
     */
    groupOf?: Partial<Record<GroupKey, string>>;
}
export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    layer: Layer;
    /** Short label drawn on the edge / shown in lists: "HTTP :3000", "report-generate". */
    label: string;
    /** Prose for the inspector. */
    detail?: string;
    /** repo-relative path or chart/workflow name backing the claim. */
    anchor?: string;
    /** Marks an edge the atlas itself flags as UNVERIFIED. */
    unverified?: boolean;
    /**
     * Marks an edge derived from observed containment rather than declared by a
     * document. Read differently: it is evidence of coupling, not a statement
     * that anyone designed the two things to be related.
     */
    derived?: boolean;
    /** For derived edges: the most distinctive items the endpoints have in common. */
    shared?: string[];
    /** For derived edges: how many distinct package coordinates are shared in total. */
    sharedTotal?: number;
    /**
     * This hop forwards rather than terminates: the real destination is further
     * along. Selection follows it, so a caller and the thing actually answering
     * light up together even with a service in between.
     */
    proxy?: boolean;
}
export interface FlowStep {
    from: string;
    to: string;
    layer: Layer;
    title: string;
    detail: string;
    anchor?: string;
}
export interface Flow {
    id: string;
    name: string;
    plane: Plane;
    summary: string;
    steps: FlowStep[];
}
/** One published advisory, as captured from the advisory source at a pinned instant. */
export interface AdvisoryRecord {
    id: string;
    /** CVSS band, scored from the vector; 'unrated' when only a v4 vector exists. */
    severity: string;
    score?: number;
    summary?: string;
    details?: string;
    /** The affected package, which is the part a reader actually needs. */
    package: string;
    /** Every purl this advisory was matched through. */
    purls: string[];
    url?: string;
    fixedIn?: string[];
}
/** Bend points for one edge under one grouping, flattened as x,y,x,y. */
export type EdgeRoute = number[];
export interface Graph {
    generatedAt: string;
    /** The instant the advisory capture speaks about, when there is one. */
    advisoriesAsOf?: string;
    /** Every advisory any component carries, keyed by id. */
    advisories?: Record<string, AdvisoryRecord>;
    atlasCommit: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
    flows: Flow[];
    /** The 2D boxes, per grouping. Absent groupings simply offer no boxes. */
    groups?: Partial<Record<GroupKey, Group[]>>;
    /**
     * Edge routes per grouping, keyed by edge id. Only edges the layout actually
     * bent appear; anything absent is drawn straight between its two nodes.
     */
    routes?: Partial<Record<GroupKey, Record<string, EdgeRoute>>>;
    stats: Record<string, number>;
}
/** How the 2D view partitions the graph into boxes. */
export type GroupKey = 'plane' | 'kind' | 'status' | 'deploy';
/**
 * Only plane. The others were offered and did not earn it: deployment placed 13
 * of 304 nodes in a box and left 291 floating, and kind and lifecycle partition
 * cleanly but answer a question nobody was asking of a containment diagram.
 * Plane is the one grouping where "what is inside what" is the same question the
 * map is already about, and it is the one the 3D view draws shells for.
 *
 * The machinery below still takes a key, so adding one back is a one-line
 * change plus a regenerate.
 */
export declare const GROUP_KEYS: GroupKey[];
/** One box in the 2D view: a rectangle the member nodes are laid out inside. */
export interface Group {
    id: string;
    label: string;
    /** Box centre and extent, in the same units as the 2D node positions. */
    x: number;
    y: number;
    w: number;
    h: number;
    count: number;
    /**
     * Set when the group is a single delivery target rather than a plane: the
     * plane it belongs to, whose color it wears.
     */
    within?: Plane;
}
/**
 * Radius of a delivery target's own shell in the 3D map, in layout units. A
 * target is one node, so no spread can size it; this leaves room for its name
 * around the rim.
 */
export declare const TARGET_SHELL_RADIUS = 120;
