/** A setting from the environment, or from the file `<name>_FILE` names, as Docker secrets are mounted. */
export declare function setting(env: NodeJS.ProcessEnv, k: string): string;
