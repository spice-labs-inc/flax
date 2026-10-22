import { type Doc } from './doc.ts';
/** One outline line: the unit's first line, em-dashes made colons, cut at a word near 150 characters. */
export declare function clip(text: string, max?: number): string;
export declare function outlineBullets(body: string): string[];
export interface OutlineChange {
    doc: Doc;
    id: string;
    before: string;
    after: string;
}
/** The section body (text after the heading line) the main doc should carry. */
export declare function outlineBody(doc: Doc, id: string): string;
export declare function outlineChanges(doc: Doc): OutlineChange[];
export declare function applyOutlines(doc: Doc): string;
