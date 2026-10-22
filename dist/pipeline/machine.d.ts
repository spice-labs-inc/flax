export type StageKind = 'code' | 'ai';
export interface Ctx {
    /** Absolute path of the atlas repo root. */
    atlasRoot: string;
    /** Absolute path of viz/. */
    vizRoot: string;
    /** Accumulated stage outputs, keyed by stage id. */
    out: Record<string, any>;
    /** Only process these repo names (debug aid). */
    only?: string[];
    /** Reuse a previous answer when only the prompt hash changed. */
    reuseStale?: boolean;
    /** With reuseStale: still re-extract a doc whose own wiring sections changed since its answer was made. */
    reextractChanged?: boolean;
    /** At most this many docs may call the model in one run; no limit when not set. */
    maxExtractions?: number;
    /** Ignore the cache and re-run every AI call. */
    noCache?: boolean;
    log: (msg: string) => void;
}
export interface Stage {
    id: string;
    kind: StageKind;
    title: string;
    run: (ctx: Ctx) => Promise<any>;
}
export declare function sha(input: string): string;
export declare class Cache {
    dir: string;
    enabled: boolean;
    constructor(dir: string, enabled: boolean);
    private path;
    get<T>(key: string): T | undefined;
    /**
     * The newest cached answer for `key` under any prompt hash.
     *
     * A wiring key hashes the doc's own wiring sections, so an edit to the doc
     * misses the cache. That is correct for a run allowed to call a model and
     * wrong for the daily data refresh, which only needs the advisory dates moved
     * and must never call one.
     */
    getStale<T>(key: string): {
        key: string;
        value: T;
    } | undefined;
    set(key: string, value: unknown): void;
}
export declare function runPipeline(stages: Stage[], ctx: Ctx): Promise<Ctx>;
/** Bounded-concurrency map, so AI stages fan out without flooding the API. */
export declare function pmap<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
