import type { Layer } from '../model/types.ts';
import { type Stage } from '../pipeline/machine.ts';
export interface RawEdge {
    from: string;
    to: string;
    layer: Layer;
    label: string;
    detail?: string;
    anchor?: string;
    unverified?: boolean;
    /** Repo the claim came from, for provenance in the inspector. */
    origin?: string;
}
export interface RawInfra {
    id: string;
    kind: 'queue' | 'broker' | 'store' | 'external' | 'registry';
    label: string;
    role?: string;
    /** Which doc declared it. A thing only one doc knows about belongs to it. */
    origin?: string;
}
export interface WiringResult {
    edges: RawEdge[];
    infra: RawInfra[];
    /** The model that made this answer; answers cached before it was recorded have none. */
    model?: string;
}
/** The stage output: every doc's wiring, plus the cache entry each came from. */
export interface WiringStageResult extends WiringResult {
    keys: Record<string, string>;
    /** A hash of the wiring sections each doc's answer was made from, for --reextract-changed. */
    sections: Record<string, string>;
    /** Docs whose re-extracted answer replaced a previous one, and what a doc keeping it would carry. */
    replaced?: Record<string, PreviousWiring>;
}
/** The answer a re-extracted doc had before, as a failed re-extraction would keep it. */
export interface PreviousWiring {
    answer: WiringResult;
    key: string;
    sections: string;
}
export declare const SECTIONS: () => string[];
/** Docs with no runtime surface worth a model call. */
export declare function skip(fm: Record<string, any>): boolean;
export declare function validate(raw: any, ownIds: string[]): WiringResult;
export declare const wiring: Stage;
