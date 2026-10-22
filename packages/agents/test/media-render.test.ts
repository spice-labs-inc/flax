import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseVtt } from "../src/media/captions.ts";
import {
  ffmpegPath,
  probeMedia,
  renderRecording,
} from "../src/media/render.ts";
import type { Sidecar } from "../src/media/recording.ts";
import { writeFakeRecording, type FakeStep } from "./fake-recording.ts";
import { sineVoice } from "./fake-voice.ts";

const run = promisify(execFile);

/** The RGB of one pixel of a picture file, or of a video at `t` seconds. */
async function pixel(
  file: string,
  x: number,
  y: number,
  t?: number,
): Promise<[number, number, number]> {
  const { stdout } = await run(
    ffmpegPath(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...(t === undefined ? [] : ["-ss", t.toFixed(3)]),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `crop=2:2:${x}:${y}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer" },
  );
  return [stdout[0]!, stdout[1]!, stdout[2]!];
}

/** Which of red, green, blue, yellow and white a pixel is. */
function named([r, g, b]: [number, number, number]): string {
  const on = (v: number) => v > 60;
  if (r > 200 && g > 200 && b > 200) return "white";
  if (on(r) && on(g) && !on(b)) return "yellow";
  if (on(r) && !on(g) && !on(b)) return "red";
  if (!on(r) && on(g) && !on(b)) return "green";
  if (!on(r) && !on(g) && on(b)) return "blue";
  return `rgb(${r},${g},${b})`;
}

// The recording is 1440 by 900 at scale 2, so boxes are in 2880 by 1800 video pixels.
const STEPS: FakeStep[] = [
  { keyword: "Given", text: "a signed-in user", color: "red", seconds: 1.5 },
  {
    keyword: "When",
    text: "I open the list",
    color: "green",
    seconds: 1,
    actions: [
      {
        kind: "click",
        atMs: 1800,
        box: { x: 1200, y: 800, width: 480, height: 200 },
      },
    ],
  },
  {
    keyword: "And",
    text: "I sync the notes",
    color: "white",
    seconds: 2,
    commands: [
      {
        command: "/work/run-7/bin/notes sync --token $TOKEN",
        output: [
          { atMs: 1200, text: "synced 3 notes for run-7@test.example\n" },
        ],
        exitCode: 0,
        startMs: 100,
        endMs: 1600,
      },
    ],
  },
  {
    keyword: "Then",
    text: "I see the item",
    color: "blue",
    seconds: 2,
    actions: [
      {
        kind: "highlight",
        atMs: 4700,
        box: { x: 800, y: 600, width: 600, height: 240 },
      },
    ],
  },
];

const SIDECAR: Sidecar = {
  scenario: "Open the list",
  id: "open-the-list",
  title: "Open the list",
  pace: { typeMsPerChar: 20 },
  intro: {
    chapter: "Introduction",
    heading: "Open the list",
    items: ["Open the menu", { label: "Sync the notes", icon: "sync" }],
    text: "Here is how to open it.",
  },
  narration: [
    { at: 2, text: "Open the list from the menu and wait for it to load." },
    { at: "And I sync the notes", text: "Sync the notes from the terminal." },
    { at: "Then I see the item", text: "The item is there." },
  ],
  chapters: [
    { at: 1, title: "Open" },
    { at: "Then I see the item", title: "Check" },
  ],
  terminal: {
    at: "And I sync the notes",
    display: "notes sync",
    preface: ["export TOKEN=real-secret"],
  },
  poster: { at: 4, title: "Open the list", kicker: "How-to" },
  outro: {
    chapter: "Next",
    heading: "Read more",
    sub: "docs.example.com",
    text: "Thanks for watching.",
  },
  publish: { tags: ["example"] },
};

describe("renderRecording", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "flax-render-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renders a record directory into video, captions, poster and manifest", async () => {
    const record = join(dir, "record");
    await writeFakeRecording(record, STEPS, SIDECAR, { scale: 2 });
    const quiet = ["-hide_banner", "-loglevel", "error", "-y"];
    await run(ffmpegPath(), [
      ...quiet,
      "-f",
      "lavfi",
      "-i",
      "color=c=yellow:s=640x360",
      "-frames:v",
      "1",
      join(dir, "title.png"),
    ]);
    await run(ffmpegPath(), [
      ...quiet,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=3",
      join(dir, "bed.wav"),
    ]);
    const voice = sineVoice({ secondsPerWord: 0.25 });
    const out = join(dir, "out");
    const lines: string[] = [];
    const rendered = await renderRecording({
      recordDir: record,
      tts: (id) => {
        expect(id).toBeUndefined();
        return voice;
      },
      assets: {
        titleCard: { image: join(dir, "title.png"), seconds: 1 },
        css: ":root{--media-band:#ff0000;--media-dim:rgba(0,0,0,.6)}",
        music: { file: join(dir, "bed.wav") },
      },
      production: { zoom: true, callouts: [{ at: 4, text: "The new item" }] },
      standIns: {
        rules: [
          { text: "real-secret", with: "nt_example" },
          { pattern: "run-\\d+@test\\.example", with: "sam@example.com" },
        ],
      },
      burnCaptions: true,
      out,
      threads: 2,
      log: (l) => lines.push(l),
    });

    // The intro's 1.5 s of narration and tail make its card 2 s. The first
    // block (3 s and a 0.5 s tail) holds its 1 s step's last frame 2.5 s.
    // The terminal scene runs at the sidecar's pace; the outro card is 3 s.
    const plan = rendered.plan;
    expect(plan.titleCard).toEqual({ start: 0, end: 2, narration: 0 });
    expect(plan.pieces.map((p) => p.kind)).toEqual([
      "card",
      "clip",
      "hold",
      "terminal",
      "clip",
      "card",
    ]);
    const sync = plan.steps.get(3)!;
    const check = plan.steps.get(4)!;
    expect(plan.steps.get(2)).toEqual({ start: 2, end: 5.5 });
    expect(sync.start).toBe(5.5);
    // Typing 24 + 10 characters at 20 ms, two 0.6 s pauses, the 1.5 s run, one line and the 1.2 s read.
    expect(sync.end - sync.start).toBeCloseTo(0.68 + 1.2 + 1.5 + 0.03 + 1.2, 1);
    expect(check).toEqual({ start: sync.end, end: sync.end + 2 });
    expect(plan.endCard).toEqual({
      start: check.end,
      end: check.end + 3,
      narration: check.end,
    });
    expect(voice.spoken).toEqual([
      SIDECAR.intro!.text,
      ...SIDECAR.narration!.map((n) => n.text),
      SIDECAR.outro!.text,
    ]);
    expect(rendered.terminals).toEqual([
      {
        step: 3,
        text: "$ export TOKEN=nt_example\n$ notes sync\nsynced 3 notes for sam@example.com\n$ ",
      },
    ]);

    const video = await probeMedia(rendered.video);
    expect([video.width, video.height, video.audio]).toEqual([
      2560,
      1440,
      true,
    ]);
    expect(Math.abs(video.duration! - plan.duration)).toBeLessThan(0.05);

    // The hidden red step and the white browser frames of the terminal step
    // never show; the card, the held green frame, the terminal and blue do.
    const at = (t: number) => pixel(rendered.video, 1280, 640, t).then(named);
    expect(await at(1)).toBe("yellow");
    expect(await at(2.3)).toBe("green");
    expect(await at(5.2)).toBe("green");
    const terminal = await pixel(rendered.video, 1280, 640, sync.start + 1);
    expect(Math.max(...terminal)).toBeLessThan(60);
    expect(await at(check.start + 0.5)).toBe("blue");
    expect(await at(check.end - 0.2)).toBe("blue");
    expect(await at(check.end + 1.5)).toBe("red");

    // The callout dims the picture around its box; the burned cue fills the band.
    expect(
      (await pixel(rendered.video, 2200, 100, check.start + 0.1))[2],
    ).toBeGreaterThan(200);
    expect(
      (await pixel(rendered.video, 2200, 100, check.start + 1))[2],
    ).toBeLessThan(150);
    expect(
      named(await pixel(rendered.video, 100, 1400, check.start + 0.5)),
    ).toBe("red");

    const cues = parseVtt(await readFile(rendered.captions, "utf8"));
    expect(cues[0]!.start).toBeCloseTo(0, 2);
    expect(cues[0]!.lines.join(" ")).toBe("Here is how to open it.");
    expect(cues[1]!.start).toBeCloseTo(2, 2);
    expect(
      cues.find((c) => c.lines[0] === "The item is there.")!.start,
    ).toBeCloseTo(check.start, 2);
    expect(cues.at(-1)!.lines.join(" ")).toBe("Thanks for watching.");

    const poster = await probeMedia(rendered.poster);
    expect([poster.width, poster.height]).toEqual([2560, 1440]);
    expect(named(await pixel(rendered.poster, 1280, 500))).toBe("blue");

    const manifest = JSON.parse(await readFile(rendered.manifest!, "utf8"));
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual([
      "captions.vtt",
      "poster.png",
      "video.mp4",
    ]);
    expect(manifest.data).toEqual({
      id: "open-the-list",
      title: "Open the list",
      scenario: "Open the list",
      duration: plan.duration,
      chapters: [
        { start: 0, title: "Introduction" },
        { start: 2, title: "Open" },
        { start: check.start, title: "Check" },
        { start: check.end, title: "Next" },
      ],
      voice: "sine",
      posterStep: 4,
      publish: { tags: ["example"] },
    });
    expect((await readdir(out)).sort()).toEqual([
      "captions.vtt",
      "media.json",
      "poster.png",
      "video.mp4",
    ]);
    expect(
      lines.some((l) =>
        l.startsWith("edit: 3 scenes, 1 terminal scenes, 1 hidden steps cut"),
      ),
    ).toBe(true);
  }, 180_000);

  it("shows the display and preface the recorder wrote into the scene when the sidecar given has no override", async () => {
    const record = join(dir, "scene-override");
    await writeFakeRecording(record, STEPS, SIDECAR);
    const { terminal: _terminal, ...sidecar } = SIDECAR;
    const rendered = await renderRecording({
      recordDir: record,
      sidecar,
      tts: sineVoice(),
      out: join(dir, "scene-override-out"),
      threads: 2,
    });
    expect(rendered.terminals).toEqual([
      {
        step: 3,
        text: "$ export TOKEN=real-secret\n$ notes sync\nsynced 3 notes for run-7@test.example\n$ ",
      },
    ]);
  }, 180_000);

  it("refuses a recording of a failed run and writes nothing", async () => {
    const record = join(dir, "failed");
    await writeFakeRecording(
      record,
      STEPS.map((s, i) => (i === 3 ? { ...s, status: "failed" } : s)),
      SIDECAR,
      { status: "failed" },
    );
    const out = join(dir, "failed-out");
    await expect(
      renderRecording({ recordDir: record, tts: sineVoice(), out }),
    ).rejects.toThrow(
      /refusing to render: the recording of Open the list is marked failed/,
    );
    expect(existsSync(join(out, "video.mp4"))).toBe(false);
  }, 60_000);
});
