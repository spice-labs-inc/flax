import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  MAX_MANIFEST_BYTES,
  MAX_MEDIA_BYTES,
  MEDIA_MANIFEST,
  mediaHash,
  mediaPathProblem as kitPathProblem,
  type MediaFile,
  type MediaManifest,
} from "../lib/media.ts";
import { byCodePoint } from "../lib/sort.ts";

export {
  MAX_MANIFEST_BYTES,
  MAX_MEDIA_BYTES,
  MEDIA_MANIFEST,
  mediaHash,
  type MediaFile,
  type MediaManifest,
};

const MAX_FILES = 1000;

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".vtt": "text/vtt",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".ndjson": "application/x-ndjson",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".csv": "text/csv",
};

/** The media type of a file by its extension. */
export function mediaType(path: string): string {
  const type = TYPES[extname(path).toLowerCase()];
  if (type === undefined)
    throw new Error(`${path}: no media type for this extension`);
  return type;
}

/** Why a manifest path is not a plain relative path the kit accepts, or undefined when it is. */
export function mediaPathProblem(path: string): string | undefined {
  if (path.length > 200) return "is longer than 200 characters";
  return kitPathProblem(path);
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Lists, hashes and checks the files at `paths` (relative to `dir`); throws on a bad path, a duplicate or more than 200 MB. */
export async function describeFiles(
  dir: string,
  paths: readonly string[],
): Promise<MediaFile[]> {
  if (paths.length > MAX_FILES)
    throw new Error(`more than ${MAX_FILES} media files`);
  const seen = new Set<string>();
  const files: MediaFile[] = [];
  let total = 0;
  for (const path of [...paths].sort(byCodePoint)) {
    const problem = mediaPathProblem(path);
    if (problem) throw new Error(`media path ${path} ${problem}`);
    if (seen.has(path)) throw new Error(`media path ${path} is listed twice`);
    seen.add(path);
    const full = join(dir, path);
    const info = await lstat(full);
    if (!info.isFile())
      throw new Error(`media path ${path} is not a regular file`);
    total += info.size;
    if (total > MAX_MEDIA_BYTES)
      throw new Error(`media files exceed ${MAX_MEDIA_BYTES / 1024 / 1024} MB`);
    files.push({
      path,
      sha256: await sha256File(full),
      bytes: info.size,
      type: mediaType(path),
    });
  }
  return files;
}

/** The manifest for `files` and job data. */
export function buildManifest(
  files: MediaFile[],
  data?: unknown,
): MediaManifest {
  return {
    version: 1,
    files,
    hash: mediaHash(files),
    ...(data === undefined ? {} : { data }),
  };
}

/**
 * Writes `dir`/media.json listing `paths` (relative to `dir`) with `data`;
 * returns the manifest. This is the whole of what a media.ts owes the
 * runner: the files it made, hashed, and the data the output kind reads
 * (a check job's data.checks and data.builds, for one).
 */
export async function writeManifest(
  dir: string,
  paths: readonly string[],
  data?: unknown,
): Promise<MediaManifest> {
  const manifest = buildManifest(await describeFiles(dir, paths), data);
  const text = JSON.stringify(manifest, null, 2) + "\n";
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES)
    throw new Error(`${MEDIA_MANIFEST} would be larger than 4 MB`);
  await writeFile(join(dir, MEDIA_MANIFEST), text);
  return manifest;
}
