export type Level = "info" | "warn" | "error";
export type Log = (level: Level, msg: string) => void;
/** One JSON line per event on stdout; routine events are info, a degraded path warn, and only a broken service error. */
export declare const jsonLog: Log;
