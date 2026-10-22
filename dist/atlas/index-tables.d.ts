import { type Doc } from './doc.ts';
export interface Plane {
    id: string;
    /** The INDEX heading the plane's table sits under. */
    heading: string;
}
/** The index planes of the atlas config (planes[] with index: true), in config order. */
export declare const PLANES: () => Plane[];
/** A row's role is the H1 one-liner, cut near this many characters (the doc holds the rest). */
export declare const ROLE_MAX = 72;
/** The plane each doc sits under in the INDEX as it stands (first table or list it is linked from). */
export declare function planesFromIndex(index: string): Map<string, string>;
export declare function planeOf(doc: Doc): string | undefined;
export declare function renderPlane(plane: Plane, docs: Doc[], planeFor: (d: Doc) => string | undefined): string;
export interface IndexResult {
    text: string;
    /** Planes whose block was missing and was put in place of the old table or list. */
    bootstrapped: string[];
    /** Docs without a `plane:` field (their plane came from where the INDEX links them today). */
    missingPlane: string[];
    /** Docs no table rows at all. */
    unplaced: string[];
    unknownPlane: string[];
    rows: Record<string, number>;
}
/**
 * The INDEX with every plane block regenerated. A plane without its marker block yet
 * gets one in place of the table or link list under its heading (other prose stays).
 */
export declare function generateIndex(index: string, docs: Doc[], fallback: Map<string, string>): IndexResult;
/** The doc text with `plane: <id>` added after `status:` (frontmatter). */
export declare function withPlane(d: Doc, plane: string): string;
