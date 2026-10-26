import type { Log } from "./log.ts";
export interface Manifest {
    version: string;
    builtAt: string;
    commit: string;
}
export declare function readManifest(dataDir: string): Manifest | undefined;
/**
 * Builds the data files into `<data>/<version>/`, then swaps `<data>/manifest.json` to name it, so a page never reads
 * a half-written set. One build at a time; requests while one runs fold into one more build after it.
 */
export declare class Rebuilder {
    #private;
    constructor(options: {
        dataDir: string;
        commit: string;
        build: (outDir: string, now: string) => Promise<void>;
        log: Log;
        onData: (m: Manifest) => void;
        keep?: number;
    });
    /** Resolves once a build that started after this call has finished. */
    request(why: string): Promise<void>;
}
