import { SCENARIO_ID } from "../output-check/youtube.ts";
import {
  MEDIA_MANIFEST,
  mediaHash,
  type MediaFile,
  type MediaManifest,
} from "../lib/media.ts";
import { byCodePoint } from "../lib/sort.ts";

/** YouTube's limit for a custom thumbnail. */
export const MAX_POSTER_BYTES = 2 * 1024 * 1024;
/** The largest scenario source file the map pull request commits (docs_source_dir). */
export const MAX_SOURCE_BYTES = 256 * 1024;
/** The most items one video may name as left out of it. */
export const MAX_LEFT_OUT = 8;
/** How long a left-out item's title and its reason may be; longer ones are clipped and marked. */
export const MAX_LEFT_OUT_TITLE = 100;
export const MAX_LEFT_OUT_WHY = 200;
/** What ends a clipped left-out title or reason. */
export const CLIPPED = " [cut]";
const SHA256 = /^[0-9a-f]{64}$/;

/** The files one scenario uploads, from the manifest's data.scenarios. */
export interface ScenarioMedia {
  scenario: string;
  video: MediaFile;
  captions: MediaFile;
  poster: MediaFile;
  /** The video's length in seconds, when the media stage recorded it. */
  duration?: number;
  /** sha256 over the sorted "path sha256" lines of the three files: what the map records. */
  hash: string;
  /** sha256 of what the video is made from (its scenario and brand files), when the media stage recorded it; the map records it too. */
  source?: string;
  /** The scenario's source file (data.scenarios[id].scenarioFile), which docs_source_dir commits; not part of the media hash. */
  sourceFile?: MediaFile;
  /** Items the media stage left out of this video, with why, for the review notice and the map pull request; whitespace collapsed and clipped. */
  leftOut?: LeftOutItem[];
}

/** One item a video was meant to show and does not, with the media stage's reason. */
export interface LeftOutItem {
  title: string;
  why: string;
}

/** Text on one line, clipped to max characters with CLIPPED at the end. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if ([...flat].length <= max) return flat;
  return `${[...flat]
    .slice(0, max - CLIPPED.length)
    .join("")
    .trimEnd()}${CLIPPED}`;
}

function leftOutOf(
  value: unknown,
  at: string,
): { items: LeftOutItem[] } | { error: string } {
  if (!Array.isArray(value))
    return { error: `${at}.leftOut is not a list of { title, why }` };
  if (value.length > MAX_LEFT_OUT)
    return {
      error: `${at}.leftOut names ${value.length} items, over the limit of ${MAX_LEFT_OUT}`,
    };
  const items: LeftOutItem[] = [];
  for (const [i, item] of value.entries()) {
    if (
      !isObject(item) ||
      typeof item.title !== "string" ||
      typeof item.why !== "string" ||
      item.title.trim() === "" ||
      item.why.trim() === ""
    )
      return {
        error: `${at}.leftOut[${i}] is not { title, why } with text in both`,
      };
    items.push({
      title: oneLine(item.title, MAX_LEFT_OUT_TITLE),
      why: oneLine(item.why, MAX_LEFT_OUT_WHY),
    });
  }
  return { items };
}

const KINDS = {
  video: ["video/mp4"],
  captions: ["text/vtt"],
  poster: ["image/png", "image/jpeg"],
} as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function scenariosOf(
  manifest: MediaManifest,
): Record<string, unknown> | undefined {
  const scenarios = isObject(manifest.data)
    ? manifest.data.scenarios
    : undefined;
  return isObject(scenarios) ? scenarios : undefined;
}

/** A scenario the media stage could not record this run, with its one-line reason. */
export interface FailedScenario {
  scenario: string;
  reason: string;
}

/** The manifest's data.failed: scenarios the media stage could not record, so they are missing from data.scenarios. */
export function failedScenarios(manifest: MediaManifest): FailedScenario[] {
  const failed = isObject(manifest.data) ? manifest.data.failed : undefined;
  if (!Array.isArray(failed)) return [];
  return failed.flatMap((f) =>
    isObject(f) &&
    typeof f.scenario === "string" &&
    SCENARIO_ID.test(f.scenario)
      ? [
          {
            scenario: f.scenario,
            reason:
              typeof f.reason === "string"
                ? f.reason.replace(/\s+/g, " ").slice(0, 300)
                : "no reason given",
          },
        ]
      : [],
  );
}

/**
 * Each scenario's video, captions and poster, from the manifest's
 * data.scenarios: { "<scenario>": { video, captions, poster, duration?,
 * source?, scenarioFile?, leftOut?, ...metadata } }, paths as in files.
 * A manifest with no files and no data.scenarios, or an empty
 * data.scenarios, has no video: the media stage made none this run.
 */
