import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { replayTimeline, type Cast } from "./cast-file.ts";
import { PAINT_DEFAULTS, type Painter } from "./paint.ts";
import type { Size } from "./production.ts";
import type { TerminalCommand } from "./recording.ts";
import {
  compileStandIns,
  replaceStandIns,
  type StandInRules,
} from "./stand-ins.ts";

// Terminal scenes: a step that ran commands is shown as a terminal, drawn by
// xterm in Chromium, with each command typed at the recording's pace and its
// output replayed, or an asciicast replayed at its own pace. The replay is
// planned as timed writes first (pure), then drawn frame by frame.

/** How a terminal scene is paced, in milliseconds. */
export interface TerminalPace {
  /** Default 60. */
  typeMsPerChar?: number;
  /** After a command is typed, before it runs. Default 600. */
  afterActionMs?: number;
  /** After the last output, for reading. Default 1200. */
  readMs?: number;
  /** The longest a command's run is shown; a longer one is cut to it. Default 2000. */
  idleMs?: number;
  /** The longest a command's output takes to scroll out. Default 1500. */
  outputMs?: number;
}

/** Timed writes to the terminal: seconds from the scene's start and the text written. */
export interface TerminalReplay {
  writes: [number, string][];
  duration: number;
  /** The grid a cast was recorded at; a transcript's grid fits the panel. */
  grid?: { cols: number; rows: number };
}

/** The prompt written before each command. */
export const PROMPT = "\x1b[1m$\x1b[0m ";

const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

/**
 * The writes that show a step's terminal: the preface lines and each
 * command typed after a prompt, the command shown as `display` says when
 * given, each run for its recorded time (at most `idleMs`), its output
 * scrolled out line by line, and a last prompt held for reading. With a
 * cast, the preface is typed first and the cast replays after it, idle gaps
 * capped. Stand-ins apply to everything shown.
 */
export function terminalReplay(o: {
  commands?: readonly TerminalCommand[];
  cast?: Cast;
  display?: string | readonly string[];
  preface?: readonly string[];
  pace?: TerminalPace;
  standIns?: StandInRules;
}): TerminalReplay {
  const type = (o.pace?.typeMsPerChar ?? 60) / 1000;
  const after = (o.pace?.afterActionMs ?? 600) / 1000;
  const read = (o.pace?.readMs ?? 1200) / 1000;
  const idle = (o.pace?.idleMs ?? 2000) / 1000;
  const outputMs = (o.pace?.outputMs ?? 1500) / 1000;
  const rules = o.standIns ? compileStandIns(o.standIns) : undefined;
  const shown = (s: string) => (rules ? replaceStandIns(s, rules) : s);
  const writes: [number, string][] = [];
  let t = 0;
  const typed = (line: string) => {
    writes.push([t, PROMPT]);
    for (const ch of [...line]) {
      t += type;
      writes.push([t, ch]);
    }
    t += after;
    writes.push([t, "\r\n"]);
  };
  for (const line of o.preface ?? []) typed(shown(line));
  if (o.cast) {
    const start = t;
    const replay = replayTimeline(o.cast);
    for (const [at, data] of replay) writes.push([start + at, shown(data)]);
    t = start + (replay.at(-1)?.[0] ?? 0) + read;
    return {
      writes,
      duration: t,
      grid: { cols: o.cast.header.width, rows: o.cast.header.height },
    };
  }
  const display =
    o.display === undefined
      ? []
      : typeof o.display === "string"
        ? [o.display]
        : o.display;
  (o.commands ?? []).forEach((c, i) => {
    typed(shown(display[i] ?? c.command));
    t += Math.min(idle, Math.max(0.3, (c.endMs - c.startMs) / 1000));
    const output = c.output.map((o) => o.text).join("");
    const lines =
      output === ""
        ? []
        : crlf(shown(output))
            .replace(/(\r\n)+$/, "")
            .split("\r\n");
    const per = lines.length > 0 ? Math.min(0.03, outputMs / lines.length) : 0;
    for (const line of lines) {
      writes.push([t, `${line}\r\n`]);
      t += per;
    }
  });
  writes.push([t, PROMPT]);
  return { writes, duration: t + read };
}

/** What a replay shows, as plain text: escape sequences dropped, lines ending in a newline. */
export function replayText(replay: Pick<TerminalReplay, "writes">): string {
  return replay.writes
    .map(([, d]) => d)
    .join("")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r\n?/g, "\n");
}

/** The writes each frame shows first: frame index to the text written by the frame's time, for frames that change. */
export function frameWrites(
  replay: Pick<TerminalReplay, "writes">,
  frames: number,
  fps: number,
): Map<number, string> {
  const out = new Map<number, string>();
  let k = 0;
  const sorted = [...replay.writes].sort((a, b) => a[0] - b[0]);
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    let data = "";
    while (k < sorted.length && sorted[k]![0] <= t + 1e-9)
      data += sorted[k++]![1];
    if (data !== "" || f === 0) out.set(f, data);
  }
  return out;
}

/** The terminal font size that fits a cast's grid into the panel. */
export function castFontSize(
  panel: Size,
  grid: { cols: number; rows: number },
): number {
  return Math.max(
    8,
    Math.floor(
      Math.min(
        panel.width / (grid.cols * 0.602),
        panel.height / (grid.rows * 1.25),
      ),
    ),
  );
}

