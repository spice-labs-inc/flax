/** The stable section ids, in template order (docs.sections in the atlas config). */
export declare const SECTION_IDS: () => readonly string[];
/** Sections that may live in a section file (every section but docs.mainOnly). */
export declare const SECTION_FILE_IDS: () => readonly string[];
export declare const POINTER_RE: RegExp;
export declare function pointerLine(name: string, section: string): string;
/** Reads atlas files by repo-relative path, from the working tree or from a commit. */
export interface FileSource {
    read(rel: string): string | undefined;
    /** File names (not paths) directly inside a directory; [] when it does not exist. */
    list(relDir: string): string[];
}
export declare function fsSource(root: string): FileSource;
export declare function gitSource(root: string, commit: string): FileSource;
export interface FrontEntry {
    key: string;
    /** The entry's full source text (one line, or several for a multi-line list). */
    raw: string;
    value: string | string[];
}
export interface Section {
    id: string;
    /** Offsets into the main doc text: heading line start, body start, section end. */
    start: number;
    bodyStart: number;
    end: number;
    /** Untrimmed body as it stands in the main doc. */
    body: string;
}
export interface SectionFile {
    id: string;
    file: string;
    text: string;
    /** The text after the `# ` title line, without the "Moved verbatim" boilerplate line. */
    body: string;
}
export interface Doc {
    name: string;
    file: string;
    text: string;
    fm: Record<string, string | string[]>;
    front: FrontEntry[];
    /** Offset just past the closing `---` line of the frontmatter (0 when there is none). */
    frontEnd: number;
    h1: string;
    sections: Section[];
    sectionFiles: Record<string, SectionFile>;
    /** Other files under repos/<name>/ (history.md and anything that is not a section file). */
    otherFiles: string[];
}
/** Splits on commas outside parentheses, brackets and quotes. */
export declare function splitTopLevel(s: string): string[];
/** The repo name an entry like `notes-core (event schema)` refers to. */
export declare function entryName(entry: string): string;
export declare function parseFrontmatter(text: string): {
    front: FrontEntry[];
    end: number;
};
/** Splits a markdown text into `## ` sections (headings inside code fences are ignored). */
export declare function splitSections(text: string, from?: number): Section[];
/** Trimmed section bodies keyed by heading, as the map has always read them. */
export declare function parseSections(text: string): Record<string, string>;
export declare function sectionFileBody(text: string): string;
export declare function parseDoc(name: string, file: string, text: string, src?: FileSource): Doc;
export declare function docNames(src: FileSource): string[];
export declare function readDoc(src: FileSource, name: string): Doc | undefined;
export declare function readDocs(src: FileSource, only?: string[]): Doc[];
export declare function section(doc: Doc, id: string): Section | undefined;
/** The main doc's part of a section: everything before the outline pointer (all of it when there is none). */
export declare function sectionHead(body: string): {
    head: string;
    hasPointer: boolean;
};
/**
 * The whole of a section: the main doc's text before the outline pointer followed by
 * the section file body when the section lives in a file, else the main doc's body.
 */
export declare function fullSection(doc: Doc, id: string): string | undefined;
export declare function fullSections(doc: Doc): Record<string, string>;
/** Frontmatter list as repo names (parenthesised notes dropped). */
export declare function names(doc: Doc, key: string): string[];
/** The H1 one-liner after the doc name: `# notes-api: the HTTP API` gives `the HTTP API`. */
export declare function h1Role(doc: Doc): string;
