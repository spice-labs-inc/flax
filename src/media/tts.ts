import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Word } from "./captions.ts";
import { MEDIA_ROOT, sleep } from "./util.ts";

/** One scene's narration: mono float PCM and its word timing. */
export interface SceneAudio {
  pcm: Float32Array;
  sampleRate: number;
  duration: number;
  words: Word[];
}

/** A text-to-speech voice. */
export interface Voice {
  name: string;
  synth(text: string): Promise<SceneAudio>;
}

/**
 * ElevenLabs voice settings for one voice, as its API names them; each
 * left out keeps the voice's own setting.
 */
export interface VoiceSettings {
  /** 0 to 1: lower is more expressive, higher more even. */
  stability?: number;
  /** 0 to 1: how closely the voice keeps to the original. */
  similarity_boost?: number;
  /** 0 to 1: how much of the speaker's style is exaggerated. */
  style?: number;
  use_speaker_boost?: boolean;
  /** 0.7 to 1.2: speaking rate. */
  speed?: number;
}

/** The text-to-speech request body: the spoken form of `written`, the model, and the voice settings when given. */
export function speechRequest(
  written: string,
  modelId: string,
  settings?: VoiceSettings,
): { text: string; model_id: string; voice_settings?: VoiceSettings } {
  return {
    text: spoken(written),
    model_id: modelId,
    ...(settings === undefined || Object.keys(settings).length === 0
      ? {}
      : { voice_settings: { ...settings } }),
  };
}

/** The ElevenLabs API key. */
export const ELEVENLABS_KEY_ENV = "ELEVENLABS_API_KEY";
const ELEVENLABS = "https://api.elevenlabs.io/v1";
const SAMPLE_RATE = 24000;

/**
 * What the voice says for a written token (brand/pronunciations.json):
 * longest keys first, on word boundaries, case-sensitively. Captions keep
 * the written text.
 */
export function pronouncer(
  hints: Record<string, string>,
): (text: string) => string {
  const rules = Object.entries(hints)
    .sort((a, b) => b[0].length - a[0].length)
    .map(
      ([k, v]) =>
        [
          new RegExp(
            `(^|[^A-Za-z0-9])${k.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?=$|[^A-Za-z0-9])`,
            "g",
          ),
          v,
        ] as const,
    );
  return (text) => rules.reduce((s, [re, v]) => s.replace(re, `$1${v}`), text);
}

let brandPronouncer: ((text: string) => string) | undefined;

/** The spoken form of `text` under the brand's pronunciation hints. */
export function spoken(text: string): string {
  brandPronouncer ??= pronouncer(
    JSON.parse(
      readFileSync(join(MEDIA_ROOT, "brand", "pronunciations.json"), "utf8"),
    ) as Record<string, string>,
  );
  return brandPronouncer(text);
}

/** ElevenLabs' per-character timing of the spoken text. */
export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/**
 * Times the written words from the alignment of their spoken form: each
 * written token takes as many spoken words as its pronunciation has.
 */
export function alignWords(
  written: string,
  alignment: Alignment,
  duration: number,
  say: (text: string) => string = spoken,
): Word[] {
  const spokenWords: Word[] = [];
  let current: Word | undefined;
  alignment.characters.forEach((ch, i) => {
    const s = alignment.character_start_times_seconds[i] ?? 0;
    const e = alignment.character_end_times_seconds[i] ?? s;
    if (/\s/.test(ch)) {
      if (current) spokenWords.push(current);
      current = undefined;
    } else if (current) {
      current.text += ch;
      current.end = e;
    } else {
      current = { text: ch, start: s, end: e };
    }
  });
  if (current) spokenWords.push(current);
  const words: Word[] = [];
  let at = 0;
  for (const token of written.split(" ").filter(Boolean)) {
    const n = Math.max(1, say(token).split(/\s+/).filter(Boolean).length);
    const slice = spokenWords.slice(at, at + n);
    at += n;
    const first = slice[0];
    const last = slice.at(-1);
    if (first && last)
      words.push({ text: token, start: first.start, end: last.end });
    else
      words.push({
        text: token,
        start: words.at(-1)?.end ?? duration,
        end: duration,
      });
  }
  return words;
}

