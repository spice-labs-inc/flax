import type { WiringResult, WiringStageResult } from './wiring.ts';
export interface BrokenStep {
    flow: string;
    /** 1-based, as the log and the flow files count them. */
    step: number;
    from: string;
    to: string;
    /** The step's names that matched no node. */
    missing: string[];
}
export interface Probe {
    broken: BrokenStep[];
    /** The node a raw name resolves to in this graph. */
    nodeOf: (name: string) => string | undefined;
}
export interface Held {
    doc: string;
    steps: BrokenStep[];
}
/** The wiring with these docs carrying their previous answer instead of this run's. */
export declare function withPrevious(wire: WiringStageResult, docs: string[]): WiringStageResult;
/**
 * What the previous answer called a node the new one lost, and the names the
 * new answer likely used in its place: new declarations of the same kind,
 * narrowed to the far ends of edges drawn from the same place when any are.
 */
export declare function renamed(previous: WiringResult, next: WiringResult, lost: (name: string) => boolean): {
    was: string[];
    now: string[];
};
/**
 * The wiring to emit: this run's, except that a re-extracted doc whose new
 * answer breaks a flow step keeps its previous one. `probe` resolves a wiring
 * against the rest of the graph without logging.
 */
export declare function keepFlowsResolving(wire: WiringStageResult, probe: (w: WiringStageResult) => Promise<Probe>, log: (msg: string) => void): Promise<{
    wire: WiringStageResult;
    held: Held[];
}>;
