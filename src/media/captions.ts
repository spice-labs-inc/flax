/** A timed word of the narration, in seconds from the start of its audio. */
export interface Word {
  text: string;
  start: number;
  end: number;
}

/** One caption on screen. */
export interface Cue {
  start: number;
  end: number;
  lines: string[];
}

const LINE_CHARS = 60;
const MAX_LINES = 2;
const MAX_SECONDS = 6;
const MIN_SECONDS = 1;

function wrap(words: string[]): string[] {
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > LINE_CHARS) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Groups timed words into readable cues: at most two lines of 60 characters, one to six seconds, a sentence end closes a cue. */
export function buildCues(words: Word[]): Cue[] {
  const cues: Cue[] = [];
  let group: Word[] = [];
  const flush = () => {
    const first = group[0];
    const last = group.at(-1);
    if (first === undefined || last === undefined) return;
    cues.push({
      start: first.start,
      end: last.end,
      lines: wrap(group.map((w) => w.text)),
    });
    group = [];
  };
  for (const w of words) {
    const next = [...group, w];
    const chars = next.reduce((n, x) => n + x.text.length + 1, 0);
    const seconds = w.end - next[0]!.start;
    if (
      group.length > 0 &&
      (wrap(next.map((x) => x.text)).length > MAX_LINES ||
        chars > LINE_CHARS * MAX_LINES ||
        seconds > MAX_SECONDS)
    )
      flush();
    group.push(w);
    if (/[.!?]$/.test(w.text)) flush();
  }
  flush();
  cues.forEach((cue, i) => {
    const limit = cues[i + 1] ? cues[i + 1]!.start - 0.05 : Infinity;
    if (cue.end - cue.start < MIN_SECONDS)
      cue.end = Math.min(cue.start + MIN_SECONDS, limit);
  });
  return cues;
}

/** A WebVTT timestamp, hh:mm:ss.mmm. */
export function vttTime(t: number): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/** The cues as a WebVTT captions track. */
export function toVtt(cues: Cue[]): string {
  const out = ["WEBVTT", ""];
  cues.forEach((c, i) => {
    out.push(
      String(i + 1),
      `${vttTime(c.start)} --> ${vttTime(c.end)}`,
      ...c.lines,
      "",
    );
  });
  return out.join("\n");
}

/** Every scene's words on the video's timeline, given where each scene starts. */
export function timelineWords(
  scenes: { id: string; start: number }[],
  words: Map<string, Word[]>,
): Word[] {
  return scenes.flatMap((s) =>
    (words.get(s.id) ?? []).map((w) => ({
      ...w,
      start: w.start + s.start,
      end: w.end + s.start,
    })),
  );
}

/** The cues of a WebVTT track, as toVtt writes them. */
export function parseVtt(text: string): Cue[] {
  const seconds = (s: string) => {
    const parts = s.trim().split(":").map(Number);
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  };
  const cues: Cue[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [from, to] = lines[at]!.split("-->");
    if (from === undefined || to === undefined) continue;
    cues.push({
      start: seconds(from),
      end: seconds(to.trim().split(/\s+/)[0]!),
      lines: lines.slice(at + 1),
    });
  }
  return cues;
}
