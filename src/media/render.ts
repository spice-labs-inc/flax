import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildCues, toVtt, type Word } from "./captions.ts";
import { RECORDINGS_ROOT_ENV, castPath, parseCast } from "./cast-file.ts";
import {
  FPS,
  chapterTimes,
  planEdit,
  posterStep,
  type Chapter,
  type EditOptions,
  type EditPlan,
  type Piece,
} from "./edit.ts";
import { writeManifest } from "./manifest.ts";
import {
  Painter,
  calloutHtml,
  captionHtml,
  cardHtml,
  posterHtml,
} from "./paint.ts";
import {
  CAPTION_BAND,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  boxInView,
  cameraFilter,
  cameraKeys,
  cameraView,
  mixAudio,
  sourceSize,
  stepBox,
  toPicture,
  zoomMoves,
  type BedLevels,
  type CameraKey,
  type Size,
  type Span,
} from "./production.ts";
import {
  hiddenSteps,
  highlightedSteps,
  readRecording,
  refuseFailed,
  resolveStep,
  terminalOverride,
  type Box,
  type CardContent,
  type Sidecar,
  type StepRef,
  type TerminalScene,
  type TimelineStep,
} from "./recording.ts";
import type { StandInRules } from "./stand-ins.ts";
import {
  drawTerminal,
  replayText,
  terminalReplay,
  type TerminalPace,
  type TerminalReplay,
} from "./terminal.ts";
import type { SceneAudio, Voice } from "./tts.ts";
import type { Log } from "./util.ts";

const run = promisify(execFile);

/** The ffmpeg binary ffmpeg-static installed. */
export function ffmpegPath(): string {
  const bundled = createRequire(import.meta.url)("ffmpeg-static") as
    string | null;
  if (!bundled)
    throw new Error("ffmpeg-static has no ffmpeg for this platform");
  return bundled;
}

/**
 * A card before or after the recording, beside or in place of the
 * sidecar's intro or outro: an image, or HTML drawn at the frame's size;
 * never shorter than its narration.
 */
export interface Card {
  /** A PNG or JPEG, fitted into the frame. */
  image?: string;
  /** A whole HTML document, drawn by Chromium at 2560 by 1440 (laid out at 1280 by 720). */
  html?: string;
  /** Default 3. */
  seconds?: number;
  /** Spoken over the card when the sidecar's intro or outro has no text. */
  narration?: string;
}

/** The caller's look and sound; flax ships none. */
export interface RenderAssets {
  /** CSS for the pictures Chromium draws (cards, captions, callouts, terminals, the poster): font faces and the --media-* properties of PAINT_DEFAULTS and TERMINAL_DEFAULTS. */
  css?: string;
  /** The color around a fitted picture and in the caption band, as ffmpeg takes it (black, 0x101828). Default black. */
  background?: string;
  titleCard?: Card;
  endCard?: Card;
  /** Draws the sidecar's intro or outro as a whole HTML document; default cardHtml. */
  cardHtml?: (card: CardContent, kind: "intro" | "outro") => string;
  /** A music bed under the whole video, looped to length and ducked under the narration. */
  music?: {
    file: string;
    /** Seconds into the track the bed starts. */
    offset?: number;
    levels?: BedLevels;
  };
  /** Draws the poster from the poster step's screen; default posterHtml when the sidecar's poster has a title or kicker, else the screen fitted into the frame. */
  poster?: (o: {
    screen: string;
    out: string;
    title: string;
    kicker?: string;
  }) => Promise<void>;
}

/** Production effects; each is off unless asked for. */
export interface Production {
  /** Zoom to each box the recorder highlighted on a highlighted step, and back out at the step's end. */
  zoom?:
    | boolean
    | {
        /** Default 2. */
        maxZoom?: number;
        /** Seconds a move takes. Default 0.8. */
        move?: number;
      };
  /** A label pointing at a box during a step: the box given (viewport CSS pixels), else the step's last highlighted, pointed or clicked box. */
  callouts?: { at: StepRef; text: string; box?: Box; seconds?: number }[];
}

