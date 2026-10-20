import type { GraphNode } from '../model/types.ts';
export interface SubjectMap {
    explicit: Map<string, string>;
    ignored: (name: string) => boolean;
}
/**
 * Parse subjects.md. Fenced blocks are examples, not data — the file documents
 * its own format, and reading the samples as real entries would silently seed
 * mappings nobody wrote.
 */
export declare function readSubjectMap(vizRoot: string): SubjectMap;
/**
 * Which component a tag is, or undefined when nothing says. A tag named exactly
 * like a component id or label matches automatically, so subjects.md only ever
 * has to carry the exceptions.
 */
export declare function componentForSubject(subject: string, map: SubjectMap, byId: Map<string, GraphNode>, byLabel: Map<string, string>): string | undefined;
/** Every curated target must name a real node; a typo silently drops a component. */
export declare function assertTargetsExist(map: SubjectMap, byId: Map<string, GraphNode>): void;
