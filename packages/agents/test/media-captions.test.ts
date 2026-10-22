import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCues,
  timelineWords,
  toVtt,
  vttTime,
  type Word,
} from "../src/media/captions.ts";
import {
  alignWords,
  elevenLabsVoice,
  pronouncer,
  spoken,
  workspacePronunciations,
} from "../src/media/tts.ts";

/** Words of `text`, each `step` seconds long, starting at `at`. */
function words(text: string, at = 0, step = 0.3): Word[] {
  return text.split(" ").map((w, i) => ({
    text: w,
    start: at + i * step,
    end: at + (i + 1) * step,
  }));
}

describe("captions", () => {
  it("close a cue at the end of a sentence", () => {
    const cues = buildCues(words("One two three. Four five six."));
    expect(cues.map((c) => c.lines)).toEqual([
      ["One two three."],
      ["Four five six."],
    ]);
    expect(cues[0]!.start).toBe(0);
    expect(cues[1]!.start).toBeCloseTo(0.9);
  });

  it("keep cues to two lines of 60 characters and six seconds", () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    for (const cue of buildCues(words(long, 0, 0.25))) {
      expect(cue.lines.length).toBeLessThanOrEqual(2);
      for (const line of cue.lines) expect(line.length).toBeLessThanOrEqual(60);
      expect(cue.end - cue.start).toBeLessThanOrEqual(6);
    }
  });

  it("hold a short cue for a second unless the next one starts first", () => {
    const cues = buildCues([
      { text: "Hi.", start: 0, end: 0.2 },
      { text: "Next.", start: 0.5, end: 0.8 },
      { text: "Last.", start: 5, end: 5.1 },
    ]);
    expect(cues[0]!.end).toBeCloseTo(0.45);
    expect(cues[1]!.end).toBeCloseTo(1.5);
    expect(cues[2]!.end).toBeCloseTo(6);
  });

  it("are written as WebVTT", () => {
    expect(vttTime(3723.0456)).toBe("01:02:03.046");
    expect(toVtt([{ start: 1, end: 2.5, lines: ["a", "b"] }])).toBe(
      "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\na\nb\n",
    );
  });

  it("place each scene's words at the scene's start", () => {
    const placed = timelineWords(
      [
        { id: "a", start: 0 },
        { id: "b", start: 10 },
      ],
      new Map([["b", [{ text: "x", start: 1, end: 2 }]]]),
    );
    expect(placed).toEqual([{ text: "x", start: 11, end: 12 }]);
  });
});

describe("narration timing", () => {
  const say = pronouncer({
    PQC: "P Q C",
    "docs.notes-co.example": "docs dot notes labs dot I O",
  });

  it("speaks the hints on word boundaries, longest first", () => {
    expect(say("The PQC report, on docs.notes-co.example.")).toBe(
      "The P Q C report, on docs dot notes labs dot I O.",
    );
    expect(say("PQCs")).toBe("PQCs");
  });

  it("times each written word from the spoken words it became", () => {
    const spoken = "the P Q C report";
    const chars = [...spoken];
    const alignment = {
      characters: chars,
      character_start_times_seconds: chars.map((_, i) => i * 0.1),
      character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
    };
    const timed = alignWords("the PQC report", alignment, 2, say);
    expect(timed.map((w) => w.text)).toEqual(["the", "PQC", "report"]);
    expect(timed[1]!.start).toBeCloseTo(0.4);
    expect(timed[1]!.end).toBeCloseTo(0.9);
    expect(timed[2]!.end).toBeCloseTo(1.6);
  });
});

describe("the brand pronunciations", () => {
  it("spells out IT, OT and the signature algorithms, and leaves words that contain them alone", () => {
    expect(spoken("Survey IT Pro and OT Pro")).toBe(
      "Survey I T Pro and O T Pro",
    );
    expect(spoken("ECDSA, or SLH-DSA")).toBe("E C D S A, or S L H D S A");
    expect(spoken("ITEM and it")).toBe("ITEM and it");
  });
});

describe("pronunciations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("are none, not an error, when the workspace has no pronunciations file", () => {
    const dir = mkdtempSync(join(tmpdir(), "flax-no-brand-"));
    try {
      expect(workspacePronunciations(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("given to elevenLabsVoice are what it asks the voice to say, and the captions keep the written words", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    const bodies: { text: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/voices"))
          return Response.json({
            voices: [{ voice_id: "v1", name: "Narrator - calm" }],
          });
        const body = JSON.parse(String(init!.body)) as { text: string };
        bodies.push(body);
        const chars = [...body.text];
        return Response.json({
          audio_base64: Buffer.alloc(4800).toString("base64"),
          alignment: {
            characters: chars,
            character_start_times_seconds: chars.map((_, i) => i * 0.05),
            character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.05),
          },
        });
      }),
    );
    const voice = await elevenLabsVoice("narrator", undefined, undefined, {
      pronunciations: { SQL: "sequel", IT: "eye tee" },
    });
    const audio = await voice.synth("Run SQL for IT now");
    expect(bodies[0]!.text).toBe("Run sequel for eye tee now");
    expect(audio.words.map((w) => w.text)).toEqual([
      "Run",
      "SQL",
      "for",
      "IT",
      "now",
    ]);
    expect(audio.words[3]!.end).toBeCloseTo(1.1);
  });
});
