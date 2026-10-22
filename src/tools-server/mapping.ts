import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReadChannel } from "../lib/allowlists.ts";
import { REBUILD_DIST, toolFile } from "../lib/paths.ts";
import { firstLine } from "../lib/problem.ts";

/** What a tool asks its upstream for: one operation and its arguments. */
export interface UpstreamCall {
  operation: string;
  arguments: Record<string, unknown>;
}

/** What a mapping may consult besides the arguments. */
export interface MapContext {
  /** The time of the call, for checking and forcing time ranges. */
  now: Date;
  /** The Slack channels tools may read, from channels.yml. */
  readChannels: readonly ReadChannel[];
  /** The commit a job pins each organization repository's files to (pin_files), by repository name. */
  commits: ReadonlyMap<string, string>;
}

/**
 * The code half of a tool, tools/<name>/map.ts. It gets arguments that
 * already match tool.yml and turns them into one upstream call, adding the
 * checks a schema cannot express and forcing values the model must not
 * choose. To refuse a call it throws a ToolRefusal, whose message the model
 * sees. The optional result step trims the upstream's text, for limits an
 * upstream cannot apply itself; it runs before scrubbing and the byte cap.
 */
export interface ToolMapping {
  map(args: Record<string, unknown>, context: MapContext): UpstreamCall;
  result?(text: string, args: Record<string, unknown>): string;
}

export class ToolRefusal extends Error {
  override name = "ToolRefusal";
}

let bundled: ReadonlyMap<string, { default?: unknown }> | undefined;

/**
 * The bundled runner hands over the modules of every tools/<name>/map.ts it
 * was built with; loadMapping then imports nothing from the tree.
 * Undefined goes back to importing.
 */
export function useBundledMappings(
  modules: Record<string, { default?: unknown }> | undefined,
): void {
  bundled =
    modules === undefined ? undefined : new Map(Object.entries(modules));
}

/** Imports tools/<name>/map.ts and checks that it exports a mapping; errors do not repeat the file name. */
export async function loadMapping(
  root: string,
  name: string,
): Promise<ToolMapping> {
  const file = toolFile(name, "map.ts");
  let mod: { default?: unknown };
  try {
    if (bundled === undefined)
      mod = (await import(pathToFileURL(join(root, file)).href)) as {
        default?: unknown;
      };
    else {
      const found = bundled.get(name);
      if (found === undefined)
        throw new Error(`it is not in the runner bundle; ${REBUILD_DIST}`);
      mod = found;
    }
  } catch (err) {
    throw new Error(`cannot be loaded: ${firstLine(err)}`);
  }
  const mapping = mod.default as Partial<ToolMapping> | undefined;
  if (
    typeof mapping !== "object" ||
    typeof mapping.map !== "function" ||
    !(mapping.result === undefined || typeof mapping.result === "function")
  )
    throw new Error(
      "must export default { map(args, context) { ... } }, with result(text, args) optional",
    );
  return mapping as ToolMapping;
}