/** The ElevenLabs key from ELEVENLABS_API_KEY. */
export function elevenLabsKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[ELEVENLABS_KEY_ENV];
  if (!key) throw new Error(`${ELEVENLABS_KEY_ENV} must be set`);
  return key;
}

const BUSY_TRIES = 6;

/**
 * Asks again while ElevenLabs answers busy (429, too many concurrent
 * requests, as parts narrating at once can be) or fails on its side (5xx),
 * waiting as Retry-After says or longer each time.
 */
export async function busyRetry(
  ask: () => Promise<Response>,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await ask();
    if (attempt >= BUSY_TRIES || (res.status !== 429 && res.status < 500))
      return res;
    const after = Number(res.headers.get("retry-after"));
    await res.body?.cancel();
    await wait(
      Number.isFinite(after) && after > 0 ? after * 1000 : 5000 * attempt,
    );
  }
}

/**
 * An ElevenLabs voice with character alignment, for word-timed captions.
 * `voiceName` is a name in the account's voice library or a voice id; the
 * model defaults to Eleven v4; `settings` tunes the voice for every line.
 */
export async function elevenLabsVoice(
  voiceName: string,
  modelId = "eleven_v4",
  settings?: VoiceSettings,
): Promise<Voice> {
  const key = elevenLabsKey();
  const list = await fetch(`${ELEVENLABS}/voices`, {
    headers: { "xi-api-key": key },
  });
  if (!list.ok)
    throw new Error(
      `ElevenLabs voices HTTP ${list.status}: ${await list.text()}`,
    );
  const { voices } = (await list.json()) as {
    voices: { voice_id: string; name: string }[];
  };
  const short = (name: string) => (name.split(" - ")[0] ?? name).trim();
  const voice =
    voices.find(
      (v) => short(v.name).toLowerCase() === voiceName.toLowerCase(),
    ) ??
    voices.find((v) => v.voice_id === voiceName) ??
    (/^[A-Za-z0-9]{20}$/.test(voiceName)
      ? { voice_id: voiceName, name: `library-${voiceName}` }
      : undefined);
  if (!voice) throw new Error(`no ElevenLabs voice named ${voiceName}`);
  return {
    name: `elevenlabs/${short(voice.name)}/${modelId}`,
    async synth(text) {
      const written = text.replace(/\s+/g, " ").trim();
      const res = await busyRetry(() =>
        fetch(
          `${ELEVENLABS}/text-to-speech/${voice.voice_id}/with-timestamps?output_format=pcm_${SAMPLE_RATE}`,
          {
            method: "POST",
            headers: { "xi-api-key": key, "content-type": "application/json" },
            body: JSON.stringify(speechRequest(written, modelId, settings)),
          },
        ),
      );
      if (!res.ok)
        throw new Error(`ElevenLabs HTTP ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as {
        audio_base64: string;
        alignment: Alignment;
      };
      const raw = Buffer.from(body.audio_base64, "base64");
      const pcm = new Float32Array(Math.floor(raw.length / 2));
      for (let i = 0; i < pcm.length; i++)
        pcm[i] = raw.readInt16LE(i * 2) / 32768;
      const duration = pcm.length / SAMPLE_RATE;
      return {
        pcm,
        sampleRate: SAMPLE_RATE,
        duration,
        words: alignWords(written, body.alignment, duration),
      };
    },
  };
}

/** 16-bit mono PCM WAV bytes. */
export function pcmToWav(pcm: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(pcm.length * 2);
  pcm.forEach((x, i) => {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x)) * 32767), i * 2);
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Writes `pcm` as a WAV file, making its directory. */
export async function writeWav(
  file: string,
  pcm: Float32Array,
  sampleRate: number,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, pcmToWav(pcm, sampleRate));
}