/** The narration voice, or a function choosing one from the sidecar's `voice`. */
export type NarrationVoice =
  Voice | ((voice: string | undefined) => Voice | Promise<Voice>);

/** What renderRecording renders and how. */
export interface RenderRecordingOptions extends EditOptions {
  /** The record directory: video.webm, timeline.json, screens/, terminal/ and the sidecar copy. */
  recordDir: string;
  /** The sidecar; default the copy in the record directory. */
  sidecar?: Sidecar;
  tts: NarrationVoice;
  assets?: RenderAssets;
  production?: Production;
  /** The stand-in rules for what terminal scenes show (the set the sidecar's `standIns` names). */
  standIns?: StandInRules;
  /** How terminal scenes are paced (the sidecar's pace fills what this leaves out) and their font size in layout pixels. */
  terminal?: TerminalPace & { fontSize?: number };
  /** The directory video.mp4, captions.vtt, poster.png and media.json are written into. */
  out: string;
  /** Height of the band under the picture for captions; 0 lets the picture fill the frame. Default 160. */
  captionBand?: number;
  /** Draw the captions into the band too; captions.vtt is written either way. */
  burnCaptions?: boolean;
  /** Write media.json listing the three files. Default true. */
  manifest?: boolean;
  /** ffmpeg encoder threads; default all cores. */
  threads?: number;
  /** Keep the working files (audio, painted pictures, terminal frames) in out/.render. */
  keepWork?: boolean;
  log?: Log;
}

/** What a rendered recording is, as media.json's data carries it. */
export interface RecordingMedia {
  id: string;
  title: string;
  description?: string;
  scenario: string;
  duration: number;
  chapters: Chapter[];
  voice: string;
  posterStep: number;
  publish?: Record<string, unknown>;
}

/** Absolute paths of what renderRecording wrote, and the edit it made. */
export interface RenderedRecording {
  video: string;
  captions: string;
  poster: string;
  manifest?: string;
  media: RecordingMedia;
  plan: EditPlan;
  /** What each terminal scene shows, as plain text, by step. */
  terminals: { step: number; text: string }[];
}

/** A media file's length in seconds, frame size and whether it has sound, from ffmpeg's own reading of it. */
export async function probeMedia(file: string): Promise<{
  duration?: number;
  width?: number;
  height?: number;
  audio: boolean;
}> {
  let text = "";
  try {
    await run(ffmpegPath(), ["-hide_banner", "-i", file]);
  } catch (e) {
    text = String((e as { stderr?: string }).stderr ?? "");
  }
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const v = /Stream #\S+.*Video: .*?[ ,](\d{2,5})x(\d{2,5})[ ,[]/.exec(text);
  return {
    ...(d
      ? { duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) }
      : {}),
    ...(v ? { width: Number(v[1]), height: Number(v[2]) } : {}),
    audio: /Stream #\S+.*Audio: /.test(text),
  };
}

async function voiceFor(
  tts: NarrationVoice,
  voice: string | undefined,
): Promise<Voice> {
  return typeof tts === "function" ? await tts(voice) : tts;
}

