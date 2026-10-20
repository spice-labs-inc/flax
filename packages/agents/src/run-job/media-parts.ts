import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  MEDIA_MANIFEST,
  MEDIA_PART_FAILED,
  mediaHash,
  readMediaFile,
  readMediaManifest,
  type MediaFile,
  type MediaManifest,
} from "../lib/media.ts";
import { firstLine } from "../lib/problem.ts";

/** A part that left no media, with why; media.json data.failed lists it as a scenario. */
export interface FailedPart {
  scenario: string;
  reason: string;
}

/** How long a reason a part leaves may be. */
const MAX_REASON = 300;

/** media.ts's failure without the runner's prefix: the reason a part's media are missing. */
export function partReason(failure: string): string {
  return failure
    .replace(/^jobs\/[^ ]+\/media\.ts failed \([^)]*\): /, "")
    .replace(/^no scenario was recorded: [a-z0-9-]+: /, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_REASON);
}

/** What a part run leaves for the delivery job: its media directory as it is, media.json included. */
export function leavePartMedia(mediaDir: string, out: string): void {
  mkdirSync(out, { recursive: true, mode: 0o700 });
  cpSync(mediaDir, out, { recursive: true });
}

/** What a part run whose media stage failed leaves instead of media. */
export function leavePartFailure(
  out: string,
  part: string,
  reason: string,
): void {
  mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(out, MEDIA_PART_FAILED),
    `${JSON.stringify({ part, reason: partReason(reason) }, null, 2)}\n`,
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Merges one part's data into the merged data: objects key by key (a key twice is an error), arrays one after the other. */
function mergeData(
  into: Record<string, unknown>,
  data: unknown,
  part: string,
): void {
  if (data === undefined) return;
  if (!isObject(data))
    throw new Error(`part ${part}: ${MEDIA_MANIFEST} data is not an object`);
  for (const [key, value] of Object.entries(data)) {
    const have = into[key];
    if (have === undefined) into[key] = structuredClone(value);
    else if (Array.isArray(have) && Array.isArray(value)) have.push(...value);
    else if (isObject(have) && isObject(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (k in have)
          throw new Error(
            `part ${part}: data.${key}.${k} is already in another part's ${MEDIA_MANIFEST}`,
          );
        have[k] = structuredClone(v);
      }
    } else
      throw new Error(
        `part ${part}: data.${key} cannot be merged with another part's`,
      );
  }
}

/**
 * Merges the media the parts left (one directory per part, as
 * partDir names it) into one media directory: every file checked against
 * its part's media.json and copied, the parts' data merged, and each part
 * that left no media (failed.json, or nothing at all) listed in
 * data.failed with why. Throws when no part left media.
 */
export function mergeMediaParts(
  parts: readonly string[],
  partDir: (part: string) => string,
  out: string,
): { manifest: MediaManifest; failed: FailedPart[] } {
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  const files: MediaFile[] = [];
  const data: Record<string, unknown> = {};
  const failed: FailedPart[] = [];
  const owner = new Map<string, string>();
  for (const part of parts) {
    const dir = partDir(part);
    const manifestPath = join(dir, MEDIA_MANIFEST);
    if (!existsSync(manifestPath)) {
      failed.push({ scenario: part, reason: missingReason(dir, part) });
      continue;
    }
    let manifest: MediaManifest;
    try {
      manifest = readMediaManifest(manifestPath, dir);
    } catch (err) {
      failed.push({
        scenario: part,
        reason: `its media were refused: ${firstLine(err)}`.slice(
          0,
          MAX_REASON,
        ),
      });
      continue;
    }
    for (const file of manifest.files) {
      const other = owner.get(file.path);
      if (other !== undefined)
        throw new Error(
          `parts ${other} and ${part} both made ${file.path}; each part writes under its own folder`,
        );
      owner.set(file.path, part);
      const to = join(out, file.path);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      // readMediaFile checks the bytes against the part's manifest once more.
      readMediaFile(dir, file);
      copyFileSync(join(dir, file.path), to);
      files.push(file);
    }
    mergeData(data, manifest.data, part);
  }
  if (files.length === 0)
    throw new Error(
      `no part was recorded: ${failed.map((f) => `${f.scenario}: ${f.reason}`).join("; ")}`,
    );
  if (failed.length > 0) mergeData(data, { failed }, "merge");
  const merged = {
    version: 1 as const,
    files,
    hash: mediaHash(files),
    ...(Object.keys(data).length === 0 ? {} : { data }),
  };
  writeFileSync(
    join(out, MEDIA_MANIFEST),
    `${JSON.stringify(merged, null, 2)}\n`,
  );
  return {
    manifest: readMediaManifest(join(out, MEDIA_MANIFEST), out),
    failed,
  };
}

function missingReason(dir: string, part: string): string {
  const file = join(dir, MEDIA_PART_FAILED);
  if (existsSync(file)) {
    try {
      const left = JSON.parse(readFileSync(file, "utf8")) as {
        reason?: unknown;
      };
      if (typeof left.reason === "string" && left.reason.trim() !== "")
        return partReason(left.reason);
    } catch {
      // Unreadable: the generic reason below.
    }
  }
  return `its recording job ended without media; see the media-${part} job's log`;
}
