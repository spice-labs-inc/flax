import { type RawEdge } from "./stages/wiring.ts";
export interface EdgeMatch {
    matched: {
        cached: RawEdge;
        candidate: RawEdge;
        fuzzy: boolean;
    }[];
    extra: RawEdge[];
    missing: RawEdge[];
}
export interface DocResult extends Partial<EdgeMatch> {
    doc: string;
    /** The cache entry compared against. */
    cachedKey: string;
    /**
     * Whether the doc's wiring sections changed since the cached answer was
     * committed; undefined without the git history to tell. A changed doc can
     * disagree with its old answer and both be right.
     */
    sectionsChanged?: boolean;
    cachedEdges: number;
    candidateEdges?: number;
    attempts: number;
    error?: string;
    seconds: number;
}
/** Pairs each candidate edge with a cached one of the same layer and direction: exact names first, then near names. */
export declare function compareEdges(cached: RawEdge[], candidate: RawEdge[]): EdgeMatch;
/** Evenly spaced picks over the docs sorted by how many edges their cached answer has. */
export declare function spread<T>(items: T[], n: number, weight: (t: T) => number): T[];
export declare function report(model: string, results: DocResult[]): string;
export declare function main(argv: string[]): Promise<number>;
