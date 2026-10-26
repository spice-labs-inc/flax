import type { CadenceConfig, ScenariosConfig } from "@flax/contract/config";
import type { Env } from "../lib/types.ts";
/**
 * Never planned scenarios, never local ones, never the tags the env's policy excludes (unless the scenario
 * carries one of the env's allowTags), fixture and workflow-dispatch scenarios only when asked, and a
 * scenario tagged with environments runs only there. A run for a cadence takes only the scenarios with its
 * tag; any other run leaves out every cadence's, except a record or capture run, which films or captures the
 * scenarios it selects whatever cadence checks them.
 */
export declare function tagExpression(env: Env, extra?: string, fixtures?: boolean, dispatch?: boolean, cadence?: string, c?: ScenariosConfig, record?: boolean): string;
/** The configured cadence by name, or an error that lists the names flax.yml gives. */
export declare function cadenceNamed(name: string, c?: ScenariosConfig): CadenceConfig;
/** Whether a run on this cadence runs in this env. */
export declare const cadenceRunsIn: (k: CadenceConfig, env: Env) => boolean;
/** What is wrong with `--cadence <name>` for a run in this env, if anything. */
export declare function cadenceProblem(name: string, env: Env, c?: ScenariosConfig): string | undefined;
/**
 * Why a scheduled run leaves a scenario with these tags out of an env: pinned to other envs (by its own tags or
 * by the envs its cadence runs in), a tag the env excludes and no tag it allows, a fixture where fixtures never
 * run, or a cadence whose own runs take it there.
 */
export type LeftOut = {
    kind: "pinned";
    envs: Env[];
} | {
    kind: "excluded";
    tag: string;
} | {
    kind: "fixture";
} | {
    kind: "cadence";
    cadence: string;
};
export declare function leftOutBy(tags: string[], env: Env, envRunsFixtures: boolean, c?: ScenariosConfig): LeftOut | undefined;
/** The envs some scheduled run runs a scenario with these tags in, its cadence's runs included. */
export declare function envsForTags(tags: string[], runsFixtures: (env: Env) => boolean, c?: ScenariosConfig): Env[];
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