/** The terminal's look, from the caller's CSS: the --media-terminal-* properties and --media-mono-font. */
export const TERMINAL_DEFAULTS = `:root{--media-terminal-backdrop:#16161a;--media-terminal-bg:#0b0b0e;
  --media-terminal-bar:#1f1f25;--media-terminal-text:#e6e6e6;--media-terminal-cursor:#e6e6e6;
  --media-mono-font:"DejaVu Sans Mono","Liberation Mono",monospace}`;

function terminalHtml(css: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PAINT_DEFAULTS}${TERMINAL_DEFAULTS}${css}
  html,body{margin:0;height:100%;background:var(--media-terminal-backdrop);overflow:hidden}
  #wrap{position:absolute;inset:0;padding:28px 40px;box-sizing:border-box}
  #bar{height:28px;display:flex;align-items:center;gap:8px;padding:0 12px;background:var(--media-terminal-bar);border-radius:10px 10px 0 0}
  #bar i{width:10px;height:10px;border-radius:50%;background:var(--media-terminal-backdrop);display:inline-block}
  #term{height:calc(100% - 28px);background:var(--media-terminal-bg);border-radius:0 0 10px 10px;padding:14px 18px;box-sizing:border-box;overflow:hidden}
</style></head><body><div id="wrap"><div id="bar"><i></i><i></i><i></i></div><div id="term"></div></div></body></html>`;
}

/**
 * Draws a terminal replay as frames: one PNG per frame whose text changed,
 * and an ffmpeg concat list (`list`) that shows each for as long as it
 * lasts; `last` is the final frame. `fontSize` is in layout pixels (half the picture's), for a
 * transcript; a cast's grid sets its own.
 */
export async function drawTerminal(
  painter: Painter,
  replay: TerminalReplay,
  o: {
    size: Size;
    frames: number;
    fps: number;
    dir: string;
    css?: string;
    fontSize?: number;
  },
): Promise<{ list: string; shots: number; last: string }> {
  await mkdir(o.dir, { recursive: true });
  const require = createRequire(import.meta.url);
  const page = await painter.page(o.size);
  try {
    await page.setContent(terminalHtml(o.css ?? ""), { waitUntil: "load" });
    await page.addStyleTag({
      path: require.resolve("@xterm/xterm/css/xterm.css"),
    });
    await page.addScriptTag({
      path: require.resolve("@xterm/xterm/lib/xterm.js"),
    });
    await page.evaluate("document.fonts.ready");
    const panel = (await page.evaluate(`(() => {
      const p = document.getElementById("term");
      const s = getComputedStyle(p);
      return {
        width: p.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight),
        height: p.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom),
      };
    })()`)) as Size;
    const fontSize = replay.grid
      ? castFontSize(panel, replay.grid)
      : (o.fontSize ?? 18);
    await page.evaluate(`(() => {
      const css = getComputedStyle(document.documentElement);
      const v = (n) => css.getPropertyValue(n).trim();
      const term = new window.Terminal({
        cols: 80, rows: 24, fontSize: ${fontSize}, lineHeight: 1.25,
        fontFamily: v("--media-mono-font"), cursorBlink: false, allowProposedApi: false,
        theme: { background: v("--media-terminal-bg"), foreground: v("--media-terminal-text"), cursor: v("--media-terminal-cursor") },
      });
      term.open(document.getElementById("term"));
      window.term = term;
    })()`);
    const grid =
      replay.grid ??
      ((await page.evaluate(`(() => {
        const screen = document.querySelector(".xterm-screen").getBoundingClientRect();
        const row = document.querySelector(".xterm-rows > div").getBoundingClientRect();
        const cw = screen.width / window.term.cols;
        return {
          cols: Math.max(20, Math.floor(${panel.width} / cw)),
          rows: Math.max(5, Math.floor(${panel.height} / row.height)),
        };
      })()`)) as { cols: number; rows: number });
    await page.evaluate(`window.term.resize(${grid.cols}, ${grid.rows})`);
    const writes = frameWrites(replay, o.frames, o.fps);
    const shots: { file: string; frame: number }[] = [];
    for (const [frame, data] of writes) {
      await page.evaluate(
        `new Promise((r) => window.term.write(${JSON.stringify(data)}, () => requestAnimationFrame(() => requestAnimationFrame(() => r()))))`,
      );
      const file = join(o.dir, `t${String(frame).padStart(6, "0")}.png`);
      await page.screenshot({ path: file, type: "png", scale: "device" });
      shots.push({ file, frame });
    }
    const lines: string[] = [];
    shots.forEach((s, i) => {
      const next = shots[i + 1]?.frame ?? o.frames;
      lines.push(
        `file '${s.file}'`,
        `duration ${((next - s.frame) / o.fps).toFixed(6)}`,
      );
    });
    lines.push(`file '${shots.at(-1)!.file}'`);
    const list = join(o.dir, "frames.txt");
    await writeFile(list, lines.join("\n") + "\n");
    return { list, shots: shots.length, last: shots.at(-1)!.file };
  } finally {
    await page.close();
  }
}

/** The replay with every write from `at` seconds on coming `speed` times sooner, for a long scene sped up after its narration. */
export function speedUpReplay(
  replay: TerminalReplay,
  at: number,
  speed: number,
): TerminalReplay {
  const warp = (t: number) => (t <= at ? t : at + (t - at) / speed);
  return {
    ...replay,
    writes: replay.writes.map(([t, d]) => [warp(t), d]),
    duration: warp(replay.duration),
  };
}
