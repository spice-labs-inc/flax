export type { Env, OutOfScope, Sighting, Source, SurfaceFile, SurfaceItem, SurfaceName, } from "@flax/contract";
export { isRecord } from "@flax/contract";
/** The environments in config order: display order and merge precedence; the first is the reference env and its reading wins a merge. */
export declare const ENVS: readonly string[];
export declare const SURFACES: readonly string[];
