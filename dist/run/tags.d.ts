import { type Env } from "../lib/types.ts";
/**
 * Never planned scenarios, never local ones, never the tags the env's policy excludes, fixture and
 * workflow-dispatch scenarios only when asked, and a scenario tagged with environments runs only there.
 */
export declare function tagExpression(env: Env, extra?: string, fixtures?: boolean, dispatch?: boolean): string;
/** Why a scheduled run leaves a scenario with these tags out of an env: pinned to other envs, a tag the env excludes, or a fixture where fixtures never run. One copy; was seven. */
export type LeftOut = {
    kind: "pinned";
    envs: Env[];
} | {
    kind: "excluded";
    tag: string;
} | {
    kind: "fixture";
};
export declare function leftOutBy(tags: string[], env: Env, envRunsFixtures: boolean): LeftOut | undefined;
/** The envs a scheduled run runs a scenario with these tags in. */
export declare function envsForTags(tags: string[], runsFixtures: (env: Env) => boolean): Env[];
/** Scenarios with any of these tags never run at the same time as each other in a parallel run. */
export declare const SERIAL_TAGS: readonly ["@serial", "@dispatch"];
/** cucumber's parallelCanAssign: a serial scenario waits while another serial one runs; the rest run whenever a worker is free. */
export declare function canRunAlongside(pickle: {
    tags: readonly {
        name: string;
    }[];
}, running: readonly {
    tags: readonly {
        name: string;
    }[];
}[]): boolean;
