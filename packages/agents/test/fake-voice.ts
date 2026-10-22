import type { Word } from "../src/media/captions.ts";
import type { SceneAudio, Voice } from "../src/media/tts.ts";

/** A voice that says every word as a short sine tone: `secondsPerWord` each, word timing included. */
export function sineVoice(
  o: {
    secondsPerWord?: number;
    sampleRate?: number;
    frequency?: number;
    name?: string;
  } = {},
): Voice & { spoken: string[] } {
  const per = o.secondsPerWord ?? 0.3;
  const rate = o.sampleRate ?? 24000;
  const hz = o.frequency ?? 440;
  const spoken: string[] = [];
  return {
    name: o.name ?? "sine",
    spoken,
    async synth(text: string): Promise<SceneAudio> {
      spoken.push(text);
      const tokens = text.split(/\s+/).filter(Boolean);
      const duration = tokens.length * per;
      const pcm = new Float32Array(Math.round(duration * rate));
      for (let i = 0; i < pcm.length; i++)
        pcm[i] = 0.2 * Math.sin((2 * Math.PI * hz * i) / rate);
      const words: Word[] = tokens.map((t, i) => ({
        text: t,
        start: i * per,
        end: (i + 1) * per - 0.05,
      }));
      return { pcm, sampleRate: rate, duration, words };
    },
  };
}
