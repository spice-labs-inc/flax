export type Level = "info" | "warn" | "error";

export type Log = (level: Level, msg: string) => void;

/** One JSON line per event on stdout; routine events are info, a degraded path warn, and only a broken service error. */
export const jsonLog: Log = (level, msg) => {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level, msg })}\n`,
  );
};
