export { SCENARIO_STATUSES } from "@flax/contract";
import { config } from "../config.js";
/** The media type of the touches attachment; configurable, with the original string as the default so old messages.ndjson files still read. */
export function touchesMediaType() {
    return config().touchesMediaType;
}
//# sourceMappingURL=results.js.map