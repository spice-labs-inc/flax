import { describe, expect, it } from "vitest";
import {
  chapterTimes,
  outputTime,
  planEdit,
  posterStep,
  youtubeChapters,
} from "../src/media/edit.ts";
import {
  boxInView,
  cameraKeys,
  cameraView,
  fitRect,
  mixAudio,
  sourceSize,
  toPicture,
  zoomMoves,
} from "../src/media/production.ts";
import {
  hiddenSteps,
  highlightedSteps,
  recordingProblem,
  refuseFailed,
  resolveStep,
  type Timeline,
  type TimelineStep,
} from "../src/media/recording.ts";
import {
  compileStandIns,
  standInScript,
  standInText,
  standInValue,
} from "../src/media/stand-ins.ts";
import {
  frameWrites,
  PROMPT,
  speedUpReplay,
  terminalReplay,
} from "../src/media/terminal.ts";
import { parseCast } from "../src/media/cast-file.ts";

/** Steps of `seconds` each, back to back, all passed. */
function steps(...specs: [keyword: string, seconds: number][]): TimelineStep[] {
  let at = 0;
  return specs.map(([keyword, seconds], i) => {
    const s: TimelineStep = {
      index: i + 1,
      keyword,
      text: `step ${i + 1}`,
      startMs: at * 1000,
      endMs: (at + seconds) * 1000,
      status: "passed",
    };
    at += seconds;
    return s;
  });
}

