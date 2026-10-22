import { workspace } from "../lib/workspace.ts";
import type { LinkHosts } from "../lib/link-hosts.ts";
import { linkProblems } from "./links.ts";

/** A chapter of a video: where it starts, in whole seconds, and its title. */
export interface VideoChapter {
  start: number;
  title: string;
}

/** One video's metadata, as a scenario file gives it; the kit appends the chapter lines to the description. */
export interface VideoMetadata {
  scenario: string;
  title: string;
  description: string;
  tags: string[];
  chapters: VideoChapter[];
  /** The title of the playlist this video goes in, instead of the job's; the job's when absent or null. */
  playlist?: string | null;
}

/** The longest playlist title YouTube takes. */
export const MAX_PLAYLIST_CHARS = 150;

/** YouTube's limits on video metadata (videos resource, snippet). */
export const MAX_TITLE_CHARS = 100;
export const MAX_DESCRIPTION_BYTES = 5000;
export const MAX_TAGS_CHARS = 500;
/** YouTube shows chapters only with at least three, the first at 0:00, each at least 10 seconds long. */
export const MIN_CHAPTERS = 3;
export const MIN_CHAPTER_SECONDS = 10;
export const MAX_CHAPTERS = 100;
export const MAX_TAGS = 50;

/** A scenario id: what the media manifest and the map file are keyed by. */
export const SCENARIO_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ANGLE = /[<>]/;
// Every control character but the newline a description may have.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const TIMESTAMP_LINE = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?!\d)/;

function chars(text: string): number {
  return [...text].length;
}

/** A chapter start as YouTube reads it in a description: m:ss, or h:mm:ss from an hour on. */
export function timestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The last line of every uploaded description: comments are off on the channel. */
export function questionsLine(): string {
  return workspace().video?.footer ?? "";
}

