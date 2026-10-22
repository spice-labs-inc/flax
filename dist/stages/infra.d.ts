import type { GraphEdge, GraphNode } from '../model/types.ts';
import type { Stage } from '../pipeline/machine.ts';
export interface InfraResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    /** machine id -> components the MACHINES.md prose says it runs. Cross-check only. */
    machineRuns: Record<string, string[]>;
}
/**
 * The delivery outlets a repo doc's `type` and `deploy` frontmatter name, with
 * the edge label each one gets. Read from the atlas, never inferred from code.
 */
export declare function outletsOf(type: string, deploy: string): Array<{
    id: string;
    label: string;
}>;
export declare const infra: Stage;
