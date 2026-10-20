import { type Workspace } from "@flax/core";
import type { EnvConfig, ScenariosConfig, SurfaceConfig } from "@flax/contract/config";
/** Names the workspace directory (the one holding flax.yml) when the command does not run in it. */
export declare const WORKSPACE_VARIABLE = "FLAX_WORKSPACE";
/**
 * The scenarios configuration of a workspace: the shared keys of flax.yml (org, github, environments)
 * plus its `scenarios:` section, with every omitted value filled in. The `explorer:` section lends
 * its title and description, which the coverage report and the page both show.
 */
export declare function fromWorkspace(ws: Workspace): ScenariosConfig;
/** The configuration a flax.yml text gives, for tests and tools that hold the file in memory. */
export declare function parseConfig(text: string, dir?: string): ScenariosConfig;
/** The workspace directory: FLAX_WORKSPACE when set, else the current directory. */
export declare function workspaceRoot(): string;
export declare function loadConfig(dir?: string): ScenariosConfig;
/** The config, read once per process. */
export declare function config(): ScenariosConfig;
/** For tests: use this config instead of a file. */
export declare function setConfig(c: ScenariosConfig | undefined): void;
export declare function envNames(c?: ScenariosConfig): Env[];
export declare function surfaceNames(c?: ScenariosConfig): string[];
/** The reference env: the first one. */
export declare function referenceEnv(c?: ScenariosConfig): Env;
export declare function envConfig(env: Env, c?: ScenariosConfig): EnvConfig;
export declare function surfaceConfig(name: string, c?: ScenariosConfig): SurfaceConfig | undefined;
/** Envs where a run may create fixtures. */
export declare function fixtureEnvs(c?: ScenariosConfig): Env[];
/** The env-var names the runner hands the steps. */
export declare function envVariables(c?: ScenariosConfig): {
    env: string;
    runId: string;
    fixtures: string;
};
type Env = string;
export {};
