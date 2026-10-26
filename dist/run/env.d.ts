import type { RecordPlan } from "../record/plan.ts";
import { type Env } from "../lib/types.ts";
/** The environment this run targets, as the runner set it. */
export declare function currentEnv(): Env;
/** The run id the runner set, or a local one. */
export declare function currentRunId(): string;
/** Environments where a run may create fixtures. */
export declare function fixtureEnvNames(): readonly Env[];
/** Whether this run was started with --fixtures. */
export declare function fixturesAllowed(): boolean;
/** Which of a parallel run's workers this is ("0", "1", ...); undefined when the run is not parallel. */
export declare function workerId(): string | undefined;
/** The plan of a `run --record` run, read once; undefined in any other run. */
export declare function currentRecordPlan(): RecordPlan | undefined;
/** The directory a `run --capture` run writes its screenshots to; undefined in any other run. */
export declare function currentCaptureDir(): string | undefined;