/** Decodes an audio file to interleaved stereo float samples at `rate`. */
async function decodeStereo(
  file: string,
  rate: number,
  offset = 0,
): Promise<Float32Array> {
  const { stdout } = await run(
    ffmpegPath(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...(offset > 0 ? ["-ss", String(offset)] : []),
      "-i",
      file,
      "-f",
      "f32le",
      "-ac",
      "2",
      "-ar",
      String(rate),
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1 << 30 },
  );
  const copy = new Uint8Array(stdout.byteLength);
  copy.set(stdout);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

const fit = (size: Size, bg: string) =>
  `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
  `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1`;

/** The camera keys of one piece, its start at 0: where the camera is as it starts and ends, and every key between. */
function pieceKeys(
  keys: readonly CameraKey[],
  start: number,
  end: number,
  picture: Size,
): CameraKey[] {
  return [
    { t: 0, view: cameraView(keys, start, picture) },
    ...keys
      .filter((k) => k.t > start && k.t < end)
      .map((k) => ({ t: k.t - start, view: k.view })),
    { t: end - start, view: cameraView(keys, end, picture) },
  ];
}

/**
 * What a step's terminal scene replays: the sidecar's cast for it, else the
 * recorder's transcript (with the sidecar's display and preface), else the
 * recorder's cast; undefined for a step that ran no commands.
 */
async function stepTerminal(
  dir: string,
  steps: readonly TimelineStep[],
  sidecar: Sidecar,
  step: TimelineStep,
  o: { pace: TerminalPace; standIns?: StandInRules },
): Promise<TerminalReplay | undefined> {
  const override = terminalOverride(steps, sidecar, step.index);
  const common = {
    pace: o.pace,
    ...(override?.preface ? { preface: override.preface } : {}),
    ...(o.standIns ? { standIns: o.standIns } : {}),
  };
  if (override?.cast) {
    const file = castPath(override.cast, dir, process.env[RECORDINGS_ROOT_ENV]);
    return terminalReplay({
      ...common,
      cast: parseCast(await readFile(file, "utf8"), override.cast),
    });
  }
  if (step.terminal) {
    const {
      index: _index,
      display,
      preface,
      more,
      ...first
    } = JSON.parse(
      await readFile(join(dir, step.terminal), "utf8"),
    ) as TerminalScene;
    const shown = override?.display ?? display;
    const typed = override?.preface ?? preface;
    return terminalReplay({
      ...common,
      commands: [first, ...(more ?? [])],
      ...(shown ? { display: shown } : {}),
      ...(typed ? { preface: typed } : {}),
    });
  }
  const cast = join(dir, "terminal", `${step.index}.cast`);
  if (existsSync(cast))
    return terminalReplay({
      ...common,
      cast: parseCast(await readFile(cast, "utf8"), cast),
    });
  return undefined;
}

const QUIET = ["-hide_banner", "-loglevel", "error", "-y"];

/**
 * Renders a record run into video.mp4 (2560 by 1440, H.264 and AAC),
 * captions.vtt, poster.png and media.json in `out`: hidden steps cut, each
 * step that ran commands shown as a terminal scene, each narration block
 * from the sidecar spoken from its step with the picture holding its last
 * frame until the block is done, the intro and outro cards, the optional
 * music bed, zoom and callouts, and the captions from the voice's word
 * timing. Refuses a recording of a failed run.
 */
export async function renderRecording(
  opts: RenderRecordingOptions,
): Promise<RenderedRecording> {
  const log = opts.log ?? (() => undefined);
  const rec = await readRecording(opts.recordDir, opts.sidecar);
  refuseFailed(rec.timeline);
  const { timeline, sidecar } = rec;
  const steps = timeline.steps;
  const assets = opts.assets ?? {};
  const bg = assets.background ?? "black";
  const band = opts.captionBand ?? CAPTION_BAND;
  if (band < 0 || band >= FRAME_HEIGHT / 2)
    throw new Error(`captionBand ${band} is out of range`);
  if (opts.burnCaptions && band === 0)
    throw new Error("burnCaptions needs a caption band");
  const frame: Size = { width: FRAME_WIDTH, height: FRAME_HEIGHT };
  const picture: Size = { width: FRAME_WIDTH, height: FRAME_HEIGHT - band };
  const source = sourceSize(timeline);
  const scale = timeline.scale ?? 1;
  const fps = FPS;
  const work = join(opts.out, ".render");
  await mkdir(work, { recursive: true });
  const painter = new Painter();
  try {
    const voice = await voiceFor(opts.tts, sidecar.voice);
    const synth = async (text: string): Promise<SceneAudio> => {
      const a = await voice.synth(text);
      log(`  narration ${a.duration.toFixed(2)}s: ${text.slice(0, 60)}`);
      return a;
    };
    const cardSpec = (
      content: CardContent | undefined,
      card: Card | undefined,
    ) =>
      content || card
        ? {
            ...(content ? { content } : {}),
            ...(card ? { card } : {}),
            text: content?.text ?? card?.narration,
          }
        : undefined;
    const intro = cardSpec(sidecar.intro, assets.titleCard);
    const outro = cardSpec(sidecar.outro, assets.endCard);
    const introAudio = intro?.text ? await synth(intro.text) : undefined;
    const blocks = sidecar.narration ?? [];
    const audio: SceneAudio[] = [];
    for (const b of blocks) audio.push(await synth(b.text));
    const outroAudio = outro?.text ? await synth(outro.text) : undefined;

    const hidden = hiddenSteps(steps, sidecar);
    const pace: TerminalPace = {
      ...(sidecar.pace?.typeMsPerChar !== undefined
        ? { typeMsPerChar: sidecar.pace.typeMsPerChar }
        : {}),
      ...(sidecar.pace?.afterActionMs !== undefined
        ? { afterActionMs: sidecar.pace.afterActionMs }
        : {}),
      ...(sidecar.pace?.readMs !== undefined
        ? { readMs: sidecar.pace.readMs }
        : {}),
      ...opts.terminal,
    };
    const replays = new Map<number, TerminalReplay>();
    for (const step of steps) {
      if (hidden.has(step.index)) continue;
      const replay = await stepTerminal(rec.dir, steps, sidecar, step, {
        pace,
        ...(opts.standIns ? { standIns: opts.standIns } : {}),
      });
      if (replay) replays.set(step.index, replay);
    }

    const cardTime = (
      c: ReturnType<typeof cardSpec>,
      a: SceneAudio | undefined,
    ) =>
      c
        ? {
            seconds: c.card?.seconds ?? 3,
            ...(a ? { narration: a.duration } : {}),
          }
        : undefined;
    const titleCard = cardTime(intro, introAudio);
    const endCard = cardTime(outro, outroAudio);
    const plan = planEdit(
      {
        steps,
        hidden,
        narration: blocks.map((b, i) => ({
          step: resolveStep(steps, b.at).index,
          seconds: audio[i]!.duration,
        })),
        terminals: new Map(
          [...replays].map(([index, r]) => [index, r.duration]),
        ),
        ...(titleCard ? { titleCard } : {}),
        ...(endCard ? { endCard } : {}),
      },
      opts,
      fps,
    );
    log(
      `edit: ${plan.scenes.length} scenes, ${replays.size} terminal scenes, ` +
        `${[...hidden].filter((i) => i > 0).length} hidden steps cut, ${plan.duration.toFixed(2)}s, ` +
        `${plan.scenes.reduce((n, s) => n + s.hold, 0).toFixed(2)}s held`,
    );

    // Narration and its words on the output timeline.
    const placed: { audio: SceneAudio; start: number }[] = [
      ...(introAudio && plan.titleCard?.narration !== undefined
        ? [{ audio: introAudio, start: plan.titleCard.narration }]
        : []),
      ...audio.map((a, i) => ({ audio: a, start: plan.narration[i]! })),
      ...(outroAudio && plan.endCard?.narration !== undefined
        ? [{ audio: outroAudio, start: plan.endCard.narration }]
        : []),
    ];
    const rate = placed[0]?.audio.sampleRate ?? 24000;
    const narration = new Float32Array(Math.ceil(plan.duration * rate));
    const words: Word[] = [];
    const speech: Span[] = [];
    for (const p of placed) {
      if (p.audio.sampleRate !== rate)
        throw new Error(
          `narration sample rate ${p.audio.sampleRate} differs from ${rate}`,
        );
      const at = Math.round(p.start * rate);
      narration.set(
        p.audio.pcm.subarray(0, Math.max(0, narration.length - at)),
        at,
      );
      for (const w of p.audio.words)
        words.push({
          text: w.text,
          start: w.start + p.start,
          end: w.end + p.start,
        });
      speech.push({ start: p.start, end: p.start + p.audio.duration });
    }
    const bed = assets.music
      ? {
          pcm: await decodeStereo(assets.music.file, rate, assets.music.offset),
          speech,
          ...(assets.music.levels ? { levels: assets.music.levels } : {}),
        }
      : undefined;
    const mixed = mixAudio(narration, rate, bed);
    const audioFile = join(work, "audio.f32");
    await writeFile(
      audioFile,
      new Uint8Array(mixed.buffer, mixed.byteOffset, mixed.byteLength),
    );

    const cues = buildCues(words);
    const captions = join(opts.out, "captions.vtt");
    await writeFile(captions, toVtt(cues));

    // Camera and callouts.
    const zoom = opts.production?.zoom;
    const keys = zoom
      ? cameraKeys(
          zoomMoves(
            steps,
            highlightedSteps(steps, sidecar),
            plan,
            source,
            picture,
          ),
          picture,
          typeof zoom === "object" ? zoom : {},
        )
      : [];
    const overlays: { file: string; y: number; start: number; end: number }[] =
      [];
    for (const [i, c] of (opts.production?.callouts ?? []).entries()) {
      const step = resolveStep(steps, c.at);
      const time = plan.steps.get(step.index);
      if (!time)
        throw new Error(`callout "${c.text}" is on hidden step ${step.index}`);
      const box = c.box
        ? {
            x: c.box.x * scale,
            y: c.box.y * scale,
            width: c.box.width * scale,
            height: c.box.height * scale,
          }
        : stepBox(step, ["highlight", "point", "click", "type"]);
      if (!box)
        throw new Error(
          `callout "${c.text}": step ${step.index} has no box to point at; give one`,
        );
      const start = time.start + Math.min(0.3, (time.end - time.start) / 4);
      const end = c.seconds
        ? Math.min(plan.duration, start + c.seconds)
        : time.end;
      const inPicture = toPicture(box, source, picture);
      const shown =
        keys.length > 0
          ? boxInView(inPicture, cameraView(keys, start, picture), picture)
          : inPicture;
      const file = await painter.paint(
        calloutHtml(shown, c.text, picture, assets.css),
        picture,
        join(work, `callout-${i}.png`),
      );
      overlays.push({ file, y: 0, start, end });
    }
    if (opts.burnCaptions)
      for (const [i, cue] of cues.entries()) {
        const file = await painter.paint(
          captionHtml(
            cue.lines,
            { width: FRAME_WIDTH, height: band },
            assets.css,
          ),
          { width: FRAME_WIDTH, height: band },
          join(work, `cue-${String(i).padStart(4, "0")}.png`),
        );
        overlays.push({
          file,
          y: picture.height,
          start: cue.start,
          end: cue.end,
        });
      }

    const cardImage = async (
      c: NonNullable<ReturnType<typeof cardSpec>>,
      kind: "intro" | "outro",
    ): Promise<string> => {
      if (c.card?.image) return c.card.image;
      const html =
        c.card?.html ??
        (c.content
          ? (assets.cardHtml?.(c.content, kind) ??
            cardHtml(c.content, frame, assets.css))
          : undefined);
      if (html === undefined)
        throw new Error(`the ${kind} card has neither an image nor html`);
      return painter.paint(html, frame, join(work, `${kind}.png`));
    };
    const cardFiles = {
      title: intro ? await cardImage(intro, "intro") : undefined,
      end: outro ? await cardImage(outro, "outro") : undefined,
    };

    // Terminal scenes, drawn frame by frame at their planned length.
    const terminalLists = new Map<number, string>();
    const terminalLast = new Map<number, string>();
    for (const p of plan.pieces) {
      if (p.kind !== "terminal") continue;
      const dir = join(work, `terminal-${p.step}`);
      const drawn = await drawTerminal(painter, replays.get(p.step)!, {
        size: picture,
        frames: p.frames,
        fps,
        dir,
        ...(assets.css ? { css: assets.css } : {}),
        ...(opts.terminal?.fontSize
          ? { fontSize: opts.terminal.fontSize }
          : {}),
      });
      log(`  terminal scene for step ${p.step}: ${drawn.shots} frames drawn`);
      terminalLists.set(p.step, drawn.list);
      terminalLast.set(p.step, drawn.last);
    }

    // A still for a stretch with no raw video: its last step's screen.
    const stillFor = (p: Extract<Piece, { kind: "clip" }>) =>
      steps
        .filter(
          (s) =>
            !hidden.has(s.index) &&
            !replays.has(s.index) &&
            s.screen &&
            (s.startMs ?? 0) / 1000 >= p.srcStart - 0.002 &&
            (s.endMs ?? 0) / 1000 <= p.srcEnd + 0.002,
        )
        .at(-1)?.screen;

    // The filter graph: one input and chain per piece, each a full frame, then
    // concatenated, overlaid and encoded against the mixed audio.
    const inputs: string[] = [];
    const chains: string[] = [];
    const labels: string[] = [];
    let n = 0;
    const merged: { piece: Exclude<Piece, { kind: "hold" }>; hold: number }[] =
      [];
    for (const p of plan.pieces) {
      if (p.kind === "hold") merged.at(-1)!.hold += p.frames;
      else merged.push({ piece: p, hold: 0 });
    }
    const stillInput = (file: string | undefined, seconds: number) =>
      file
        ? [
            "-loop",
            "1",
            "-framerate",
            String(fps),
            "-t",
            seconds.toFixed(3),
            "-i",
            file,
          ]
        : [
            "-f",
            "lavfi",
            "-i",
            `color=c=${bg}:s=${source.width}x${source.height}:r=${fps}:d=${seconds.toFixed(3)}`,
          ];
    for (const { piece, hold } of merged) {
      const label = `p${labels.length}`;
      const total = piece.frames + hold;
      if (piece.kind === "card") {
        const file = cardFiles[piece.card]!;
        inputs.push(...stillInput(file, total / fps + 1));
        chains.push(
          `[${n}:v]fps=${fps},${fit(frame, bg)},trim=end_frame=${total},setpts=PTS-STARTPTS[${label}]`,
        );
      } else {
        let lead = "";
        if (piece.kind === "terminal") {
          inputs.push(
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            terminalLists.get(piece.step)!,
          );
        } else if (rec.video) {
          const length = piece.srcEnd - piece.srcStart;
          inputs.push(
            "-ss",
            piece.srcStart.toFixed(3),
            "-t",
            (length + 0.25).toFixed(3),
            "-i",
            rec.video,
          );
          lead = `setpts=(PTS-STARTPTS)/${piece.speed.toFixed(6)},`;
        } else {
          const still = stillFor(piece);
          inputs.push(
            ...stillInput(
              still ? join(rec.dir, still) : undefined,
              total / fps + 1,
            ),
          );
        }
        const start = piece.start;
        const end = start + total / fps;
        const camera =
          keys.length > 0 && piece.kind === "clip"
            ? cameraFilter(pieceKeys(keys, start, end, picture), picture, fps)
            : undefined;
        chains.push(
          `[${n}:v]${lead}fps=${fps},${fit(picture, bg)},` +
            `trim=end_frame=${piece.frames},tpad=stop_mode=clone:stop=${hold + fps},trim=end_frame=${total},setpts=PTS-STARTPTS` +
            (camera ? `,${camera}` : "") +
            (band > 0
              ? `,pad=${FRAME_WIDTH}:${FRAME_HEIGHT}:0:0:color=${bg}`
              : "") +
            `[${label}]`,
        );
      }
      labels.push(label);
      n++;
    }
    chains.push(
      `${labels.map((l) => `[${l}]`).join("")}concat=n=${labels.length}:v=1:a=0[v0]`,
    );
    let last = "v0";
    overlays.forEach((o, i) => {
      inputs.push("-loop", "1", "-framerate", String(fps), "-i", o.file);
      const next = `v${i + 1}`;
      chains.push(
        `[${last}][${n}:v]overlay=0:${o.y}:shortest=1:enable='between(t,${o.start.toFixed(3)},${o.end.toFixed(3)})'[${next}]`,
      );
      last = next;
      n++;
    });
    chains.push(`[${last}]format=yuv420p[final]`);
    inputs.push(
      "-f",
      "f32le",
      "-ar",
      String(rate),
      "-ac",
      "2",
      "-i",
      audioFile,
    );
    const audioInput = n;
    const video = join(opts.out, "video.mp4");
    const graph = join(work, "graph.txt");
    await writeFile(graph, chains.join(";\n"));
    log(`encoding ${merged.length} pieces and ${overlays.length} overlays`);
    // ffmpeg's version and encoder tags stay out of the file, so a re-encode of the same input is byte-stable.
    await run(
      ffmpegPath(),
      [
        ...QUIET,
        ...inputs,
        "-filter_complex_script",
        graph,
        "-map",
        "[final]",
        "-map",
        `${audioInput}:a`,
        ...(opts.threads ? ["-threads", String(opts.threads)] : []),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-r",
        String(fps),
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-t",
        plan.duration.toFixed(3),
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-flags:a",
        "+bitexact",
        "-movflags",
        "+faststart",
        video,
      ],
      { maxBuffer: 1 << 26 },
    );

    // The poster: the poster step's terminal scene's last frame, its screen,
    // or its last frame from the raw video.
    const pstep = posterStep(steps, sidecar);
    let screen =
      terminalLast.get(pstep.index) ??
      (pstep.screen ? join(rec.dir, pstep.screen) : undefined);
    if (!screen) {
      if (!rec.video)
        throw new Error(
          `poster step ${pstep.index} has no screen and the recording no video`,
        );
      screen = join(work, "poster-frame.png");
      await run(ffmpegPath(), [
        ...QUIET,
        "-ss",
        Math.max(0, (pstep.endMs ?? 0) / 1000 - 0.05).toFixed(3),
        "-i",
        rec.video,
        "-frames:v",
        "1",
        screen,
      ]);
    }
    const poster = join(opts.out, "poster.png");
    const posterTitle = sidecar.poster?.title ?? sidecar.title;
    const kicker = sidecar.poster?.kicker;
    if (assets.poster)
      await assets.poster({
        screen,
        out: poster,
        title: posterTitle,
        ...(kicker ? { kicker } : {}),
      });
    else if (sidecar.poster?.title || kicker) {
      const data = `data:image/png;base64,${(await readFile(screen)).toString("base64")}`;
      await painter.paint(
        posterHtml(
          { screen: data, title: posterTitle, ...(kicker ? { kicker } : {}) },
          frame,
          assets.css,
        ),
        frame,
        poster,
      );
    } else
      await run(ffmpegPath(), [
        ...QUIET,
        "-i",
        screen,
        "-vf",
        fit(frame, bg),
        "-frames:v",
        "1",
        "-fflags",
        "+bitexact",
        poster,
      ]);

    const chapters = [
      ...(sidecar.intro?.chapter && plan.titleCard
        ? [{ start: plan.titleCard.start, title: sidecar.intro.chapter }]
        : []),
      ...chapterTimes(sidecar.chapters ?? [], steps, hidden, plan),
      ...(sidecar.outro?.chapter && plan.endCard
        ? [{ start: plan.endCard.start, title: sidecar.outro.chapter }]
        : []),
    ].sort((a, b) => a.start - b.start);
    const media: RecordingMedia = {
      id: sidecar.id,
      title: sidecar.title,
      ...(sidecar.description ? { description: sidecar.description } : {}),
      scenario: timeline.scenario,
      duration: plan.duration,
      chapters,
      voice: voice.name,
      posterStep: pstep.index,
      ...(sidecar.publish ? { publish: sidecar.publish } : {}),
    };
    let manifest: string | undefined;
    if (opts.manifest ?? true) {
      await writeManifest(
        opts.out,
        ["video.mp4", "captions.vtt", "poster.png"],
        media,
      );
      manifest = join(opts.out, "media.json");
    }
    return {
      video,
      captions,
      poster,
      ...(manifest ? { manifest } : {}),
      media,
      plan,
      terminals: [...replays].map(([step, r]) => ({
        step,
        text: replayText(r),
      })),
    };
  } finally {
    await painter.close();
    if (!opts.keepWork) await rm(work, { recursive: true, force: true });
  }
}
