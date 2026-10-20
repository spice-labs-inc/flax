export type UnitKind = 'bullet' | 'row' | 'heading' | 'para' | 'fence';
export interface Unit {
    kind: UnitKind;
    /** 1-based line number of the unit's first line, relative to the text given. */
    line: number;
    lines: string[];
}
export declare const bytes: (s: string) => number;
export declare const chars: (s: string) => number;
/**
 * Top-level units of a markdown body: a bullet with its continuation and nested
 * bullets, a table row, a heading, a paragraph or a fenced block. A table under a
 * bullet is not part of the bullet: each row is its own unit.
 */
export declare function units(text: string): Unit[];
export declare const unitText: (u: Unit) => string;
export interface Block {
    id: string;
    /** Offsets: start of the BEGIN line, start of the content, start of the END line, end of the END line. */
    begin: number;
    contentStart: number;
    contentEnd: number;
    end: number;
}
/** Generated blocks: `<!-- BEGIN GENERATED <id> ... -->` ... `<!-- END GENERATED <id> -->`. */
export declare function findBlocks(text: string): Block[];
export declare function blockContent(text: string, b: Block): string;
export declare function beginMarker(id: string, how: string): string;
export declare function endMarker(id: string): string;
/** Replaces a block's content; the content gets exactly one trailing newline. */
export declare function replaceBlock(text: string, b: Block, content: string): string;
export declare function renderTable(header: string[], rows: string[][]): string;
/** A short unified-style summary of how two texts differ, for --check output. */
export declare function diffSummary(before: string, after: string, max?: number): string[];