describe("planEdit", () => {
  it("cuts hidden steps and plays the rest at their own pace", () => {
    const s = steps(["Given", 2], ["When", 3], ["Then", 1]);
    const plan = planEdit({ steps: s, hidden: new Set([1]), narration: [] });
    expect(plan.pieces).toEqual([
      { kind: "clip", srcStart: 2, srcEnd: 6, speed: 1, start: 0, frames: 120 },
    ]);
    expect(plan.duration).toBe(4);
    expect(plan.steps.get(1)).toBeUndefined();
    expect(plan.steps.get(2)).toEqual({ start: 0, end: 3 });
    expect(plan.steps.get(3)).toEqual({ start: 3, end: 4 });
  });

  it("makes a cut where a hidden step sits between visible ones", () => {
    const s = steps(["When", 1], ["Given", 5], ["Then", 1]);
    const plan = planEdit({ steps: s, hidden: new Set([2]), narration: [] });
    expect(
      plan.pieces.map(
        (p) => p.kind === "clip" && [p.srcStart, p.srcEnd, p.start],
      ),
    ).toEqual([
      [0, 1, 0],
      [6, 7, 1],
    ]);
    expect(plan.duration).toBe(2);
  });

  it("holds a scene's last frame until its narration and tail are done", () => {
    const s = steps(["When", 2], ["Then", 2]);
    const plan = planEdit(
      {
        steps: s,
        hidden: new Set(),
        narration: [
          { step: 1, seconds: 3.5 },
          { step: 2, seconds: 1 },
        ],
      },
      { tail: 0.5 },
    );
    expect(plan.scenes.map((x) => [x.start, x.end, x.hold])).toEqual([
      [0, 4, 2],
      [4, 6, 0],
    ]);
    expect(plan.pieces.map((p) => p.kind)).toEqual(["clip", "hold", "clip"]);
    expect(plan.pieces[1]).toMatchObject({
      kind: "hold",
      at: 2,
      start: 2,
      frames: 60,
    });
    expect(plan.narration).toEqual([0, 4]);
    expect(plan.steps.get(1)).toEqual({ start: 0, end: 4 });
  });

  it("never speeds a long scene up unless maxSpeed allows it", () => {
    const s = steps(["When", 6]);
    const narration = [{ step: 1, seconds: 2 }];
    const slow = planEdit(
      { steps: s, hidden: new Set(), narration },
      { tail: 1 },
    );
    expect(slow.duration).toBe(6);
    expect(slow.scenes[0]!.speed).toBe(1);
    const fast = planEdit(
      { steps: s, hidden: new Set(), narration },
      { tail: 1, maxSpeed: 1.5 },
    );
    expect(fast.scenes[0]!.speed).toBe(1.5);
    expect(fast.duration).toBe(4);
    const fits = planEdit(
      { steps: s, hidden: new Set(), narration },
      { tail: 1, maxSpeed: 4 },
    );
    expect(fits.scenes[0]!.speed).toBe(2);
    expect(fits.duration).toBe(3);
  });

  it("starts each block after the lead-in", () => {
    const s = steps(["When", 1], ["Then", 1]);
    const plan = planEdit(
      { steps: s, hidden: new Set(), narration: [{ step: 2, seconds: 1 }] },
      { leadIn: 0.2, tail: 0 },
    );
    expect(plan.narration).toEqual([1.2]);
    expect(plan.scenes.at(-1)!.hold).toBeCloseTo(0.2);
  });

  it("moves a block on a hidden step to the next visible one", () => {
    const s = steps(["Given", 1], ["When", 1]);
    const plan = planEdit({
      steps: s,
      hidden: new Set([1]),
      narration: [{ step: 1, seconds: 0.5 }],
    });
    expect(plan.scenes[0]!.narration).toBe(0);
    expect(plan.narration).toEqual([0]);
  });

  it("refuses two blocks on one step, a block after the last visible step and an all-hidden scenario", () => {
    const s = steps(["When", 1], ["Given", 1]);
    expect(() =>
      planEdit({
        steps: s,
        hidden: new Set(),
        narration: [
          { step: 1, seconds: 1 },
          { step: 1, seconds: 1 },
        ],
      }),
    ).toThrow(/both start at step 1/);
    expect(() =>
      planEdit({
        steps: s,
        hidden: new Set([2]),
        narration: [{ step: 2, seconds: 1 }],
      }),
    ).toThrow(/no visible step/);
    expect(() =>
      planEdit({ steps: s, hidden: new Set([1, 2]), narration: [] }),
    ).toThrow(/every step is hidden/);
  });

  it("places cards around the recording, long enough for their narration", () => {
    const s = steps(["When", 2]);
    const plan = planEdit(
      {
        steps: s,
        hidden: new Set(),
        narration: [],
        titleCard: { seconds: 2, narration: 3 },
        endCard: { seconds: 1.5 },
      },
      { tail: 0.5 },
    );
    expect(plan.pieces.map((p) => [p.kind, p.start, p.frames])).toEqual([
      ["card", 0, 105],
      ["clip", 3.5, 60],
      ["card", 5.5, 45],
    ]);
    expect(plan.titleCard).toEqual({ start: 0, end: 3.5, narration: 0 });
    expect(plan.duration).toBe(7);
  });

  it("keeps every length a whole number of frames", () => {
    const s = steps(["When", 1.013], ["Then", 0.987]);
    const plan = planEdit({
      steps: s,
      hidden: new Set(),
      narration: [{ step: 1, seconds: 1.234 }],
    });
    expect(Number.isInteger(plan.frames)).toBe(true);
    expect(plan.duration * 30).toBeCloseTo(plan.frames);
    for (const p of plan.pieces) expect(Number.isInteger(p.frames)).toBe(true);
  });

  it("shows a terminal step for its replay's length and starts a new clip after it", () => {
    const s = steps(["When", 1], ["When", 4], ["Then", 1]);
    const plan = planEdit(
      {
        steps: s,
        hidden: new Set(),
        narration: [{ step: 1, seconds: 6 }],
        terminals: new Map([[2, 2.5]]),
      },
      { tail: 0 },
    );
    expect(plan.pieces.map((p) => [p.kind, p.start, p.frames])).toEqual([
      ["clip", 0, 30],
      ["terminal", 1, 75],
      ["clip", 3.5, 30],
      ["hold", 4.5, 45],
    ]);
    expect(plan.steps.get(2)).toEqual({ start: 1, end: 3.5 });
    expect(plan.pieces[2]).toMatchObject({ srcStart: 5, srcEnd: 6 });
    const fast = planEdit(
      {
        steps: s,
        hidden: new Set(),
        narration: [{ step: 1, seconds: 3.5 }],
        terminals: new Map([[2, 2.5]]),
      },
      { tail: 0, maxSpeed: 4 },
    );
    expect(fast.scenes[0]!.speed).toBe(2);
    expect(fast.duration).toBe(3.5);
  });

  it("speeds up the unnarrated rest of a long step to idle.seconds, and never the narration", () => {
    const s = steps(["When", 2], ["Then", 30]);
    const plan = planEdit(
      { steps: s, hidden: new Set(), narration: [{ step: 1, seconds: 3 }] },
      { tail: 0.5 },
    );
    expect(plan.pieces).toEqual([
      {
        kind: "clip",
        srcStart: 0,
        srcEnd: 3.5,
        speed: 1,
        start: 0,
        frames: 105,
      },
      {
        kind: "clip",
        srcStart: 3.5,
        srcEnd: 32,
        speed: 7.125,
        start: 3.5,
        frames: 120,
        idle: true,
      },
    ]);
    expect(plan.idle).toEqual([{ start: 3.5, end: 7.5, speed: 7.125 }]);
    expect(plan.steps.get(2)).toEqual({ start: 2, end: 7.5 });
    expect(plan.duration).toBe(7.5);
    expect(outputTime(plan, 32)).toBe(7.5);

    const off = planEdit(
      { steps: s, hidden: new Set(), narration: [{ step: 1, seconds: 3 }] },
      { tail: 0.5, idle: false },
    );
    expect(off.duration).toBe(32);
    expect(off.idle).toEqual([]);
  });

  it("leaves a step alone until its unnarrated part passes idle.after, and speeds up a whole unnarrated one", () => {
    const short = planEdit({
      steps: steps(["When", 9]),
      hidden: new Set(),
      narration: [],
    });
    expect(short.duration).toBe(9);
    const long = planEdit(
      { steps: steps(["When", 12]), hidden: new Set(), narration: [] },
      { idle: { after: 6, seconds: 3 } },
    );
    expect(long.pieces).toEqual([
      {
        kind: "clip",
        srcStart: 0,
        srcEnd: 12,
        speed: 4,
        start: 0,
        frames: 90,
        idle: true,
      },
    ]);
    expect(() =>
      planEdit(
        { steps: steps(["When", 1]), hidden: new Set(), narration: [] },
        { idle: { after: 3, seconds: 4 } },
      ),
    ).toThrow(/less than idle.after/);
  });

  it("speeds up a long terminal scene after its narration", () => {
    const s = steps(["When", 1], ["When", 40]);
    const plan = planEdit(
      {
        steps: s,
        hidden: new Set(),
        narration: [{ step: 1, seconds: 2 }],
        terminals: new Map([[2, 20]]),
      },
      { tail: 0 },
    );
    expect(plan.pieces[1]).toEqual({
      kind: "terminal",
      step: 2,
      start: 1,
      frames: 150,
      idle: { at: 1, speed: 4.75 },
    });
    expect(plan.idle).toEqual([{ start: 2, end: 6, speed: 4.75 }]);
    expect(plan.duration).toBe(6);
  });

  it("cuts a narrated scene's picture maxTail seconds after the block's last word", () => {
    const s = steps(["When", 3], ["And", 4], ["When", 2], ["Then", 1]);
    const plan = planEdit(
      {
        steps: s,
        hidden: new Set(),
        narration: [
          { step: 1, seconds: 2 },
          { step: 4, seconds: 0.5 },
        ],
        terminals: new Map([[3, 3]]),
      },
      { tail: 0.5, maxTail: 1.5 },
    );
    expect(plan.pieces).toEqual([
      {
        kind: "clip",
        srcStart: 0,
        srcEnd: 3.5,
        speed: 1,
        start: 0,
        frames: 105,
      },
      {
        kind: "clip",
        srcStart: 9,
        srcEnd: 10,
        speed: 1,
        start: 3.5,
        frames: 30,
      },
    ]);
    expect(plan.steps.get(2)).toEqual({ start: 3, end: 3.5 });
    expect(plan.steps.get(3)).toEqual({ start: 3.5, end: 3.5 });
    expect(plan.duration).toBe(4.5);
    const short = planEdit(
      { steps: s, hidden: new Set(), narration: [{ step: 1, seconds: 2 }] },
      { tail: 0.5, maxTail: 0.2 },
    );
    expect(short.pieces.map((p) => [p.kind, p.frames])).toEqual([
      ["clip", 66],
      ["hold", 9],
    ]);
  });

  it("trims a step's raw video at either end, and refuses a trim on a terminal scene", () => {
    const s = steps(["When", 3], ["Then", 4]);
    const plan = planEdit({
      steps: s,
      hidden: new Set(),
      narration: [],
      trims: new Map([
        [1, { end: 1 }],
        [2, { start: 0.5, end: 1.5 }],
      ]),
    });
    expect(plan.pieces).toEqual([
      { kind: "clip", srcStart: 0, srcEnd: 2, speed: 1, start: 0, frames: 60 },
      {
        kind: "clip",
        srcStart: 3.5,
        srcEnd: 5.5,
        speed: 1,
        start: 2,
        frames: 60,
      },
    ]);
    expect(() =>
      planEdit({
        steps: s,
        hidden: new Set(),
        narration: [],
        terminals: new Map([[2, 1]]),
        trims: new Map([[2, { start: 1 }]]),
      }),
    ).toThrow(/step 2 is a terminal scene/);
  });

  it("maps raw video time to output time, undefined where cut", () => {
    const s = steps(["When", 1], ["Given", 5], ["Then", 1]);
    const plan = planEdit({ steps: s, hidden: new Set([2]), narration: [] });
    expect(outputTime(plan, 0.5)).toBe(0.5);
    expect(outputTime(plan, 3)).toBeUndefined();
    expect(outputTime(plan, 6.5)).toBe(1.5);
  });
});

