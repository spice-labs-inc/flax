import { isAbsolute, join, resolve } from "node:path";

// asciicast v2 recordings, as a video's cast step replays them in the terminal pane:
// output events ("o"), input events ("i") and marker events ("m"); only the output is
// replayed.

export type CastEvent = [number, "o" | "i" | "m", string];

export interface CastHeader {
  version: 2;
  width: number;
  height: number;
  title?: string;
  idle_time_limit?: number;
  survey?: { edition: string; scenario: string; source?: string };
  [key: string]: unknown;
}

export interface Cast {
  header: CastHeader;
  events: CastEvent[];
}

export function parseCast(text: string, where = "cast"): Cast {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) throw new Error(`${where}: empty recording`);
  const header = JSON.parse(lines[0]!) as CastHeader;
  if (header.version !== 2)
    throw new Error(
      `${where}: expected asciicast v2 (got version ${String(header.version)})`,
    );
  return {
    header,
    events: lines.slice(1).map((l) => JSON.parse(l) as CastEvent),
  };
}

/** Output events with idle gaps capped, for replaying a cast inside a video. */
export function replayTimeline(
  cast: Cast,
  idleLimit?: number,
): [number, string][] {
  const limit = idleLimit ?? cast.header.idle_time_limit ?? 2;
  const out: [number, string][] = [];
  let shift = 0;
  let prev = 0;
  for (const [t, k, d] of cast.events) {
    if (k !== "o") continue;
    if (t - prev > limit) shift += t - prev - limit;
    out.push([Math.max(0, t - shift), d]);
    prev = t;
  }
  return out;
}

/** Names the directory of unpacked recordings-<edition>.tar.gz release assets that recording: casts are read from. */
export const RECORDINGS_ROOT_ENV = "FLAX_RECORDINGS_ROOT";

const RECORDING =
  /^recording:([a-z][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*(?:@[a-z]+=[a-z0-9-]+(?:,[a-z]+=[a-z0-9-]+)*)?)$/;

/** A scenarios recording by edition and name: `<id>` or `<id>@shell=<s>`. */
export interface RecordingRef {
  edition: string;
  name: string;
}

/** The recording a cast step's "recording:<edition>/<id>[@shell=<s>]" names; undefined for a file path. */
export function parseRecording(ref: string): RecordingRef | undefined {
  if (!ref.startsWith("recording:")) return undefined;
  const m = RECORDING.exec(ref);
  if (!m)
    throw new Error(
      `${ref}: expected recording:<edition>/<id>, or recording:<edition>/<id>@shell=<shell>`,
    );
  return { edition: m[1]!, name: m[2]! };
}

/** Where a video's cast step reads its cast: "recording:<edition>/<id>[@shell=<s>]" from the recordings directory, "docs:<path>" from the public-docs checkout, else from the scenario directory. */
export function castPath(
  ref: string,
  scenarioDir: string,
  recordingsRoot: string | undefined,
  docsRoot?: string,
): string {
  const recording = parseRecording(ref);
  if (recording) {
    if (!recordingsRoot)
      throw new Error(
        `${ref}: set ${RECORDINGS_ROOT_ENV} to a directory of unpacked recordings-<edition>.tar.gz release assets`,
      );
    return join(recordingsRoot, recording.edition, `${recording.name}.cast`);
  }
  if (ref.startsWith("docs:")) {
    if (!docsRoot)
      throw new Error(`${ref}: set FLAX_DOCS_ROOT to a public-docs checkout`);
    return join(docsRoot, ref.slice(5));
  }
  return isAbsolute(ref) ? ref : resolve(scenarioDir, ref);
}
