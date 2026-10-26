import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MAX_POSTER_BYTES, scenarioMedia } from "../src/deliver/media.ts";
import { parseVtt } from "../src/media/captions.ts";
import {
  ffmpegPath,
  fitPoster,
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

/** The brightest channel value in a region of a video's frame at `t` seconds. */
async function brightest(
  file: string,
  r: { x: number; y: number; width: number; height: number },
  t: number,
): Promise<number> {
  const { stdout } = await run(
    ffmpegPath(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      t.toFixed(3),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `crop=${r.width}:${r.height}:${r.x}:${r.y}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1 << 26 },
  );
  return stdout.reduce((m, v) => Math.max(m, v), 0);
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

// The recording is 1440 by 900 at scale 2; boxes are in viewport CSS pixels, as the recorder writes them.
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
        box: { x: 600, y: 400, width: 240, height: 100 },
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
        box: { x: 400, y: 300, width: 300, height: 120 },
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
  afterEach(() => {
    vi.unstubAllEnvs();
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
    // Too short for three chapters ten seconds apart, so YouTube gets none.
    expect(manifest.data).toEqual({
      scenarios: {
        "open-the-list": {
          title: "Open the list",
          description: "",
          tags: ["example"],
          video: "video.mp4",
          captions: "captions.vtt",
          poster: "poster.png",
          duration: plan.duration,
          chapters: [],
        },
      },
    });
    expect(rendered.entry).toEqual(manifest.data.scenarios["open-the-list"]);
    expect(rendered.media).toEqual({
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

  it("speeds up a long wait with a badge, replays a docs cast, fits the chapters and the poster to the delivery", async () => {
    const docs = join(dir, "docs");
    await mkdir(join(docs, "casts"), { recursive: true });
    await writeFile(
      join(docs, "casts", "sync.cast"),
      [
        JSON.stringify({ version: 2, width: 80, height: 24 }),
        JSON.stringify([3.5, "o", "synced from the docs\r\n"]),
      ].join("\n") + "\n",
    );
    vi.stubEnv("FLAX_DOCS_ROOT", docs);
    const record = join(dir, "long");
    const sidecar: Sidecar = {
      scenario: "Wait for the report",
      id: "wait-for-the-report",
      title: "Wait for the report",
      description: "The report, start to finish.",
      narration: [
        { at: 1, text: "Open the list." },
        { at: 3, text: "Sync the notes." },
      ],
      chapters: [
        { at: 1, title: "Open" },
        { at: 3, title: "Sync" },
        { at: 4, title: "Check" },
      ],
      terminal: { at: 3, cast: "docs:casts/sync.cast" },
      publish: {
        youtube: {
          title: "Waiting for a report",
          tags: ["reports"],
          playlist: "Tutorials",
        },
        owner: "docs-team",
      },
    };
    await writeFakeRecording(
      record,
      [
        {
          keyword: "When",
          text: "I open the list",
          color: "green",
          seconds: 2,
        },
        {
          keyword: "And",
          text: "I wait for the report",
          color: "blue",
          seconds: 16,
        },
        {
          keyword: "And",
          text: "I sync the notes",
          color: "white",
          seconds: 1,
        },
        { keyword: "Then", text: "I see the report", color: "red", seconds: 5 },
      ],
      sidecar,
    );
    const out = join(dir, "long-out");
    const rendered = await renderRecording({
      recordDir: record,
      tts: sineVoice(),
      out,
      threads: 2,
      chapters: { minSeconds: 3 },
      assets: {
        poster: async ({ out }) => {
          await run(ffmpegPath(), [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=gray:s=2560x1440,noise=alls=100:allf=u",
            "-frames:v",
            "1",
            out,
          ]);
        },
      },
    });

    // The 16 s wait has no narration, so it plays in 4 s at four times the speed.
    const plan = rendered.plan;
    expect(plan.idle).toEqual([{ start: 2, end: 6, speed: 4 }]);
    expect(plan.steps.get(2)).toEqual({ start: 2, end: 6 });
    const at = (x: number, y: number, t: number) =>
      pixel(rendered.video, x, y, t).then(named);
    expect(await at(1280, 640, 4)).toBe("blue");
    // The badge sits at the picture's top right, over the pillarbox, only while the wait is sped up.
    expect(await at(2440, 60, 4)).toBe("white");
    expect(await at(2440, 60, 1)).toBe("rgb(0,0,0)");
    expect(await at(2440, 60, plan.steps.get(4)!.start + 1)).toBe("rgb(0,0,0)");

    expect(rendered.terminals).toEqual([
      { step: 3, text: "synced from the docs\n" },
    ]);

    const check = plan.steps.get(4)!;
    expect(rendered.entry.chapters).toEqual([
      { start: 0, title: "Open" },
      { start: 6, title: "Sync" },
      { start: Math.floor(check.start), title: "Check" },
    ]);

    // The noisy poster is over 2 MB as a PNG at either size, so it is a JPEG.
    expect(rendered.poster).toBe(join(out, "poster.jpg"));
    expect(existsSync(join(out, "poster.png"))).toBe(false);
    const poster = await probeMedia(rendered.poster);
    expect([poster.width, poster.height]).toEqual([1920, 1080]);
    expect((await stat(rendered.poster)).size).toBeLessThanOrEqual(
      MAX_POSTER_BYTES,
    );

    const manifest = JSON.parse(await readFile(rendered.manifest!, "utf8"));
    expect(manifest.data.scenarios["wait-for-the-report"]).toMatchObject({
      title: "Waiting for a report",
      description: "The report, start to finish.",
      tags: ["reports"],
      playlist: "Tutorials",
      owner: "docs-team",
      poster: "poster.jpg",
    });
    const media = scenarioMedia(manifest);
    if ("error" in media) throw new Error(media.error);
    const delivered = media.scenarios.get("wait-for-the-report")!;
    expect(delivered.poster.type).toBe("image/jpeg");
    expect(delivered.duration).toBe(plan.duration);
  }, 180_000);

  it("reads a docs cast from the docsRoot option, and refuses one with no docs root", async () => {
    vi.stubEnv("FLAX_DOCS_ROOT", "");
    const record = join(dir, "no-docs");
    const sidecar: Sidecar = {
      scenario: "Sync",
      id: "sync",
      title: "Sync",
      terminal: { at: 1, cast: "docs:casts/missing.cast" },
    };
    await writeFakeRecording(
      record,
      [{ keyword: "When", text: "I sync", color: "white", seconds: 1 }],
      sidecar,
    );
    const render = (docsRoot?: string) =>
      renderRecording({
        recordDir: record,
        tts: sineVoice(),
        out: join(dir, "no-docs-out"),
        ...(docsRoot ? { docsRoot } : {}),
      });
    await expect(render()).rejects.toThrow(
      /docs:casts\/missing.cast: set FLAX_DOCS_ROOT/,
    );
    await expect(render(join(dir, "elsewhere"))).rejects.toThrow(
      /elsewhere\/casts\/missing.cast/,
    );
  }, 60_000);

  it("points a callout at the recorder's CSS box on a recording at device scale 1.25, and trims a step", async () => {
    const record = join(dir, "scaled");
    const sidecar: Sidecar = {
      scenario: "Find the item",
      id: "find-the-item",
      title: "Find the item",
      narration: [
        { at: 1, text: "Open it." },
        { at: 2, text: "Here it is." },
      ],
    };
    await writeFakeRecording(
      record,
      [
        { keyword: "When", text: "I open it", color: "green", seconds: 2 },
        {
          keyword: "Then",
          text: "I see the item",
          color: "blue",
          seconds: 3,
          actions: [
            {
              kind: "highlight",
              atMs: 2500,
              box: { x: 800, y: 500, width: 200, height: 100 },
            },
          ],
        },
      ],
      sidecar,
      { viewport: { width: 1280, height: 800 }, size: "400x250", scale: 1.25 },
    );
    const rendered = await renderRecording({
      recordDir: record,
      tts: sineVoice(),
      out: join(dir, "scaled-out"),
      threads: 2,
      assets: { css: ":root{--media-dim:rgba(0,0,0,.6)}" },
      production: { callouts: [{ at: 2, text: "The item" }] },
      trim: [{ at: "When I open it", start: 0.5 }],
    });
    const item = rendered.plan.steps.get(2)!;
    expect(rendered.plan.steps.get(1)).toEqual({ start: 0, end: 1.5 });
    expect(item).toEqual({ start: 1.5, end: 4.5 });
    // The viewport fills 2048 by 1280 of the picture from x 256, 1.6 picture pixels a CSS pixel: the box is 1536, 800, 320 by 160.
    const t = item.start + 1;
    expect((await pixel(rendered.video, 1696, 880, t))[2]).toBeGreaterThan(200);
    expect((await pixel(rendered.video, 1460, 880, t))[2]).toBeLessThan(150);
    expect((await pixel(rendered.video, 700, 300, t))[2]).toBeLessThan(150);
  }, 180_000);

  it("plays an animated card at the start, a card in place of a terminal step, a recap revealed line by line, and fades between them", async () => {
    const record = join(dir, "cards");
    const sidecar: Sidecar = {
      scenario: "Sync the list",
      id: "sync-the-list",
      title: "Sync the list",
      narration: [
        { at: 1, text: "Open the list." },
        { at: 3, text: "The item is there." },
      ],
      chapters: [
        { at: 1, title: "Open" },
        { at: "Then I see the item", title: "Check" },
      ],
    };
    await writeFakeRecording(
      record,
      [STEPS[1]!, STEPS[2]!, STEPS[3]!].map((s) => ({ ...s, seconds: 2 })),
      sidecar,
      { scale: 2 },
    );
    const page = (style: string) =>
      `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}${style}</style></head><body></body></html>`;
    const voice = sineVoice({ secondsPerWord: 0.25 });
    const lines: string[] = [];
    const rendered = await renderRecording({
      recordDir: record,
      tts: voice,
      out: join(dir, "cards-out"),
      threads: 2,
      chapters: { minSeconds: 2 },
      cards: [
        {
          at: "start",
          html: page(
            "body{animation:sting 1s linear forwards}@keyframes sting{from{background:#ff0000}to{background:#0000ff}}",
          ),
          animate: { seconds: 1 },
          seconds: 1.5,
        },
        {
          at: "And I sync the notes",
          replace: true,
          html: page("body{background:#ff0000}"),
          narration: "The notes sync in the background.",
          chapter: "Sync",
        },
      ],
      recap: {
        heading: "What you did",
        lines: [
          { text: "Opened the list" },
          { text: "Synced the notes", narration: "You synced your notes." },
        ],
        chapter: "Recap",
      },
      transition: { kind: "fade", seconds: 0.5 },
      log: (l) => lines.push(l),
    });

    // The sting is 1.5 s; the sync card holds 3 s over its 1.5 s of
    // narration; the recap's second line comes 38 frames after its first.
    const plan = rendered.plan;
    expect(plan.pieces.map((p) => [p.kind, p.start])).toEqual([
      ["card", 0],
      ["clip", 1.5],
      ["card", 3.5],
      ["clip", 6.5],
      ["card", 8.5],
    ]);
    expect(plan.cards).toEqual([
      { start: 0, end: 1.5 },
      { start: 3.5, end: 6.5, step: 2, narration: 3.5 },
    ]);
    expect(plan.recap).toEqual({
      start: 8.5,
      end: 11.5,
      lines: [8.5, 8.5 + 38 / 30],
    });
    expect(voice.spoken).toEqual([
      "Open the list.",
      "The item is there.",
      "The notes sync in the background.",
      "Opened the list",
      "You synced your notes.",
    ]);
    expect(rendered.terminals).toEqual([]);
    expect(lines.some((l) => /card-1 card: \d+ frames drawn/.test(l))).toBe(
      true,
    );
    const video = await probeMedia(rendered.video);
    expect(Math.abs(video.duration! - 11.5)).toBeLessThan(0.05);

    // The sting animates from red to blue and holds; each jump dissolves
    // over half a second, and the terminal step shows only the card.
    const rgb = (t: number) => pixel(rendered.video, 1280, 640, t);
    const at = (t: number) => rgb(t).then(named);
    expect(await at(0.02)).toBe("red");
    expect(await at(1.3)).toBe("blue");
    const intoClip = await rgb(1.75);
    expect(intoClip[1]).toBeGreaterThan(30);
    expect(intoClip[2]).toBeGreaterThan(60);
    expect(await at(2.2)).toBe("green");
    expect(await at(3.4)).toBe("green");
    const intoCard = await rgb(3.75);
    expect(intoCard[0]).toBeGreaterThan(60);
    expect(intoCard[0]).toBeLessThan(200);
    expect(await at(4.2)).toBe("red");
    expect(await at(6.3)).toBe("red");
    expect(await at(7.2)).toBe("blue");

    // The recap shows its first line, then the second as it is spoken.
    const first = { x: 200, y: 690, width: 1400, height: 100 };
    const second = { x: 200, y: 810, width: 1400, height: 120 };
    expect(await brightest(rendered.video, first, 9.4)).toBeGreaterThan(200);
    expect(await brightest(rendered.video, second, 9.4)).toBeLessThan(60);
    expect(await brightest(rendered.video, second, 10.6)).toBeGreaterThan(200);

    const cues = parseVtt(await readFile(rendered.captions, "utf8"));
    const cue = (text: string) =>
      cues.find((c) => c.lines.join(" ") === text)?.start;
    expect(cue("The notes sync in the background.")).toBeCloseTo(3.5, 2);
    expect(cue("Opened the list")).toBeCloseTo(8.5, 2);
    expect(cue("You synced your notes.")).toBeCloseTo(8.5 + 38 / 30, 2);

    expect(rendered.media.chapters).toEqual([
      { start: 1.5, title: "Open" },
      { start: 3.5, title: "Sync" },
      { start: 6.5, title: "Check" },
      { start: 8.5, title: "Recap" },
    ]);
    expect(rendered.entry.chapters).toEqual([
      { start: 0, title: "Open" },
      { start: 3, title: "Sync" },
      { start: 6, title: "Check" },
      { start: 8, title: "Recap" },
    ]);
  }, 180_000);

  it("cuts a variable-frame-rate recording on the frame on screen, one held across a step boundary included", async () => {
    const record = join(dir, "vfr");
    const sidecar: Sidecar = {
      scenario: "Wait for it",
      id: "wait-for-it",
      title: "Wait for it",
      poster: { at: 2 },
    };
    await writeFakeRecording(
      record,
      [
        { keyword: "Given", text: "a list", color: "red", seconds: 1 },
        { keyword: "When", text: "I wait", color: "red", seconds: 1 },
        { keyword: "Then", text: "I see it", color: "blue", seconds: 1 },
      ],
      sidecar,
      { vfr: true },
    );
    // Two frames: red at 0, held through the hidden step and the next, and blue at 2.
    const { stdout } = await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      join(record, "video.webm"),
      "-map",
      "0:v",
      "-c",
      "copy",
      "-f",
      "framemd5",
      "-",
    ]);
    expect(stdout.split("\n").filter((l) => /^\s*0,/.test(l))).toHaveLength(2);
    const rendered = await renderRecording({
      recordDir: record,
      tts: sineVoice(),
      out: join(dir, "vfr-out"),
      threads: 2,
    });
    expect(rendered.plan.steps.get(2)).toEqual({ start: 0, end: 1 });
    const at = (t: number) => pixel(rendered.video, 1280, 640, t).then(named);
    expect(await at(0.1)).toBe("red");
    expect(await at(0.9)).toBe("red");
    expect(await at(1.5)).toBe("blue");
  }, 120_000);

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

describe("fitPoster", () => {
  let dir: string;
  let noisy: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "flax-poster-"));
    noisy = join(dir, "noisy.png");
    await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=2560x1440,noise=alls=40:allf=u",
      "-frames:v",
      "1",
      noisy,
    ]);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves a poster within the limit alone, redraws a larger one at 1920 by 1080, and makes a JPEG when that is still too large", async () => {
    const full = (await stat(noisy)).size;
    const kept = join(dir, "kept", "poster.png");
    await mkdir(join(dir, "kept"));
    await copyFile(noisy, kept);
    expect(await fitPoster(kept, { maxBytes: full })).toBe(kept);
    expect((await probeMedia(kept)).width).toBe(2560);

    const smaller = join(dir, "smaller", "poster.png");
    await mkdir(join(dir, "smaller"));
    await copyFile(noisy, smaller);
    expect(await fitPoster(smaller, { maxBytes: full - 1 })).toBe(smaller);
    const small = await probeMedia(smaller);
    expect([small.width, small.height]).toEqual([1920, 1080]);
    const png1920 = (await stat(smaller)).size;
    expect(await readdir(join(dir, "smaller"))).toEqual(["poster.png"]);

    const jpeg = join(dir, "jpeg", "poster.png");
    await mkdir(join(dir, "jpeg"));
    await copyFile(noisy, jpeg);
    const fitted = await fitPoster(jpeg, { maxBytes: png1920 - 1 });
    expect(fitted).toBe(join(dir, "jpeg", "poster.jpg"));
    expect(await readdir(join(dir, "jpeg"))).toEqual(["poster.jpg"]);
    expect((await stat(fitted)).size).toBeLessThan(png1920);
    expect((await probeMedia(fitted)).width).toBe(1920);
  }, 60_000);
});