describe("hidden steps, chapters and the poster", () => {
  it("hide every Given by default, the sidecar's list, or what the recorder marked, and every Background step", () => {
    const s = steps(["Given", 1], ["When", 1], ["Then", 1]);
    expect([...hiddenSteps(s, {})]).toEqual([1]);
    expect([...hiddenSteps(s, { hide: [3, "When step 2"] })]).toEqual([2, 3]);
    expect([...hiddenSteps(s, { hide: [] })]).toEqual([]);
    s[1]!.hidden = true;
    s[0]!.hidden = false;
    s[2]!.hidden = false;
    expect([...hiddenSteps(s, { hide: [3] })]).toEqual([2]);
    const background: TimelineStep = {
      ...s[0]!,
      index: 0,
      background: true,
      hidden: false,
    };
    expect([...hiddenSteps([background, ...s], {})]).toEqual([0, 2]);
  });

  it("highlight every Then by default, the sidecar's list, or what the recorder marked", () => {
    const s = steps(["When", 1], ["Then", 1], ["And", 1]);
    expect([...highlightedSteps(s, {})]).toEqual([2]);
    expect([...highlightedSteps(s, { highlight: "none" })]).toEqual([]);
    expect([...highlightedSteps(s, { highlight: [1, "And step 3"] })]).toEqual([
      1, 3,
    ]);
    s[2]!.highlight = true;
    s[1]!.highlight = false;
    expect([...highlightedSteps(s, {})]).toEqual([3]);
  });

  it("resolve a step by index, by its keyword as written and text, or by its text alone", () => {
    const s = steps(["Given", 1], ["When", 1], ["When", 1]);
    s[2]!.text = "they open it";
    expect(resolveStep(s, 2).index).toBe(2);
    expect(resolveStep(s, "When step 2").index).toBe(2);
    expect(resolveStep(s, "  When   step 2 ").index).toBe(2);
    expect(resolveStep(s, "And they open it").index).toBe(3);
    expect(() => resolveStep(s, "When nothing")).toThrow(
      /no step "When nothing"/,
    );
    expect(() => resolveStep(s, 9)).toThrow(/no step 9/);
    s[1]!.text = "they open it";
    expect(() => resolveStep(s, "And they open it")).toThrow(
      /ambiguous: steps 2, 3/,
    );
    const background: TimelineStep = { ...s[0]!, index: 0, background: true };
    expect(() => resolveStep([background], 0)).toThrow(/no step 0/);
  });

  it("put chapters at their step's output start, a hidden step's at the next visible one", () => {
    const s = steps(["Given", 4], ["When", 2], ["Then", 2]);
    const hidden = hiddenSteps(s, {});
    const plan = planEdit(
      { steps: s, hidden, narration: [{ step: 2, seconds: 3 }] },
      { tail: 0 },
    );
    expect(
      chapterTimes(
        [
          { at: 3, title: "Check" },
          { at: 1, title: "Start" },
        ],
        s,
        hidden,
        plan,
      ),
    ).toEqual([
      { start: 0, title: "Start" },
      { start: 2, title: "Check" },
    ]);
  });

  it("fit YouTube's rules: whole seconds, the first at 0, short ones folded, fewer than three dropped", () => {
    const chapters = [
      { start: 0, title: "Intro" },
      { start: 2.4, title: "Open" },
      { start: 14.9, title: "Check" },
      { start: 40.2, title: "Next" },
    ];
    expect(youtubeChapters(chapters, 50)).toEqual([
      { start: 0, title: "Intro" },
      { start: 14, title: "Check" },
      { start: 40, title: "Next" },
    ]);
    expect(youtubeChapters(chapters, 45)).toEqual([]);
    expect(
      youtubeChapters(
        [
          { start: 5, title: "A" },
          { start: 20.5, title: "B" },
          { start: 40, title: "C" },
        ],
        60,
      ),
    ).toEqual([
      { start: 0, title: "A" },
      { start: 20, title: "B" },
      { start: 40, title: "C" },
    ]);
    expect(
      youtubeChapters(
        [
          { start: 0, title: "A" },
          { start: 12, title: "B" },
          { start: 30, title: "C" },
          { start: 50, title: "D" },
        ],
        80,
        { minSeconds: 15 },
      ).map((c) => c.title),
    ).toEqual(["A", "C", "D"]);
  });

  it("pick the sidecar's poster step, else the last highlighted visible step, else the last visible one", () => {
    const s = steps(["Given", 1], ["Then", 1], ["When", 1], ["Given", 1]);
    expect(posterStep(s, { poster: { at: 1 } }).index).toBe(1);
    expect(posterStep(s, {}).index).toBe(2);
    expect(posterStep(s, { highlight: "none" }).index).toBe(3);
    expect(posterStep(s, { highlight: [3] }).index).toBe(3);
  });
});

