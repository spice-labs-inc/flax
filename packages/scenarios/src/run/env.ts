import { config, envVariables, fixtureEnvs } from "../config.ts";
import { ENVS, type Env } from "../lib/types.ts";

/** The environment this run targets, as the runner set it. */
export function currentEnv(): Env {
  const variable = envVariables().env;
  const name = process.env[variable];
  const env = ENVS.find((e) => e === name);
  if (!env) throw new Error(`${variable} must be one of ${ENVS.join(", ")}`);
  return env;
}

/** The run id the runner set, or a local one. */
export function currentRunId(): string {
  return process.env[envVariables().runId] ?? `local-${Date.now()}`;
}

/** Environments where a run may create fixtures. */
export function fixtureEnvNames(): readonly Env[] {
  return fixtureEnvs(config());
}

/** Whether this run was started with --fixtures. */
export function fixturesAllowed(): boolean {
  return process.env[envVariables().fixtures] === "1";
}

/** Which of a parallel run's workers this is ("0", "1", ...); undefined when the run is not parallel. */
export function workerId(): string | undefined {
  return process.env["CUCUMBER_WORKER_ID"];
}
