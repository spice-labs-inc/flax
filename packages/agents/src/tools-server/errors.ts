import { firstLine } from "../lib/problem.ts";

interface ErrorLike {
  message?: unknown;
  code?: unknown;
  cause?: unknown;
  /** Set by WebSocket error events, which carry the real error inside. */
  error?: unknown;
}

/**
 * One line describing an error and the causes under it, each with its code
 * where it has one: "fetch failed; cause: ECONNRESET other side closed".
 * fetch() and WebSocket errors put what went wrong in the cause, so the
 * first message alone rarely says it.
 */
export function errorChain(err: unknown, maxDepth = 5): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (parts.length >= maxDepth) break;
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    const e = current as ErrorLike;
    const message =
      typeof e.message === "string" ? firstLine(e.message) : firstLine(current);
    const code =
      typeof e.code === "string" || typeof e.code === "number"
        ? String(e.code)
        : "";
    const part =
      code !== "" && !message.includes(code) ? `${code} ${message}` : message;
    if (part !== "" && part !== parts.at(-1)) parts.push(part);
    current = e.cause ?? e.error;
  }
  return parts.join("; cause: ");
}