describe("failed recordings", () => {
  const timeline = (over: Partial<Timeline>, status = "passed"): Timeline => ({
    id: "x",
    scenario: "A scenario",
    viewport: { width: 1440, height: 900 },
    steps: steps(["When", 1], ["Then", 1]).map((s, i) =>
      i === 1 ? { ...s, status } : s,
    ),
    ...over,
  });

  it("are refused when marked failed or any step did not pass", () => {
    expect(recordingProblem(timeline({}))).toBeUndefined();
    expect(() => refuseFailed(timeline({ status: "failed" }))).toThrow(
      /refusing to render.*marked failed/,
    );
    expect(() => refuseFailed(timeline({}, "failed"))).toThrow(
      /step 2 \(Then step 2\) of A scenario is failed/,
    );
    expect(() => refuseFailed(timeline({}, "skipped"))).toThrow(/is skipped/);
    expect(() => refuseFailed(timeline({ steps: [] }))).toThrow(/no steps/);
  });
});

describe("production arithmetic", () => {
  const picture = { width: 2560, height: 1280 };

  it("fits the viewport into the picture, centered", () => {
    expect(fitRect({ width: 1440, height: 900 }, picture)).toEqual({
      x: 256,
      y: 0,
      width: 2048,
      height: 1280,
    });
    expect(
      toPicture(
        { x: 720, y: 450, width: 144, height: 90 },
        { width: 1440, height: 900 },
        picture,
      ),
    ).toEqual({
      x: 1280,
      y: 640,
      width: 204.8,
      height: 128,
    });
  });

  it("takes the recorder's boxes in viewport CSS pixels at any scale", () => {
    const source = sourceSize({ viewport: { width: 1440, height: 900 } });
    expect(source).toEqual({ width: 1440, height: 900 });
    expect(
      toPicture({ x: 720, y: 450, width: 144, height: 90 }, source, picture),
    ).toEqual({ x: 1280, y: 640, width: 204.8, height: 128 });

    // A recording at device scale 1.25: its video is 1600 by 1000, its boxes CSS pixels.
    const scaled: Pick<Timeline, "viewport" | "scale"> = {
      viewport: { width: 1280, height: 800 },
      scale: 1.25,
    };
    const s = steps(["Then", 2]);
    s[0]!.actions = [
      {
        kind: "highlight",
        atMs: 500,
        box: { x: 800, y: 500, width: 200, height: 100 },
      },
    ];
    const moves = zoomMoves(
      s,
      highlightedSteps(s, {}),
      planEdit({ steps: s, hidden: new Set(), narration: [] }),
      sourceSize(scaled),
      picture,
    );
    expect(moves[0]!.box).toEqual({ x: 1536, y: 800, width: 320, height: 160 });
  });

  it("zooms to each highlight of a highlighted step until the step ends, and back out", () => {
    const s = steps(["When", 2], ["Then", 3]);
    s[1]!.actions = [
      {
        kind: "highlight",
        atMs: 2500,
        box: { x: 100, y: 100, width: 200, height: 50 },
      },
    ];
    s[0]!.actions = [
      {
        kind: "highlight",
        atMs: 500,
        box: { x: 0, y: 0, width: 10, height: 10 },
      },
    ];
    const plan = planEdit({ steps: s, hidden: new Set(), narration: [] });
    const moves = zoomMoves(
      s,
      highlightedSteps(s, {}),
      plan,
      { width: 1440, height: 900 },
      picture,
    );
    expect(moves).toHaveLength(1);
    expect(moves[0]!.at).toBe(2.5);
    expect(moves[0]!.until).toBe(5);
    const keys = cameraKeys(moves, picture);
    expect(keys.map((k) => k.t)).toEqual([0, 2.5, 3.3, 5, 5.8]);
    expect(cameraView(keys, 4, picture).width).toBe(1280);
    expect(cameraView(keys, 0, picture).width).toBe(2560);
    const box = { x: 640, y: 320, width: 100, height: 100 };
    expect(
      boxInView(box, { x: 640, y: 320, width: 1280, height: 640 }, picture),
    ).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    });
  });

  it("skips a zoom too short to get in and out", () => {
    expect(
      cameraKeys(
        [{ box: { x: 0, y: 0, width: 10, height: 10 }, at: 1, until: 1.5 }],
        picture,
      ),
    ).toHaveLength(1);
  });

  it("ducks the music bed under the narration and keeps the mix under full scale", () => {
    const rate = 1000;
    const narration = new Float32Array(4 * rate);
    for (let i = 2 * rate; i < 3 * rate; i++) narration[i] = 0.8;
    const bed = new Float32Array(2 * rate).fill(1);
    const mixed = mixAudio(narration, rate, {
      pcm: bed,
      speech: [{ start: 2, end: 3 }],
      levels: { open: -6, under: -20, fadeIn: 0.01, fadeOut: 0.01 },
    });
    expect(mixed.length).toBe(8 * rate);
    const left = (t: number) => mixed[Math.round(t * rate) * 2]!;
    expect(left(1)).toBeCloseTo(Math.pow(10, -6 / 20), 2);
    expect(left(2.5)).toBeCloseTo(0.9, 2);
    expect(mixAudio(narration, rate)[2.5 * rate * 2]).toBeCloseTo(0.8);
    const loud = mixAudio(
      narration.map((x) => x * 1.2),
      rate,
      { pcm: bed, speech: [{ start: 2, end: 3 }] },
    );
    expect(Math.max(...loud)).toBeCloseTo(0.97);
  });
});

