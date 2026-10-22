import { type Doc } from './doc.ts';
/** Alias and tombstone docs: rename redirects that never carry their own edges (docs.symmetryExempt). */
export declare const SYMMETRY_EXEMPT: () => string[];
export declare function asymmetries(docs: Doc[]): string[];
export declare function generatedUsedBy(docs: Doc[]): Map<string, string[]>;
export interface UsedByChange {
    doc: Doc;
    line: string;
    added: string[];
    /** Names dropped: docs whose depends_on does not name this doc, or names that are not docs. */
    dropped: string[];
    notesDropped: number;
}
export declare function usedByChanges(docs: Doc[]): UsedByChange[];
/** The doc text with its used_by entry replaced (or added after depends_on). */
export declare function applyUsedBy(d: Doc, line: string): string;
