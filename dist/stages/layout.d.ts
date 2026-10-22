import type { GraphEdge, GraphNode } from '../model/types.ts';
import type { Stage } from '../pipeline/machine.ts';
/**
 * Put each delivery target in a place of its own, in a row over the top of the
 * map.
 *
 * The simulation pulls every target into the delivery plane, where they sat in
 * a knot with ghcr, app-gitops and the action repos and their names were lost.
 * Like the placed planes, the simulation does not get the last word. The row
 * runs across the map as the default camera sees it (x across, y up), clear of
 * every plane's shell, centered over the delivery plane, and each target takes
 * the slot nearest the things that ship to it, so their edges cross each other
 * as little as an order can manage. Positions are in the normalized units the
 * viewer draws in, and shells are sized the way the viewer sizes them.
 */
export declare function placeTargets(nodes: GraphNode[], edges: GraphEdge[], positions: Record<string, [number, number, number]>): number;
export declare const layout: Stage;