describe("stand-ins", () => {
  const rules = {
    name: "example",
    rules: [
      { text: "run-4f2a@test.example", with: "alex@example.com" },
      { pattern: "user-(\\d+)", with: "Person $1" },
      { text: "ACME", with: "Example Co ($1)", ignoreCase: true },
    ],
  };

  it("replace literal text and patterns in order, literal replacements taken as is", () => {
    expect(
      standInText(
        "Signed in as run-4f2a@test.example, user-17 of acme.",
        rules,
      ),
    ).toBe("Signed in as alex@example.com, Person 17 of Example Co ($1).");
  });

  it("rewrite every string in a transcript and leave keys and numbers", () => {
    expect(
      standInValue({ command: "whoami", output: ["user-3"], code: 0 }, rules),
    ).toEqual({
      command: "whoami",
      output: ["Person 3"],
      code: 0,
    });
  });

  it("refuse an empty match or a bad pattern", () => {
    expect(() =>
      compileStandIns({ rules: [{ pattern: "x*", with: "y" }] }),
    ).toThrow(/matches empty text/);
    expect(() =>
      compileStandIns({ name: "bad", rules: [{ pattern: "(", with: "y" }] }),
    ).toThrow(/stand-in rule 1 of bad/);
    expect(() => compileStandIns({ rules: [{ text: "", with: "y" }] })).toThrow(
      /empty text/,
    );
  });

  it("make a page script that carries the compiled rules and the replacer", () => {
    const script = standInScript(rules);
    expect(script).toContain(JSON.stringify(compileStandIns(rules)));
    expect(script).toContain("MutationObserver");
    expect(() => new Function(script)).not.toThrow();
  });
});

