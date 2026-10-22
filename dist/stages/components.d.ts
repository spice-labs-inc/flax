import type { GraphNode, Plane } from '../model/types.ts';
import type { Stage } from '../pipeline/machine.ts';
export declare const planeFor: (doc: {
    name: string;
    fm: Record<string, any>;
}) => Plane;
export declare const visibility: Stage;
export interface ComponentIndex {
    nodes: GraphNode[];
    /** component id -> owning repo */
    ownerOf: Record<string, string>;
    /** repo name -> its component ids */
    componentsOf: Record<string, string[]>;
}
export declare const components: Stage;
export declare const buildEdges: Stage;
