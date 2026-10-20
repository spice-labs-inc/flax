import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Whether an Authorization header carries this bearer token, compared in constant time. */
export function bearerMatches(
  header: string | undefined,
  token: string,
): boolean {
  if (!header || token.length === 0) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return timingSafeEqual(digest(m?.[1] ?? ""), digest(token)) && m !== null;
}
