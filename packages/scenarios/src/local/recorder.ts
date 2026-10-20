import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Keystroke, Terminal } from "./terminal.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An asciicast v2 event: seconds, kind ("o" output, "i" input, "m" marker) and data. */
export type CastEvent = [number, string, string];

export interface CastHeader {
  version: 2;
  width: number;
  height: number;
  [key: string]: unknown;
}

/**
 * Records a terminal session with asciinema (3 or later, for `--headless`), attached to the
 * scenario's tmux pane as a viewer that types nothing. Each stop-point becomes a marker, each key the terminal sent an
 * input event, and the text between stop-points a transcript segment.
 */
export class Recorder {
  private child: ChildProcess | undefined;
  private startedAt = 0;
  private readonly markers: { at: number; label: string }[] = [];
  private readonly segments: string[] = [];
  private snapshot = "";

  private readonly terminal: Terminal;
  private readonly rawPath: string;

  constructor(terminal: Terminal, rawPath: string) {
    this.terminal = terminal;
    this.rawPath = rawPath;
  }

  async start(): Promise<void> {
    const { cols, rows } = this.terminal.options;
    this.child = spawn(
      "asciinema",
      [
        "rec",
        "--headless",
        "--overwrite",
        "-q",
        "-f",
        "asciicast-v2",
        "--window-size",
        `${cols}x${rows}`,
        "-c",
        this.terminal.attachCommand(),
        this.rawPath,
      ],
      {
        env: {
          ...process.env,
          TERM: "xterm-256color",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
        },
        stdio: "ignore",
      },
    );
    this.startedAt = Date.now();
    this.snapshot = await this.terminal.history();
    // Let the viewer draw the prompt before anything is typed.
    await sleep(800);
  }

  get started(): boolean {
    return this.child !== undefined;
  }

  /** A stop-point: the player pauses here, and the transcript starts a new segment. */
  async marker(label: string): Promise<void> {
    await sleep(300);
    this.markers.push({ at: Date.now(), label });
    await this.cutSegment();
  }

  private async cutSegment(): Promise<void> {
    const now = await this.terminal.history();
    this.segments.push(transcriptDelta(this.snapshot, now));
    this.snapshot = now;
  }

  /** Ends the session (the terminal is closed, so the viewer exits) and assembles the cast. */
  async stop(): Promise<{ cast: string; transcript: string }> {
    await this.cutSegment();
    const endedAt = Date.now();
    await this.terminal.close();
    await new Promise<void>((resolve) => {
      if (!this.child || this.child.exitCode !== null) return resolve();
      this.child.on("exit", () => resolve());
      setTimeout(() => {
        this.child?.kill();
        resolve();
      }, 10_000);
    });
    const raw = await readFile(this.rawPath, "utf8");
    const { header, events } = parseCast(raw);
    const cast = assembleCast(header, events, {
      startedAt: this.startedAt,
      endedAt,
      markers: this.markers,
      keys: this.terminal.keys.filter((k) => k.at >= this.startedAt),
    });
    return { cast, transcript: this.segments.join("\u001e\n") };
  }
}

export function parseCast(text: string): {
  header: CastHeader;
  events: CastEvent[];
} {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const header = JSON.parse(lines[0] ?? "{}") as CastHeader;
  if (header.version !== 2)
    throw new Error(
      `expected an asciicast v2 recording, got version ${String(header.version)}`,
    );
  return {
    header,
    events: lines.slice(1).map((l) => JSON.parse(l) as CastEvent),
  };
}

/**
 * The finished cast: the recording trimmed to the scenario (the viewer's exit and anything
 * after the session ended dropped), keystrokes as input events, each stop-point as a marker
 * placed just after the last output or key before it, and time starting at the first output.
 */
export function assembleCast(
  header: CastHeader,
  events: CastEvent[],
  at: {
    startedAt: number;
    endedAt: number;
    markers: { at: number; label: string }[];
    keys: Keystroke[];
  },
): string {
  let out = events.filter((e) => e[1] === "o");
  const exited = out.findIndex((e) =>
    /\[(exited|detached|server exited)/.test(e[2]),
  );
  if (exited >= 0) {
    let cut = exited;
    const exitedAt = out[exited]![0];
    while (cut > 0 && exitedAt - out[cut - 1]![0] < 0.05) cut--;
    out = out.slice(0, cut);
  }
  const end = (at.endedAt - at.startedAt) / 1000;
  out = out.filter((e) => e[0] <= end + 0.05);
  // The closing pause has no output; without this the recording would end on its last
  // stop-point and leave nothing to play after it.
  if (out.length > 0 && end > out[out.length - 1]![0]) out.push([end, "o", ""]);
  const all: CastEvent[] = [
    ...out,
    ...at.keys.map((k): CastEvent => [
      (k.at - at.startedAt) / 1000,
      "i",
      k.data,
    ]),
  ];
  for (const m of [...at.markers].sort((a, b) => a.at - b.at)) {
    const t = (m.at - at.startedAt) / 1000;
    const before = all.filter((e) => e[0] <= t).map((e) => e[0]);
    all.push([(before.length ? Math.max(...before) : 0) + 0.001, "m", m.label]);
  }
  all.sort((a, b) => a[0] - b[0]);
  const first = all.find((e) => e[1] === "o")?.[0] ?? 0;
  const head = {
    version: 2,
    width: header.width,
    height: header.height,
    idle_time_limit: 2,
    ...(header["title"] ? { title: header["title"] } : {}),
  };
  return (
    [
      JSON.stringify(head),
      ...all.map((e) =>
        JSON.stringify([
          Math.round(Math.max(0, e[0] - first) * 1e6) / 1e6,
          e[1],
          e[2],
        ]),
      ),
    ].join("\n") + "\n"
  );
}

/** What appeared in the pane since `before`: the new lines, or the whole screen after a clear. */
export function transcriptDelta(before: string, after: string): string {
  // The previous segment ended at a prompt the next command was then typed after: compare
  // without it, so this segment starts with that whole command line.
  const old = withoutTrailingPrompts(before.split("\n")).join("\n");
  const now = after.replace(/\n+$/, "");
  const delta =
    old && now.startsWith(`${old}\n`) ? now.slice(old.length + 1) : now;
  return withoutTrailingPrompts(delta.split("\n"))
    .join("\n")
    .replace(/\s+$/, "");
}

const isPrompt = (line: string): boolean =>
  /❯\s*$/.test(line) || line.trim() === "";

function withoutTrailingPrompts(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && isPrompt(out[out.length - 1]!)) out.pop();
  return out;
}
