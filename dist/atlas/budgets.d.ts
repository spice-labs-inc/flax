export declare const BUDGET: () => {
    line: number;
    bullet: number;
    doc: number;
    section: number;
    sectionFile: number;
    tldr: number;
    h1Role: number;
    recent: number;
    index: number;
    glossaryEntry: number;
    glossary: number;
    gapsEntry: number;
};
export type Level = 'FAIL' | 'WARN';
export interface Finding {
    level: Level;
    code: string;
    file: string;
    line?: number;
    detail: string;
}
export declare const VOLATILE: [string, RegExp][];
/** Fast-moving tokens in one line: versions, dates, PR numbers, schedules, live/shadow status. */
export declare function volatileTokens(line: string): string[];
export declare function checkBudgets(root: string): Finding[];
export declare function printFindings(findings: Finding[], log: (s: string) => void): {
    fail: number;
    warn: number;
    byCode: Record<string, number>;
};
