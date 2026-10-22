import { workspaceRoot } from "../lib/workspace.ts";
import { join } from "node:path";
import { KIT_ROOT } from "../lib/paths.ts";

/** Where progress lines go. */
export type Log = (line: string) => void;

/** The library's own files (brand assets, scenarios), from source or a bundle. */
// The media root is workspace content (brand, scenarios, fixtures), not the kit's.
export const MEDIA_ROOT = join(workspaceRoot(), "src/media");

export { fetchRetry, sleep } from "@flax/core/http";

/** The first line of an error's message. */
export function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
}

/** The named variables of this process's environment that are set, for a child process. */
export function passEnv(names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = process.env[name];
    if (v !== undefined && v !== "") out[name] = v;
  }
  return out;
}
