import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function sendFile(
  res: ServerResponse,
  file: string,
  cacheControl: string,
): void {
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": statSync(file).size,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
  });
  createReadStream(file).pipe(res);
}

function fileUnder(root: string, path: string): string | undefined {
  const clean = normalize(decodeURIComponent(path));
  if (clean.includes("..")) return undefined;
  const file = join(root, clean);
  return existsSync(file) && statSync(file).isFile() ? file : undefined;
}

/**
 * The same files a Caddy in front of the service would serve: `/data/*` from the data directory
 * (versioned sets immutable, the manifest never cached) and the built page from the site directory,
 * every other path falling back to its index.html. Handled when `serve` runs the service alone.
 */
export function serveStatic(
  dirs: { data: string; site?: string | undefined },
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (pathname.startsWith("/data/")) {
    const file = fileUnder(dirs.data, pathname.slice("/data".length));
    if (!file) return false;
    sendFile(
      res,
      file,
      /^\/data\/v\d/.test(pathname)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
    return true;
  }
  if (!dirs.site) return false;
  const file =
    fileUnder(dirs.site, pathname) ??
    (extname(pathname) ? undefined : join(dirs.site, "index.html"));
  if (!file || !existsSync(file)) return false;
  sendFile(
    res,
    file,
    pathname.startsWith("/_app/immutable/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  );
  return true;
}