/** The description as uploaded: the model's text, one line per chapter, then where to ask questions, written by the kit. */
export function fullDescription(video: VideoMetadata): string {
  const text = video.description.replaceAll("\r", "").trim();
  const lines = video.chapters.map((c) => `${timestamp(c.start)} ${c.title}`);
  return [text, lines.join("\n"), questionsLine()]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** How YouTube counts the tags against its 500-character limit: commas between tags, and quotes around a tag with a space. */
export function tagsLength(tags: readonly string[]): number {
  return (
    tags.reduce((n, t) => n + chars(t) + (t.includes(" ") ? 2 : 0), 0) +
    Math.max(0, tags.length - 1)
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function shapeProblems(answer: unknown): string[] {
  if (!isObject(answer)) return ["the answer is not an object"];
  const extra = Object.keys(answer).filter((k) => k !== "videos");
  const out = extra.map((k) => `the answer has a property "${k}"`);
  const videos = answer.videos;
  if (!Array.isArray(videos) || videos.length === 0)
    return [...out, "videos must be a list of at least one video"];
  for (const [i, v] of videos.entries()) {
    const at = `videos[${i}]`;
    if (!isObject(v)) {
      out.push(`${at} is not an object`);
      continue;
    }
    for (const k of Object.keys(v))
      if (
        ![
          "scenario",
          "title",
          "description",
          "tags",
          "chapters",
          "playlist",
        ].includes(k)
      )
        out.push(`${at} has a property "${k}"`);
    for (const k of ["scenario", "title", "description"])
      if (typeof v[k] !== "string") out.push(`${at}.${k} must be a string`);
    if (
      v.playlist !== undefined &&
      v.playlist !== null &&
      typeof v.playlist !== "string"
    )
      out.push(`${at}.playlist must be a string or null`);
    if (!Array.isArray(v.tags) || v.tags.some((t) => typeof t !== "string"))
      out.push(`${at}.tags must be a list of strings`);
    if (
      !Array.isArray(v.chapters) ||
      v.chapters.some(
        (c) =>
          !isObject(c) ||
          !Number.isInteger(c.start) ||
          typeof c.title !== "string" ||
          Object.keys(c).some((k) => k !== "start" && k !== "title"),
      )
    )
      out.push(
        `${at}.chapters must be a list of { start, title }, start in whole seconds`,
      );
  }
  return out;
}

function textProblems(
  at: string,
  text: string,
  options: { lines: boolean; maxChars?: number },
): string[] {
  const out: string[] = [];
  if (ANGLE.test(text))
    out.push(`${at} has < or >, which YouTube does not take`);
  if (CONTROL.test(text)) out.push(`${at} has a control character`);
  if (!options.lines && text.includes("\n")) out.push(`${at} must be one line`);
  if (options.maxChars !== undefined && chars(text) > options.maxChars)
    out.push(
      `${at} is ${chars(text)} characters, over the limit of ${options.maxChars}`,
    );
  return out;
}

function linkLines(
  at: string,
  text: string,
  hosts: LinkHosts,
  multiline: boolean,
): string[] {
  const lines = text.split("\n").map((t, i) => ({ line: i + 1, text: t }));
  return linkProblems([], lines, hosts).map((p) =>
    multiline ? `${at}: ${p}` : `${at}: ${p.replace(/^line 1 /, "")}`,
  );
}

function chapterProblems(
  at: string,
  chapters: readonly VideoChapter[],
  duration: number | undefined,
): string[] {
  if (chapters.length === 0) return [];
  const out: string[] = [];
  if (chapters.length < MIN_CHAPTERS)
    out.push(
      `${at} has ${chapters.length}; YouTube shows chapters only with at least ${MIN_CHAPTERS}, so give none or at least ${MIN_CHAPTERS}`,
    );
  if (chapters.length > MAX_CHAPTERS)
    out.push(`${at} has ${chapters.length}, over the limit of ${MAX_CHAPTERS}`);
  if (chapters[0]!.start !== 0) out.push(`${at}[0] must start at 0`);
  for (let i = 1; i < chapters.length; i++) {
    const gap = chapters[i]!.start - chapters[i - 1]!.start;
    if (gap <= 0)
      out.push(`${at}[${i}] must start after the chapter before it`);
    else if (gap < MIN_CHAPTER_SECONDS)
      out.push(
        `${at}[${i - 1}] is ${gap} s long; YouTube needs at least ${MIN_CHAPTER_SECONDS} s`,
      );
  }
  const last = chapters.at(-1)!;
  if (duration !== undefined && last.start > duration - MIN_CHAPTER_SECONDS)
    out.push(
      `${at}[${chapters.length - 1}] starts at ${last.start} s, less than ${MIN_CHAPTER_SECONDS} s before the video ends at ${duration} s`,
    );
  return out;
}

export type VideoCheck =
  { ok: true; videos: VideoMetadata[] } | { ok: false; problems: string[] };

/**
 * Checks the videos' metadata before anything is uploaded (the media
 * manifest's, for a job with model: none, held to the rules a model's
 * answer would be): the answer's
 * shape, YouTube's limits (a title of at most 100 characters, a
 * description of at most 5,000 bytes with the kit's chapter lines, tags of
 * at most 500 characters as YouTube counts them, no < or >), chapters
 * YouTube will show (none, or at least three, the first at 0, each at
 * least 10 seconds long), no timestamp lines of the model's own, and links
 * only to hosts in link-hosts.yml, in every text.
 */
export function checkVideoAnswer(
  answer: unknown,
  options: {
    links: LinkHosts;
    /** Each scenario's length in seconds, when the media stage recorded it. */
    durations?: ReadonlyMap<string, number>;
  },
): VideoCheck {
  const shape = shapeProblems(answer);
  if (shape.length > 0) return { ok: false, problems: shape };
  const videos = (answer as { videos: VideoMetadata[] }).videos;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [i, v] of videos.entries()) {
    const at = `videos[${i}]`;
    if (!SCENARIO_ID.test(v.scenario))
      problems.push(`${at}.scenario "${v.scenario}" is not a scenario id`);
    if (seen.has(v.scenario))
      problems.push(`${at}.scenario "${v.scenario}" is listed more than once`);
    seen.add(v.scenario);
    if (v.title.trim() === "") problems.push(`${at}.title is empty`);
    problems.push(
      ...textProblems(`${at}.title`, v.title, {
        lines: false,
        maxChars: MAX_TITLE_CHARS,
      }),
      ...linkLines(`${at}.title`, v.title, options.links, false),
      ...textProblems(`${at}.description`, v.description, { lines: true }),
      ...linkLines(`${at}.description`, v.description, options.links, true),
    );
    for (const [n, line] of v.description.split("\n").entries())
      if (TIMESTAMP_LINE.test(line))
        problems.push(
          `${at}.description: line ${n + 1} starts with a timestamp; chapters go in chapters, and the kit writes their lines`,
        );
    for (const [j, t] of v.tags.entries()) {
      if (t.trim() === "") problems.push(`${at}.tags[${j}] is empty`);
      if (t.includes(","))
        problems.push(`${at}.tags[${j}] has a comma, which separates tags`);
      problems.push(
        ...textProblems(`${at}.tags[${j}]`, t, { lines: false }),
        ...linkLines(`${at}.tags[${j}]`, t, options.links, false),
      );
    }
    if (v.tags.length > MAX_TAGS)
      problems.push(
        `${at}.tags has ${v.tags.length}, over the limit of ${MAX_TAGS}`,
      );
    if (tagsLength(v.tags) > MAX_TAGS_CHARS)
      problems.push(
        `${at}.tags come to ${tagsLength(v.tags)} characters as YouTube counts them, over the limit of ${MAX_TAGS_CHARS}`,
      );
    for (const [j, c] of v.chapters.entries()) {
      if (c.title.trim() === "")
        problems.push(`${at}.chapters[${j}].title is empty`);
      problems.push(
        ...textProblems(`${at}.chapters[${j}].title`, c.title, {
          lines: false,
          maxChars: MAX_TITLE_CHARS,
        }),
        ...linkLines(
          `${at}.chapters[${j}].title`,
          c.title,
          options.links,
          false,
        ),
      );
    }
    if (typeof v.playlist === "string") {
      if (v.playlist.trim() === "") problems.push(`${at}.playlist is empty`);
      problems.push(
        ...textProblems(`${at}.playlist`, v.playlist, {
          lines: false,
          maxChars: MAX_PLAYLIST_CHARS,
        }),
      );
    }
    problems.push(
      ...chapterProblems(
        `${at}.chapters`,
        v.chapters,
        options.durations?.get(v.scenario),
      ),
    );
    const bytes = Buffer.byteLength(fullDescription(v));
    if (bytes > MAX_DESCRIPTION_BYTES)
      problems.push(
        `${at}.description is ${bytes} bytes with the chapter and questions lines, over the limit of ${MAX_DESCRIPTION_BYTES}`,
      );
  }
  return problems.length > 0
    ? { ok: false, problems }
    : {
        ok: true,
        videos: videos.map((v) => ({
          scenario: v.scenario,
          title: v.title.trim(),
          description: v.description,
          tags: v.tags.map((t) => t.trim()),
          chapters: v.chapters.map((c) => ({
            start: c.start,
            title: c.title.trim(),
          })),
          ...(typeof v.playlist === "string"
            ? { playlist: v.playlist.trim() }
            : {}),
        })),
      };
}
