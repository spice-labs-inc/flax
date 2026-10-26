import { ToolRefusal } from "./mapping.ts";

const HOUR_MS = 3600 * 1000;

/** How far into the future an end time may lie, for clocks that disagree a little. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** RFC 3339 with an explicit offset, the only time format time arguments take. */
export const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseTime(value: unknown, field: string): Date {
  const text = String(value);
  const ms = RFC3339.test(text) ? Date.parse(text) : NaN;
  if (Number.isNaN(ms))
    throw new ToolRefusal(
      `${field} must be an RFC 3339 time such as 2026-09-28T14:00:00Z`,
    );
  return new Date(ms);
}

/**
 * A time range from the start and end arguments: start before end, at most
 * maxHours long, and ending no later than now.
 */
export function timeRange(
  args: Record<string, unknown>,
  maxHours: number,
  now: Date,
): { start: Date; end: Date } {
  const start = parseTime(args.start, "start");
  const end = parseTime(args.end, "end");
  if (end.getTime() <= start.getTime())
    throw new ToolRefusal("end must be after start");
  if (end.getTime() - start.getTime() > maxHours * HOUR_MS)
    throw new ToolRefusal(
      `the time range may be at most ${maxHours} hours long`,
    );
  if (end.getTime() > now.getTime() + CLOCK_SKEW_MS)
    throw new ToolRefusal("end may not be in the future");
  return { start, end };
}

/** Microseconds since the epoch, the unit OpenObserve's search takes. */
export function micros(date: Date): number {
  return date.getTime() * 1000;
}

/** Copies the named arguments that are set, under new names where given. */
export function pick(
  args: Record<string, unknown>,
  names: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [from, to] of Object.entries(names))
    if (args[from] !== undefined) out[to] = args[from];
  return out;
}

/** Refuses when any of the named arguments is set. */
export function refuseWith(
  args: Record<string, unknown>,
  names: readonly string[],
  reason: string,
): void {
  const set = names.filter((n) => args[n] !== undefined);
  if (set.length > 0) throw new ToolRefusal(`${set.join(", ")} ${reason}`);
}

const DAY_MS = 24 * HOUR_MS;

/** A since argument as YYYY-MM-DD in UTC: a real day, not in the future, at most maxDays back. */
export function sinceDay(value: unknown, now: Date, maxDays: number): string {
  const day = String(value);
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day)
    throw new ToolRefusal("since must be a real day, as YYYY-MM-DD");
  if (ms > now.getTime() + CLOCK_SKEW_MS)
    throw new ToolRefusal("since may not be in the future");
  if (now.getTime() - ms > (maxDays + 1) * DAY_MS)
    throw new ToolRefusal(`since may be at most ${maxDays} days back`);
  return day;
}

/** What a directory listing keeps of each entry. */
const DIRECTORY_FIELDS = ["name", "path", "type", "size", "sha"] as const;

/**
 * A get_file_contents directory listing with each entry cut to its name,
 * path, type, size and sha, so a directory of a few hundred files fits the
 * result cap (each entry also carries four URLs and a links object). Any
 * other result (a file, an error) is returned as it is.
 */
export function slimDirectory(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (e) => typeof e === "object" && e !== null && "type" in e && "path" in e,
    )
  )
    return text;
  return JSON.stringify(
    parsed.map((e: Record<string, unknown>) =>
      Object.fromEntries(
        DIRECTORY_FIELDS.filter((k) => k in e).map((k) => [k, e[k]]),
      ),
    ),
  );
}

/** The first line of a gh-file result for a text file, naming its blob sha. */
const FILE_HEAD = /^([^\n]*\(SHA: [0-9a-f]{7,64}\)[^\n]*)\n/;

/**
 * A range of a text file's lines from a get_file_contents result, for a
 * file too long for the result cap: the head line stays, extended with the
 * lines returned and the file's line count. Any other result (a directory
 * listing, an error) is returned as it is.
 */
export function fileLineRange(
  text: string,
  startLine: number | undefined,
  lineCount: number | undefined,
): string {
  if (startLine === undefined && lineCount === undefined) return text;
  const head = FILE_HEAD.exec(text);
  if (head === null) return text;
  const body = text.slice(head[0].length);
  const lines =
    body === ""
      ? []
      : (body.endsWith("\n") ? body.slice(0, -1) : body).split("\n");
  const first = startLine ?? 1;
  const slice = lines.slice(
    first - 1,
    lineCount === undefined ? undefined : first - 1 + lineCount,
  );
  const range =
    slice.length === 0 ? "none" : `${first}-${first - 1 + slice.length}`;
  return `${head[1]}; lines ${range} of ${lines.length}\n${slice.map((l) => `${l}\n`).join("")}`;
}