export function scenarioMedia(
  manifest: MediaManifest,
): { scenarios: Map<string, ScenarioMedia> } | { error: string } {
  const videos = scenariosOf(manifest);
  if (videos === undefined) {
    const data = isObject(manifest.data) ? manifest.data : {};
    if (manifest.files.length === 0 && data.scenarios === undefined)
      return { scenarios: new Map() };
    return {
      error: `${MEDIA_MANIFEST}: data.scenarios is not an object of scenarios`,
    };
  }
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  const out = new Map<string, ScenarioMedia>();
  const sources = new Map<string, string>();
  for (const scenario of Object.keys(videos).sort(byCodePoint)) {
    const entry = videos[scenario];
    const at = `${MEDIA_MANIFEST}: data.scenarios.${scenario}`;
    if (!SCENARIO_ID.test(scenario))
      return { error: `${at}: "${scenario}" is not a scenario id` };
    if (!isObject(entry)) return { error: `${at} is not an object` };
    const picked: Partial<Record<keyof typeof KINDS, MediaFile>> = {};
    for (const kind of Object.keys(KINDS) as (keyof typeof KINDS)[]) {
      const path = entry[kind];
      const file = typeof path === "string" ? byPath.get(path) : undefined;
      if (file === undefined)
        return { error: `${at}.${kind} names no file of the manifest` };
      if (!(KINDS[kind] as readonly string[]).includes(file.type))
        return {
          error: `${at}.${kind}: ${file.path} is ${file.type}, not ${KINDS[kind].join(" or ")}`,
        };
      if (file.bytes === 0) return { error: `${at}.${kind} is empty` };
      picked[kind] = file;
    }
    if (picked.poster!.bytes > MAX_POSTER_BYTES)
      return {
        error: `${at}.poster is ${picked.poster!.bytes} bytes, over YouTube's ${MAX_POSTER_BYTES} byte thumbnail limit`,
      };
    const duration = entry.duration;
    if (
      duration !== undefined &&
      (typeof duration !== "number" || !(duration > 0))
    )
      return { error: `${at}.duration is not a number of seconds` };
    const source = entry.source;
    if (
      source !== undefined &&
      (typeof source !== "string" || !SHA256.test(source))
    )
      return { error: `${at}.source is not a sha256` };
    let sourceFile: MediaFile | undefined;
    if (entry.scenarioFile !== undefined) {
      const path = entry.scenarioFile;
      sourceFile = typeof path === "string" ? byPath.get(path) : undefined;
      if (sourceFile === undefined)
        return { error: `${at}.scenarioFile names no file of the manifest` };
      if (sourceFile.type !== "application/json")
        return {
          error: `${at}.scenarioFile: ${sourceFile.path} is ${sourceFile.type}, not application/json`,
        };
      if (sourceFile.bytes === 0)
        return { error: `${at}.scenarioFile is empty` };
      if (sourceFile.bytes > MAX_SOURCE_BYTES)
        return {
          error: `${at}.scenarioFile is ${sourceFile.bytes} bytes, over the ${MAX_SOURCE_BYTES} byte limit`,
        };
      const other = sources.get(sourceFile.path);
      if (other !== undefined)
        return {
          error: `${at}.scenarioFile is ${other}'s scenarioFile too; each video has its own`,
        };
      sources.set(sourceFile.path, scenario);
    }
    let leftOut: LeftOutItem[] | undefined;
    if (entry.leftOut !== undefined) {
      const got = leftOutOf(entry.leftOut, at);
      if ("error" in got) return got;
      if (got.items.length > 0) leftOut = got.items;
    }
    const three = [picked.video!, picked.captions!, picked.poster!];
    out.set(scenario, {
      scenario,
      video: picked.video!,
      captions: picked.captions!,
      poster: picked.poster!,
      ...(duration === undefined ? {} : { duration }),
      hash: mediaHash(three),
      ...(source === undefined ? {} : { source }),
      ...(sourceFile === undefined ? {} : { sourceFile }),
      ...(leftOut === undefined ? {} : { leftOut }),
    });
  }
  return { scenarios: out };
}

/**
 * The answer a job with model: none delivers: the YouTube metadata each
 * scenario file carries, as the media stage wrote it into data.scenarios.
 * The kit checks it exactly as it would a model's answer.
 */
export function videoAnswer(manifest: MediaManifest): unknown {
  const scenarios = scenariosOf(manifest) ?? {};
  return {
    videos: Object.keys(scenarios)
      .sort(byCodePoint)
      .map((scenario) => {
        const e = scenarios[scenario];
        if (!isObject(e)) return { scenario };
        return {
          scenario,
          title: e.title,
          description: e.description,
          tags: e.tags,
          chapters: e.chapters,
          ...(e.playlist === undefined ? {} : { playlist: e.playlist }),
        };
      }),
  };
}
