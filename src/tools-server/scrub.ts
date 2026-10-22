import { SECRET_PATTERNS } from "../check/secrets.ts";
import { redact } from "../run-job/report.ts";

export const REDACTED = "[redacted]";

// The last group may be shorter: Helm truncates long resource names, which cuts
// a project id short before appending its own hash.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{1,12}/gi;

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/g;

/** Shapes a result can carry that flax agents check's job-folder patterns do not look for. */
const RESULT_PATTERNS: readonly RegExp[] = [
  // JSON Web Tokens, which is what Kubernetes ServiceAccount tokens are.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // OpenObserve ingestion tokens.
  /\bo2oi_[A-Za-z0-9_-]{8,}/g,
];

// Credentials after an auth scheme, in headers or in error text that echoes one.
const AUTH_VALUE =
  /\b((?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?(?:basic|bearer|token)\s+)[A-Za-z0-9+/_.~=-]{8,}/gi;
const BARE_AUTH = /\b((?:basic|bearer)\s+)[A-Za-z0-9+/_.~-]{20,}={0,2}/gi;

// A signed URL (a GitHub log download, a cloud storage link) is as good as a
// credential until it expires; its query string is the signature.
const URL_WITH_QUERY = /(https?:\/\/[^\s"'<>?]+)\?([^\s"'<>]*)/gi;
const SIGNATURE_PARAMS = new Set([
  "sig",
  "signature",
  "x-amz-signature",
  "x-amz-credential",
  "x-goog-signature",
  "token",
  "jwt",
  "access_token",
]);

function isSigned(query: string): boolean {
  return query
    .split("&")
    .some((p) =>
      SIGNATURE_PARAMS.has(decodeParam(p.split("=")[0] ?? "").toLowerCase()),
    );
}

function decodeParam(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * Makes upstream text fit to show the model, as chicory does for its
 * reports: customer org, project and report ids (and every other UUID)
 * collapse to ":id", and secret-shaped strings, the known credential values
 * of the run and the query strings of signed URLs become "[redacted]".
 */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = redact(text, secrets).text;
  out = out.replace(PRIVATE_KEY_BLOCK, REDACTED);
  out = out.replace(URL_WITH_QUERY, (m, base: string, query: string) =>
    isSigned(query) ? `${base}?${REDACTED}` : m,
  );
  out = out.replace(AUTH_VALUE, `$1${REDACTED}`);
  out = out.replace(BARE_AUTH, `$1${REDACTED}`);
  for (const pattern of RESULT_PATTERNS) out = out.replace(pattern, REDACTED);
  for (const { pattern, accept } of SECRET_PATTERNS)
    out = out.replace(pattern, (m) =>
      accept === undefined || accept(m) ? REDACTED : m,
    );
  return out.replace(UUID, ":id");
}

/** A scrubber that also removes the given credential values, ignoring any too short to match safely. */
export function scrubber(secrets: readonly string[]): (text: string) => string {
  const known = secrets
    .filter((s) => s.length >= 8)
    .sort((a, b) => b.length - a.length);
  return (text) => scrub(text, known);
}
