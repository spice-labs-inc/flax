import { isScenarioId as scenarioId, runIdPattern } from "@flax/contract";
import { config } from "@flax/scenarios/config";
import { ENVS } from "@flax/scenarios/lib/types";
const RUN_ID = runIdPattern(ENVS);
/** The env of a run id in the runner's `<env>-<ISO time>` shape, or undefined for anything else. */
export function runIdEnv(id) {
    const m = RUN_ID.exec(id);
    return ENVS.find((e) => e === m?.[1]);
}
/** A scenario id: `<features dir>/<surface>/...feature:<line>`. */
export function isScenarioId(id) {
    return scenarioId(id, config().paths.features);
}
//# sourceMappingURL=ids.js.map