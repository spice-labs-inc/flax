export interface ComparedFile {
    filename: string;
    status: string;
    patch?: string;
}
/**
 * Drift that cannot change what a doc says: in a repo listed under
 * docs.driftNoise, only files matching its `paths` patterns, plus files under
 * `imagePinsIn` whose every changed line is an image: pin. Anything else, an
 * unknown repository or a missing comparison is real.
 */
export declare function isNoise(repo: string, files: ComparedFile[] | undefined): boolean;
/** The head sha of a repository's default branch, or undefined. */
export declare function headOf(repo: string): string | undefined;
export declare function compare(repo: string, base: string, head: string): ComparedFile[] | undefined;
export interface DriftLine {
    name: string;
    analyzed: string;
    head: string;
    noise: boolean;
}
/** The GitHub reads drift needs; a test passes fakes. */
export interface DriftApi {
    headOf: typeof headOf;
    compare: typeof compare;
}
export declare function findDrift(root: string, classify: boolean, api?: DriftApi): {
    drifted: DriftLine[];
    unresolved: string[];
};
export declare function cmdDrift(root: string, o: {
    log: (s: string) => void;
    noise: boolean;
}): number;
