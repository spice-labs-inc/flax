import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  assetUrl,
  isArchive,
  loadServerPins,
  SERVER_NAMES,
  type Platform,
  type ServerName,
} from "../lib/mcp-servers.ts";
import { formatProblem } from "../lib/problem.ts";

/** Larger than any release asset of either server. */
export const MAX_ASSET_BYTES = 256 * 1024 * 1024;

export function currentPlatform(): Platform {
  if (process.platform === "linux" && process.arch === "x64")
    return "linux-amd64";
  if (process.platform === "linux" && process.arch === "arm64")
    return "linux-arm64";
  throw new Error(
    `no pinned MCP server binaries for ${process.platform}/${process.arch}`,
  );
}

function octal(field: Buffer): number {
  const text = field.toString("latin1").replace(/\0.*$/s, "").trim();
  return text === "" ? 0 : parseInt(text, 8);
}

/** The contents of one regular file in a tar archive, by its path. */
export function extractFromTar(tar: Buffer, path: string): Buffer {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header
      .subarray(0, 100)
      .toString("latin1")
      .replace(/\0.*$/s, "");
    const prefix = header
      .subarray(345, 500)
      .toString("latin1")
      .replace(/\0.*$/s, "");
    const full = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, "");
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + 512;
    if (full === path && (type === "0" || type === "\0")) {
      if (start + size > tar.length) throw new Error(`${path} is cut short`);
      return Buffer.from(tar.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`the archive holds no file ${path}`);
}

async function download(url: string, fetchFn: typeof fetch): Promise<Buffer> {
  const res = await fetchFn(url, { redirect: "follow" });
  if (!res.ok || res.body === null)
    throw new Error(`${url} returned ${res.status}`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    if (bytes > MAX_ASSET_BYTES)
      throw new Error(`${url} is larger than ${MAX_ASSET_BYTES} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface FetchServersOptions {
  /** The repository root holding mcp-servers.yml. */
  root: string;
  /** Where the binaries go, one file per server, named after it. */
  dir: string;
  platform?: Platform;
  fetch?: typeof fetch;
  /** Builds each download URL; tests point it at a local server. */
  url?: typeof assetUrl;
}

/**
 * Downloads each pinned MCP server for this platform, checks the download
 * against its pinned sha256 before anything is written, unpacks the
 * binary from a .tar.gz, and leaves it executable in dir. A file that does
 * not match its checksum is never written.
 */
export async function fetchServers(
  options: FetchServersOptions,
): Promise<Record<ServerName, string>> {
  const { pins, problems } = loadServerPins(options.root);
  if (pins === undefined)
    throw new Error(problems.map(formatProblem).join("; "));
  const platform = options.platform ?? currentPlatform();
  const fetchFn = options.fetch ?? fetch;
  const url = options.url ?? assetUrl;
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const out = {} as Record<ServerName, string>;
  for (const name of SERVER_NAMES) {
    const pin = pins[name];
    const asset = pin.platforms[platform];
    const data = await download(url(pin, asset), fetchFn);
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (sha256 !== asset.sha256)
      throw new Error(
        `${asset.asset} has sha256 ${sha256}, but mcp-servers.yml pins ${asset.sha256}`,
      );
    const binary = isArchive(asset)
      ? extractFromTar(gunzipSync(data), asset.binary!)
      : data;
    const path = join(options.dir, name);
    const partial = `${path}.partial`;
    writeFileSync(partial, binary, { mode: 0o700 });
    chmodSync(partial, 0o755);
    renameSync(partial, path);
    out[name] = path;
  }
  return out;
}
