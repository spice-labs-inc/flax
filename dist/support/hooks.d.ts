/**
 * The base hooks: step tracking, the touches attachment, the shared browser. A workspace imports this
 * module from its own support file and adds its hooks (fixture teardown, env guards) beside it.
 */
export declare function installBaseHooks(options?: {
    timeoutMs?: number;
}): void;
