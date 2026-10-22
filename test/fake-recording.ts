import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import {
  terminalOverride,
  type Sidecar,
  type TerminalCommand,
  type Timeline,
  type TimelineStep,
} from "../src/media/recording.ts";
import { ffmpegPath } from "../src/media/render.ts";

const run = promisify(execFile);

/** One step of a fake recording: a solid color for `seconds`, and what the timeline says about it. */
export interface FakeStep extends Partial<
  Omit<TimelineStep, "index" | "startMs" | "endMs" | "terminal">
> {
  keyword: string;
  text: string;
  color: string;
  seconds: number;
  /** Commands the step ran, written to terminal/<index>.json; their times are relative to the step's start. */
  commands?: TerminalCommand[];
}

/**
 * Writes a record directory as the scenario recorder does: video.webm with
 * each step a solid color (in `size`, the viewport's aspect), timeline.json,
 * screens/<index>.png, terminal/<index>.json for a step with commands
 * (with the sidecar's display and preface for it) and the sidecar as
 * <id>.video.yml. `scale` is the recording's video pixels
 * per CSS pixel, as the timeline says; boxes are given in video pixels.
 */
export async function writeFakeRecording(
  dir: string,
  steps: readonly FakeStep[],
  sidecar: Sidecar,
  o: {
    viewport?: { width: number; height: number };
    size?: string;
    status?: string;
    scale?: number;
  } = {},
): Promise<Timeline> {
  const viewport = o.viewport ?? { width: 1440, height: 900 };
  const size = o.size ?? "320x200";
  await mkdir(join(dir, "screens"), { recursive: true });
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const s of steps)
    args.push(
      "-f",
      "lavfi",
      "-i",
      `color=c=${s.color}:s=${size}:r=30:d=${s.seconds}`,
    );
  args.push(
    "-filter_complex",
    `${steps.map((_, i) => `[${i}:v]`).join("")}concat=n=${steps.length}:v=1:a=0[v]`,
    "-map",
    "[v]",
    "-c:v",
    "libvpx",
    "-b:v",
    "300k",
    "-deadline",
    "realtime",
    join(dir, "video.webm"),
  );
  await run(ffmpegPath(), args);
  let at = 0;
  const timelineSteps: TimelineStep[] = [];
  const scenes = new Map<number, TerminalCommand[]>();
  for (const [i, s] of steps.entries()) {
    const index = i + 1;
    const screen = `screens/${index}.png`;
    await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${s.color}:s=${size}`,
      "-frames:v",
      "1",
      join(dir, screen),
    ]);
    const { color: _color, seconds, commands, ...rest } = s;
    let terminal: string | null = null;
    if (commands && commands.length > 0) {
      terminal = `terminal/${index}.json`;
      const startMs = Math.round(at * 1000);
      scenes.set(
        index,
        commands.map((c) => ({
          ...c,
          startMs: c.startMs + startMs,
          endMs: c.endMs + startMs,
          output: c.output.map((o) => ({ ...o, atMs: o.atMs + startMs })),
        })),
      );
    }
    timelineSteps.push({
      status: "passed",
      screen,
      terminal,
      actions: [],
      ...rest,
      index,
      startMs: Math.round(at * 1000),
      endMs: Math.round((at + seconds) * 1000),
    });
    at += seconds;
  }
  for (const [index, [first, ...more]] of scenes) {
    const override = terminalOverride(timelineSteps, sidecar, index);
    await mkdir(join(dir, "terminal"), { recursive: true });
    await writeFile(
      join(dir, "terminal", `${index}.json`),
      JSON.stringify({
        index,
        ...first,
        ...(typeof override?.display === "string"
          ? { display: override.display }
          : {}),
        ...(override?.preface ? { preface: override.preface } : {}),
        ...(more.length > 0 ? { more } : {}),
      }),
    );
  }
  const timeline: Timeline = {
    id: sidecar.id,
    scenario: sidecar.scenario,
    feature: "features/example/example.feature",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: o.status ?? "passed",
    video: "video.webm",
    viewport,
    scale: o.scale ?? 1,
    steps: timelineSteps,
  };
  await writeFile(
    join(dir, "timeline.json"),
    JSON.stringify(timeline, null, 2),
  );
  await writeFile(join(dir, `${sidecar.id}.video.yml`), stringify(sidecar));
  return timeline;
}
