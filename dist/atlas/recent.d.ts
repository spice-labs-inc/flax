import { type Doc } from './doc.ts';
export declare const KEEP = 5;
export interface MergedPr {
    number: number;
    mergedAt: string;
    sha: string;
    title: string;
    bot: boolean;
}
export declare const laDate: (iso: string) => string;
export declare function listMerged(repo: string, base: string): MergedPr[];
export interface RecentLine {
    raw: string;
    date?: string;
    pr?: number;
    mergeSha?: string;
    shas: string[];
    leftovers: string[];
    rest: string;
    /** The head (date, PR, shas) parsed cleanly, so the line can be rewritten. */
    clean: boolean;
}
export declare function parseLine(raw: string): RecentLine;
export declare const render: (date: string, pr: number, sha: string, leftovers: string[], rest: string) => string;
export interface RecentReport {
    doc: string;
    error?: string;
    wrongDate: string[];
    wrongSha: string[];
    missingSha: string[];
    unknownPr: string[];
    reformat: number;
    noPr: number;
    dropped: number;
    added: string[];
    before: string;
    after: string;
}
export declare function reviseRecent(doc: Doc, prs: MergedPr[]): RecentReport;
export declare function applyRecent(doc: Doc, after: string): string;
export declare function changed(rep: RecentReport): boolean;
