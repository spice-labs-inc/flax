export type {
  Env,
  OutOfScope,
  Sighting,
  Source,
  SurfaceFile,
  SurfaceItem,
  SurfaceName,
} from "@flax/contract";
export { isRecord } from "@flax/contract";
import { envNames, surfaceNames } from "../config.ts";

/** The environments in config order: display order and merge precedence; the first is the reference env and its reading wins a merge. */
export const ENVS: readonly string[] = envNames();
export const SURFACES: readonly string[] = surfaceNames();