describe("terminal scenes", () => {
  it("speed up a replay from a point on, its writes and its length", () => {
    const r = speedUpReplay(
      {
        writes: [
          [0, "a"],
          [2, "b"],
          [12, "c"],
        ],
        duration: 13,
      },
      2,
      5,
    );
    expect(r.writes).toEqual([
      [0, "a"],
      [2, "b"],
      [4, "c"],
    ]);
    expect(r.duration).toBeCloseTo(4.2);
  });

  const pace = {
    typeMsPerChar: 100,
    afterActionMs: 400,
    readMs: 1000,
    idleMs: 2000,
  };

  it("type the preface and each command, run it for its time, scroll its output and hold the prompt", () => {
    const r = terminalReplay({
      commands: [
        {
          command: "notes sync",
          output: [
            { atMs: 900, text: "synced 3 notes\n" },
            { atMs: 1400, text: "all done\n" },
          ],
          startMs: 0,
          endMs: 1500,
        },
      ],
      preface: ["export TOKEN=abc"],
      pace,
    });
    const text = r.writes.map(([, d]) => d).join("");
    expect(text).toBe(
      `${PROMPT}export TOKEN=abc\r\n${PROMPT}notes sync\r\nsynced 3 notes\r\nall done\r\n${PROMPT}`,
    );
    // 16 + 10 characters at 0.1 s, two 0.4 s pauses, the 1.5 s run, two output lines and the read.
    expect(r.duration).toBeCloseTo(2.6 + 0.8 + 1.5 + 0.06 + 1, 6);
    expect(r.writes.find(([, d]) => d.startsWith("synced"))![0]).toBeCloseTo(
      4.9,
      6,
    );
  });

  it("show the display line in place of the command, cap a long run, and apply stand-ins to everything shown", () => {
    const r = terminalReplay({
      commands: [
        {
          command: "/tmp/run-7/bin/notes sync",
          output: [{ atMs: 500, text: "signed in as run-7@test.example" }],
          startMs: 0,
          endMs: 600_000,
        },
      ],
      display: "notes sync",
      preface: ["export TOKEN=real-secret"],
      pace,
      standIns: {
        rules: [
          { text: "real-secret", with: "nt_example" },
          { pattern: "run-\\d+@test\\.example", with: "sam@example.com" },
        ],
      },
    });
    const text = r.writes.map(([, d]) => d).join("");
    expect(text).toContain("export TOKEN=nt_example");
    expect(text).toContain(`${PROMPT}notes sync\r\n`);
    expect(text).toContain("signed in as sam@example.com");
    expect(text).not.toContain("real-secret");
    expect(text).not.toContain("/tmp/run-7");
    expect(r.duration).toBeLessThan(10);
  });

  it("replay a cast after the preface, idle gaps capped, at the cast's grid", () => {
    const cast = parseCast(
      [
        JSON.stringify({ version: 2, width: 90, height: 20 }),
        JSON.stringify([0.5, "o", "hello\r\n"]),
        JSON.stringify([30, "o", "later\r\n"]),
      ].join("\n"),
    );
    const r = terminalReplay({ cast, preface: ["cd notes"], pace });
    expect(r.grid).toEqual({ cols: 90, rows: 20 });
    const start = 0.8 + 0.4;
    expect(r.writes.at(-2)![0]).toBeCloseTo(start + 0.5, 6);
    expect(r.writes.at(-2)![1]).toBe("hello\r\n");
    expect(r.writes.at(-1)![0]).toBeCloseTo(start + 2.5, 6);
    expect(r.duration).toBeCloseTo(start + 2.5 + 1, 6);
  });

  it("group writes by the frame they land in, keeping only frames that change", () => {
    const writes = frameWrites(
      {
        writes: [
          [0, "a"],
          [0.01, "b"],
          [0.05, "c"],
          [0.2, "d"],
        ],
      },
      10,
      30,
    );
    expect([...writes]).toEqual([
      [0, "a"],
      [1, "b"],
      [2, "c"],
      [6, "d"],
    ]);
  });
});
