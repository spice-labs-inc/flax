export { isRecord } from "@flax/contract";
import { envNames, surfaceNames } from "../config.js";
/** The environments in config order: display order and merge precedence; the first is the reference env and its reading wins a merge. */
export const ENVS = envNames();
export const SURFACES = surfaceNames();
//# sourceMappingURL=types.js.map