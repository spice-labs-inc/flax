import { type UsageHistory, type UsageLive, type UsageWindow } from "@flax/contract";
export declare const LIVE_KEEP_MS: number;
interface Window {
    from: number;
    to: number;
}
/** Windows that do not overlap, newest first: each next one ends where the one before it starts, or earlier. */
export declare function disjointWindows(windows: Window[]): Set<number>;
/**
 * Use from a workspace's usage relay, in memory and under `<state>/usage/`: each live window's rows for
 * 24 hours, and the newest history per env, which the data build reads.
 */
export declare class UsageStore {
    #private;
    constructor(dir: string, envs: readonly string[], now: number);
    get envs(): readonly string[];
    historyPath(env: string): string;
    /** One window's rows replace whatever an earlier delivery of the same window gave. */
    ingestWindow(body: UsageWindow, now: number): UsageLive;
    ingestHistory(body: UsageHistory): void;
    /** The newest history an env has, or undefined before the first delivery. */
    history(env: string): UsageHistory | undefined;
    /** Per item and class over the last 24 hours: distinct organizations, requests counted once each, and the newest request. */
    summary(env: string, now: number): UsageLive;
}
export {};
