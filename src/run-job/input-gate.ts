import { byCodePoint } from "../lib/sort.ts";
import type { ToolResult } from "../tools-server/server.ts";

/** Whether the model saw text anyone can write, and through which tools. */
export interface UntrustedInputRecord {
  seen: boolean;
  /** Tools the model called that returned untrusted text. */
  model: string[];
  /** Tools collect.ts called that returned untrusted text, which may have reached the model through the input. */
  collect: string[];
}

/** The tools, each once and sorted, that returned a result tagged untrusted. */
export function untrustedTools(results: readonly ToolResult[]): string[] {
  return [
    ...new Set(
      results.filter((r) => r.source === "untrusted").map((r) => r.tool),
    ),
  ].sort(byCodePoint);
}

export function untrustedInput(
  model: readonly string[],
  collect: readonly string[],
): UntrustedInputRecord {
  return {
    seen: model.length > 0 || collect.length > 0,
    model: [...model],
    collect: [...collect],
  };
}

/** Every tool whose untrusted text the model may have seen, for messages. */
export function untrustedToolList(record: UntrustedInputRecord): string[] {
  return [...new Set([...record.model, ...record.collect])].sort(byCodePoint);
}
