import { readFileSync } from "node:fs";
import { config, envVariables, fixtureEnvs } from "../config.js";
import { ENVS } from "../lib/types.js";
/** The environment this run targets, as the runner set it. */
export function currentEnv() {
    const variable = envVariables().env;
    const name = process.env[variable];
    const env = ENVS.find((e) => e === name);
    if (!env)
        throw new Error(`${variable} must be one of ${ENVS.join(", ")}`);
    return env;
}
/** The run id the runner set, or a local one. */
export function currentRunId() {
    return process.env[envVariables().runId] ?? `local-${Date.now()}`;
}
/** Environments where a run may create fixtures. */
export function fixtureEnvNames() {
    return fixtureEnvs(config());
}
/** Whether this run was started with --fixtures. */
export function fixturesAllowed() {
    return process.env[envVariables().fixtures] === "1";
}
/** Which of a parallel run's workers this is ("0", "1", ...); undefined when the run is not parallel. */
export function workerId() {
    return process.env["CUCUMBER_WORKER_ID"];
}
let plan;
/** The plan of a `run --record` run, read once; undefined in any other run. */
export function currentRecordPlan() {
    const file = process.env[envVariables().record];
    if (!file)
        return undefined;
    if (plan?.file !== file)
        plan = { file, plan: JSON.parse(readFileSync(file, "utf8")) };
    return plan.plan;
}
/** The directory a `run --capture` run writes its screenshots to; undefined in any other run. */
export function currentCaptureDir() {
    return process.env[envVariables().capture] || undefined;
}
//# sourceMappingURL=env.js.map