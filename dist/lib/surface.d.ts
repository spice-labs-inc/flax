import type { Checkout } from "./repo.ts";
import { type Env, type OutOfScope, type Sighting, type Source, type SurfaceFile, type SurfaceItem, type SurfaceName } from "./types.ts";
export interface BuildContext {
    /** Environments this run reads; builders for env-independent surfaces ignore it. */
    envs: Env[];
    now: () => string;
    checkout: (repo: string, ref?: string) => Promise<Checkout>;
    log: (msg: string) => void;
    /** Another surface's items as last built, for a builder that links to them; undefined when it has none. */
    items?: (surface: SurfaceName) => Promise<SurfaceItem[] | undefined>;
}
export interface Builder {
    surface: SurfaceName;
    build: (ctx: BuildContext) => Promise<SurfaceFile>;
}
export declare function repoSource(co: Checkout, path?: string): Source;
export declare function urlSource(url: string): Source;
export declare function sighting(source: Source, readAt: string, env?: Env): Sighting;
/**
 * Combines readings of the same item (e.g. one API operation read from three envs) into one item.
 * Label, area and details come whole from one reading: the first env in the config, else the next, else an
 * env-less one (the first of equals). `envs` and `seen` are unions; env-less sightings sort first.
 */
export declare function mergeItems(items: SurfaceItem[]): SurfaceItem[];
/**
 * Where coverage of an item is required: every env, minus each env whose source was read and
 * lacks the item. `lacks` holds an entry only for envs read successfully, so envs that failed or
 * were not read this run keep the requirement.
 */
export declare function requiredEnvs(id: string, lacks: Map<Env, (id: string) => boolean>): Env[];
export declare function surfaceFile(surface: SurfaceName, builtAt: string, parts: {
    sources: Sighting[];
    items: SurfaceItem[];
    outOfScope?: OutOfScope[];
    notes?: string[];
}): SurfaceFile;
export declare function writeJson(path: string, value: unknown): Promise<void>;
