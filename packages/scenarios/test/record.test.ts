import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { plainMedia, settledBox } from "../src/record/media.ts";
import {
  cursorPath,
  DEFAULT_PACE,
  DEFAULT_VIEWPORT,
  mergePace,
  settleMs,
  travelMs,
  typingMs,
  type Pace,
} from "../src/record/pace.ts";
import { planRecordings } from "../src/record/plan.ts";
import {
  parseSidecars,
  resolveSidecar,
  SIDECAR_KEYS,
  slug,
  type VideoSidecar,
} from "../src/record/sidecar.ts";
import { featureScenarios, type StepInfo } from "../src/record/steps.ts";
import {
  buildTimeline,
  terminalCast,
  type RecordEvent,
} from "../src/record/timeline.ts";
import { ScenarioWorld } from "../src/support/world.ts";

const FEATURE = `Feature: Notes

  Background:
    Given I am signed in

  Scenario: Add a note
    Given an empty notebook
    When I open the notes page
    And I type "Weekly plan" as the title
    And I save the note
    Then the list shows "Weekly plan"
    And the count says 1

  Scenario Outline: List notes in <shell>
    Given I use <shell>
    When I run notes list
    Then I see the titles

    Examples:
      | shell |
      | bash  |
      | zsh   |

  Scenario Outline: Unnamed examples
    When I run <command>

    Examples:
      | command |
      | a       |
      | b       |
`;

const defaults = { pace: DEFAULT_PACE, viewport: DEFAULT_VIEWPORT, scale: 1 };

async function steps(name = "Add a note"): Promise<StepInfo[]> {
  const all = await featureScenarios("features/notes.feature", FEATURE);
  return all.find((s) => s.name === name)!.steps;
}

const sidecar = (more: Partial<VideoSidecar> = {}): VideoSidecar => ({
  scenario: "Add a note",
  id: "add-a-note",
  title: "Adding a note",
  ...more,
});

describe("scenario steps", () => {
  it("counts the scenario's own steps from 1, keeps keywords as written and marks Background steps", async () => {
    const s = await steps();
    expect(s.map((x) => [x.index, x.keyword, x.kind, x.background])).toEqual([
      [0, "Given", "context", true],
      [1, "Given", "context", false],
      [2, "When", "action", false],
      [3, "And", "action", false],
      [4, "And", "action", false],
      [5, "Then", "outcome", false],
      [6, "And", "outcome", false],
    ]);
  });
});

describe("parseSidecars", () => {
  it("reads one sidecar per YAML document, each with its own text", () => {
    const text = `scenario: Add a note\nid: add-a-note\ntitle: Adding\n---\nscenario: Other\nid: other\ntitle: Other\npublish: { tags: [a] }\n`;
    const { documents, errors } = parseSidecars(text, "notes.video.yml");
    expect(errors).toEqual([]);
    expect(documents.map((d) => d.sidecar.id)).toEqual(["add-a-note", "other"]);
    expect(documents[1]!.file).toBe("notes.video.yml (document 2)");
    expect(documents[1]!.source).toMatch(/^scenario: Other\n/);
    expect(documents[1]!.sidecar.publish).toEqual({ tags: ["a"] });
  });

  it("reports every shape problem with the file and key", () => {
    const text = [
      "scenario: Add a note",
      "id: Add_A_Note",
      "titel: typo",
      "pace: { typeMsPerChar: -1, speed: 2 }",
      "viewport: { width: 10, height: 900 }",
      "narration: [{ at: 0, text: '' }]",
      "highlight: some",
      "poster: { at: 1, frame: 2 }",
      "publish: [1]",
    ].join("\n");
    const { documents, errors } = parseSidecars(text, "x.video.yml");
    expect(documents).toEqual([]);
    expect(errors.every((e) => e.startsWith("x.video.yml: "))).toBe(true);
    const all = errors.join("\n");
    for (const part of [
      "unknown key titel",
      "title is required",
      "id Add_A_Note must be lowercase",
      "pace.typeMsPerChar must be a number",
      "pace: unknown key speed",
      "viewport.width must be a whole number",
      "narration[0].at must be a step number",
      "narration[0].text must be a non-empty string",
      "highlight must be then, none or a list",
      "poster: unknown key frame",
      "publish must be a mapping",
    ])
      expect(all).toContain(part);
  });

  it("checks the cards, the poster's text, the terminal overrides and the device scale factor", () => {
    const text = [
      "scenario: Add a note",
      "id: add",
      "title: Add",
      "intro: { heading: Hi, items: [{ icon: key }] }",
      "outro: plain",
      "poster: { at: 1, kicker: 3 }",
      "terminal: [{ at: 2 }, { at: 3, preface: [1] }]",
      "viewport: { width: 800, height: 600, deviceScaleFactor: 8 }",
    ].join("\n");
    const all = parseSidecars(text, "x.video.yml").errors.join("\n");
    for (const part of [
      "intro.text is required",
      "intro.items[0].label is required",
      "outro must be a mapping with heading and text",
      "poster.kicker must be a non-empty string",
      "terminal[0] needs display, preface or both",
      "terminal[1].preface must be a list of lines",
      "viewport.deviceScaleFactor must be a number from 1 to 4",
    ])
      expect(all).toContain(part);
  });

  it("reports YAML syntax errors", () => {
    const { errors } = parseSidecars("scenario: [unclosed\n", "bad.video.yml");
    expect(errors[0]).toMatch(/^bad\.video\.yml: /);
  });

  it("names the same keys as the JSON schema", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL("../src/record/video-sidecar.schema.json", import.meta.url),
        "utf8",
      ),
    ) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(
      [...SIDECAR_KEYS].sort(),
    );
    expect(schema.required).toEqual(["scenario", "id", "title"]);
  });
});

describe("resolveSidecar", () => {
  it("resolves indexes and step texts, hides every Given and highlights every visible Then by default", async () => {
    const { sidecar: r, errors } = resolveSidecar(
      sidecar({
        narration: [
          { at: 2, text: "Open the page." },
          { at: 'Then the list shows "Weekly plan"', text: "There it is." },
        ],
        chapters: [{ at: "And I save the note", title: "Save" }],
        poster: { at: 5 },
        pace: { readMs: 2000 },
      }),
      await steps(),
      defaults,
    );
    expect(errors).toEqual([]);
    expect(r).toMatchObject({
      narration: [
        { at: 2, text: "Open the page." },
        { at: 5, text: "There it is." },
      ],
      chapters: [{ at: 4, title: "Save" }],
      hide: [1],
      highlight: [5, 6],
      poster: { at: 5 },
      pace: { ...DEFAULT_PACE, readMs: 2000 },
      viewport: DEFAULT_VIEWPORT,
      publish: {},
    });
  });

  it("passes the cards and the poster's text through, resolves terminal overrides, and takes the default scale", async () => {
    const { sidecar: r, errors } = resolveSidecar(
      sidecar({
        intro: {
          heading: "Adding notes",
          items: ["Open", { label: "Save", icon: "disk" }],
          text: "How to add one.",
        },
        outro: { chapter: "Next", heading: "More", text: "That is all." },
        poster: { at: 5, title: "Notes", kicker: "How-to" },
        terminal: {
          at: "And I save the note",
          display: "notes save",
          preface: ["export TOKEN=x"],
        },
      }),
      await steps(),
      { ...defaults, scale: 1.25 },
    );
    expect(errors).toEqual([]);
    expect(r).toMatchObject({
      viewport: { ...DEFAULT_VIEWPORT, deviceScaleFactor: 1.25 },
      intro: {
        heading: "Adding notes",
        items: [{ label: "Open" }, { label: "Save", icon: "disk" }],
        text: "How to add one.",
      },
      outro: {
        chapter: "Next",
        heading: "More",
        items: [],
        text: "That is all.",
      },
      poster: { at: 5, title: "Notes", kicker: "How-to" },
      terminal: [{ at: 4, display: "notes save", preface: ["export TOKEN=x"] }],
    });
    expect(
      resolveSidecar(
        sidecar({
          viewport: { width: 1536, height: 864, deviceScaleFactor: 1.25 },
        }),
        await steps(),
        defaults,
      ).sidecar?.viewport,
    ).toEqual({ width: 1536, height: 864, deviceScaleFactor: 1.25 });
    expect(
      resolveSidecar(
        sidecar({
          terminal: [
            { at: 1, display: "a" },
            { at: 3, display: "b" },
            { at: 3, preface: ["c"] },
          ],
        }),
        await steps(),
        defaults,
      ).errors.map((e) => e.split(": ").slice(1, 3).join(": ")),
    ).toEqual([
      "terminal[0].at: step 1 is hidden (every Given is unless hide lists the steps to hide), so nothing on screen would go with it",
      "terminal[2].at: step 3 already has a terminal override",
    ]);
  });

  it("takes hide and highlight lists, and highlight none", async () => {
    const s = await steps();
    expect(
      resolveSidecar(sidecar({ hide: [], highlight: "none" }), s, defaults)
        .sidecar,
    ).toMatchObject({ hide: [], highlight: [] });
    expect(
      resolveSidecar(
        sidecar({ hide: [1, 2], highlight: [3, "And the count says 1"] }),
        s,
        defaults,
      ).sidecar,
    ).toMatchObject({ hide: [1, 2], highlight: [3, 6] });
  });

  it("refuses a step number out of range, listing the steps", async () => {
    const { sidecar: r, errors } = resolveSidecar(
      sidecar({ narration: [{ at: 7, text: "Too far." }] }),
      await steps(),
      defaults,
      "notes.video.yml",
    );
    expect(r).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      'notes.video.yml: narration[0].at: step 7 is out of range; "Add a note" has 6 steps',
    );
    expect(errors[0]).toContain("2 When I open the notes page");
  });

  it("refuses a step text no step reads, or one without its keyword", async () => {
    const { errors } = resolveSidecar(
      sidecar({
        narration: [
          { at: "When I close the page", text: "a" },
          { at: "I open the notes page", text: "b" },
        ],
      }),
      await steps(),
      defaults,
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain(
      'no step of "Add a note" reads "When I close the page"',
    );
    expect(errors[1]).toContain(
      'reads "I open the notes page" (keyword as written included)',
    );
  });

  it("refuses a step text two steps read", async () => {
    const twice = (await steps()).map((s) =>
      s.index === 4
        ? { ...s, keyword: "And", text: 'I type "Weekly plan" as the title' }
        : s,
    );
    const { errors } = resolveSidecar(
      sidecar({ poster: { at: 'And I type "Weekly plan" as the title' } }),
      twice,
      defaults,
    );
    expect(errors[0]).toContain("is steps 3 and 4; use the step number");
  });

  it("refuses overlapping narration: two blocks at one step, or a block before the one above it", async () => {
    const { errors } = resolveSidecar(
      sidecar({
        narration: [
          { at: 3, text: "a" },
          { at: 3, text: "b" },
          { at: 2, text: "c" },
        ],
      }),
      await steps(),
      defaults,
    );
    expect(errors).toEqual([
      "sidecar: narration[1].at: step 3 overlaps narration[0] at step 3; each block runs until the next one starts, so each must start at a later step",
      "sidecar: narration[2].at: step 2 overlaps narration[1] at step 3; each block runs until the next one starts, so each must start at a later step",
    ]);
  });

  it("refuses narration, chapters and the poster at a hidden step", async () => {
    const { errors } = resolveSidecar(
      sidecar({
        narration: [{ at: 1, text: "Setup." }],
        chapters: [{ at: 1, title: "Setup" }],
        poster: { at: 1 },
      }),
      await steps(),
      defaults,
    );
    expect(errors.map((e) => e.split(":")[1]?.trim())).toEqual([
      "narration[0].at",
      "chapters[0].at",
      "poster.at",
    ]);
  });
});

describe("planRecordings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "record-plan-"));
    await mkdir(join(dir, "features"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const record = {
    pace: DEFAULT_PACE,
    viewport: DEFAULT_VIEWPORT,
    scale: 1,
    highlightColor: "#000",
  };
  const plan = async (sidecarText: string | undefined, all = false) => {
    const uri = join(dir, "features", "notes.feature");
    await writeFile(uri, FEATURE);
    if (sidecarText !== undefined)
      await writeFile(join(dir, "features", "notes.video.yml"), sidecarText);
    return planRecordings([{ uri, text: FEATURE }], {
      dir: join(dir, "media"),
      all,
      record,
    });
  };

  it("plans the scenario a sidecar names, an outline example by its filled-in name, each at its line", async () => {
    const { plan: p, errors } = await plan(
      "scenario: Add a note\nid: add\ntitle: Add\n---\nscenario: List notes in zsh\nid: list-zsh\ntitle: List\n",
    );
    expect(errors).toEqual([]);
    expect(p.recordings.map((r) => [r.sidecar.id, r.line])).toEqual([
      ["add", 6],
      ["list-zsh", 22],
    ]);
    expect(p.dir).toBe(join(dir, "media"));
  });

  it("refuses an unknown scenario name, naming the feature's scenarios", async () => {
    const { plan: p, errors } = await plan(
      "scenario: Add a note!\nid: add\ntitle: Add\n",
    );
    expect(p.recordings).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('scenario "Add a note!" is not in');
    expect(errors[0]).toContain(
      '"Add a note", "List notes in bash", "List notes in zsh", "Unnamed examples"',
    );
  });

  it("reads <feature>.<id>.video.yml files, checking the id against the file name, and leaves out another feature's", async () => {
    await writeFile(
      join(dir, "features", "notes.add.video.yml"),
      "scenario: Add a note\nid: add\ntitle: Add\n",
    );
    await writeFile(
      join(dir, "features", "notes.zsh.video.yml"),
      "scenario: List notes in zsh\nid: list-zsh\ntitle: List\n",
    );
    await writeFile(
      join(dir, "features", "notes.extra.feature"),
      "Feature: Extra\n",
    );
    await writeFile(
      join(dir, "features", "notes.extra.video.yml"),
      "scenario: Nowhere\nid: extra\ntitle: Extra\n",
    );
    const { errors } = await plan(undefined);
    expect(errors).toEqual([
      expect.stringMatching(
        /notes\.zsh\.video\.yml: the file is named for id zsh but the sidecar's id is list-zsh$/,
      ),
    ]);
    await rm(join(dir, "features", "notes.zsh.video.yml"));
    const { plan: p, errors: none } = await plan(undefined);
    expect(none).toEqual([]);
    expect(p.recordings.map((r) => r.sidecar.id)).toEqual(["add"]);
  });

  it("refuses two sidecars for one scenario", async () => {
    await writeFile(
      join(dir, "features", "notes.again.video.yml"),
      "scenario: Add a note\nid: again\ntitle: Again\n",
    );
    const { errors } = await plan(
      "scenario: Add a note\nid: add\ntitle: Add\n",
    );
    expect(errors).toEqual([
      expect.stringContaining('scenario "Add a note" already has a sidecar'),
    ]);
  });

  it("refuses a name several outline examples share", async () => {
    const { errors } = await plan(
      "scenario: Unnamed examples\nid: u\ntitle: U\n",
    );
    expect(errors[0]).toContain("names 2 examples of an outline");
  });

  it("refuses an id two sidecars use", async () => {
    const { errors } = await plan(
      "scenario: Add a note\nid: same\ntitle: A\n---\nscenario: List notes in bash\nid: same\ntitle: B\n",
    );
    expect(errors[0]).toMatch(/^id same is used twice/);
  });

  it("records every scenario with --record-all, generating ids from names and numbering repeats", async () => {
    const { plan: p, errors } = await plan(
      "scenario: Add a note\nid: unnamed-examples\ntitle: Taken\n",
      true,
    );
    expect(errors).toEqual([]);
    expect(p.recordings.map((r) => r.sidecar.id)).toEqual([
      "unnamed-examples",
      "list-notes-in-bash",
      "list-notes-in-zsh",
      "unnamed-examples-2",
      "unnamed-examples-3",
    ]);
    expect(p.recordings[1]!.source).toBe(
      "scenario: List notes in bash\nid: list-notes-in-bash\ntitle: List notes in bash\n",
    );
  });

  it("makes ids of names", () => {
    expect(slug("Your first inventory survey!")).toBe(
      "your-first-inventory-survey",
    );
    expect(slug("Café crème")).toBe("cafe-creme");
    expect(slug("***")).toBe("scenario");
  });
});

describe("pacing", () => {
  const pace: Pace = { typeMsPerChar: 50, afterActionMs: 400, readMs: 1500 };

  it("types at the pace per character", () => {
    expect(typingMs("Weekly plan", pace)).toBe(550);
    expect(typingMs("", pace)).toBe(0);
  });

  it("moves the cursor in 350 to 800 ms by distance, not at all under a pixel", () => {
    expect(travelMs({ x: 0, y: 0 }, { x: 0.5, y: 0 })).toBe(0);
    expect(travelMs({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(350);
    expect(travelMs({ x: 0, y: 0 }, { x: 500, y: 0 })).toBe(450);
    expect(travelMs({ x: 0, y: 0 }, { x: 3000, y: 4000 })).toBe(800);
  });

  it("eases the cursor along one point per frame to exactly the target", () => {
    const path = cursorPath({ x: 0, y: 0 }, { x: 500, y: 0 });
    expect(path).toHaveLength(Math.ceil(450 / 16));
    expect(path.at(-1)).toEqual({ x: 500, y: 0 });
    const xs = path.map((p) => p.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(xs[1]! - xs[0]!).toBeLessThan(xs[15]! - xs[14]!);
    expect(cursorPath({ x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([]);
  });

  it("holds a check for reading, an action unless it already paused, a hidden step never", () => {
    expect(
      settleMs({ kind: "outcome", hidden: false, actedLast: true }, pace),
    ).toBe(1500);
    expect(
      settleMs({ kind: "action", hidden: false, actedLast: false }, pace),
    ).toBe(400);
    expect(
      settleMs({ kind: "action", hidden: false, actedLast: true }, pace),
    ).toBe(0);
    expect(
      settleMs({ kind: "context", hidden: false, actedLast: false }, pace),
    ).toBe(400);
    expect(
      settleMs({ kind: "outcome", hidden: true, actedLast: false }, pace),
    ).toBe(0);
  });

  it("overrides the defaults key by key", () => {
    expect(mergePace(pace, { readMs: 10 })).toEqual({ ...pace, readMs: 10 });
    expect(mergePace(pace)).toEqual(pace);
  });

  it("takes the recorder defaults from flax.yml, each bad value falling back", () => {
    const base =
      "org: x\nenvironments: [{ id: prod }]\nscenarios:\n  surfaces: [{ name: web }]\n";
    expect(parseConfig(base).recorder).toEqual({
      name: "x-scenarios",
      pace: DEFAULT_PACE,
      viewport: DEFAULT_VIEWPORT,
      scale: 1,
      highlightColor: "#2f6fed",
    });
    const set = parseConfig(
      `${base}  recorder:\n    name: notes\n    pace: { typeMsPerChar: 30, readMs: -5 }\n    viewport: { width: 1280, height: 50 }\n    scale: 2\n    highlightColor: "#123456"\n`,
    ).recorder;
    expect(set).toEqual({
      name: "notes",
      pace: { ...DEFAULT_PACE, typeMsPerChar: 30 },
      viewport: { width: 1280, height: 900 },
      scale: 2,
      highlightColor: "#123456",
    });
  });
});

describe("buildTimeline", () => {
  it("places each step, action, screen and command relative to the first frame; steps that never ran are skipped", async () => {
    const s = await steps();
    const id = (i: number) => s.find((x) => x.index === i && !x.background)!.id;
    const bg = s[0]!.id;
    const t0 = 1_000_000;
    const events: RecordEvent[] = [
      { type: "step-start", step: bg, at: t0 - 300 },
      { type: "action", step: bg, kind: "goto", at: t0 + 5, box: null },
      { type: "step-end", step: bg, at: t0 + 10, status: "passed" },
      { type: "step-start", step: id(1), at: t0 + 11 },
      { type: "step-end", step: id(1), at: t0 + 20, status: "passed" },
      { type: "screen", step: id(1), file: "screens/1.png" },
      { type: "step-start", step: id(2), at: t0 + 30.4 },
      {
        type: "action",
        step: id(2),
        kind: "click",
        at: t0 + 500.6,
        box: { x: 10, y: 20, width: 30, height: 40 },
      },
      {
        type: "terminal",
        step: id(2),
        command: "notes list",
        cwd: "/work",
        exitCode: 0,
        start: t0 + 600,
        end: t0 + 700,
        chunks: [{ at: t0 + 650, text: "Weekly plan\n" }],
      },
      {
        type: "terminal",
        step: id(2),
        command: "notes count",
        exitCode: 0,
        start: t0 + 800,
        end: t0 + 900,
        chunks: [],
      },
      { type: "step-end", step: id(2), at: t0 + 1200, status: "passed" },
      { type: "screen", step: id(2), file: "screens/2.png" },
      { type: "step-start", step: id(3), at: t0 + 1210 },
      {
        type: "step-end",
        step: id(3),
        at: t0 + 3210,
        status: "failed",
        error: "Timeout 2000ms exceeded.",
      },
    ];
    const { timeline, terminals } = buildTimeline({
      id: "add-a-note",
      scenario: "Add a note",
      feature: "features/notes.feature",
      status: "failed",
      video: "video.webm",
      viewport: { width: 800, height: 600 },
      scale: 1,
      steps: s,
      hidden: new Set([1]),
      highlighted: new Set([5, 6]),
      terminal: [
        { at: 2, display: "notes list --all", preface: ["export TOKEN=x"] },
      ],
      events,
      origin: t0,
      originWallMs: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    expect(timeline.startedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(timeline.status).toBe("failed");
    expect(
      timeline.background.map((x) => [
        x.index,
        x.hidden,
        x.startMs,
        x.endMs,
        x.status,
      ]),
    ).toEqual([[0, true, -300, 10, "passed"]]);
    expect(
      timeline.steps.map((x) => [
        x.index,
        x.hidden,
        x.startMs,
        x.endMs,
        x.status,
      ]),
    ).toEqual([
      [1, true, 11, 20, "passed"],
      [2, false, 30, 1200, "passed"],
      [3, false, 1210, 3210, "failed"],
      [4, false, null, null, "skipped"],
      [5, false, null, null, "skipped"],
      [6, false, null, null, "skipped"],
    ]);
    expect(timeline.background[0]).toEqual({
      index: 0,
      keyword: "Given",
      text: "I am signed in",
      hidden: true,
      highlight: false,
      startMs: -300,
      endMs: 10,
      status: "passed",
      actions: [{ kind: "goto", atMs: 5 }],
      screen: null,
      terminal: null,
    });
    expect(timeline.steps[1]).toMatchObject({
      screen: "screens/2.png",
      terminal: "terminal/2.json",
      actions: [
        {
          kind: "click",
          atMs: 501,
          box: { x: 10, y: 20, width: 30, height: 40 },
        },
      ],
    });
    expect(timeline.steps[2]!.error).toBe("Timeout 2000ms exceeded.");
    expect(timeline.steps[4]!.highlight).toBe(true);
    expect(terminals).toEqual([
      {
        index: 2,
        command: "notes list",
        cwd: "/work",
        exitCode: 0,
        startMs: 600,
        endMs: 700,
        output: [{ atMs: 650, text: "Weekly plan\n" }],
        display: "notes list --all",
        preface: ["export TOKEN=x"],
        more: [
          {
            command: "notes count",
            exitCode: 0,
            startMs: 800,
            endMs: 900,
            output: [],
          },
        ],
      },
    ]);
  });

  it("writes a terminal scene as an asciicast: the preface, the command as displayed, the output at its time", () => {
    const cast = terminalCast(
      {
        index: 3,
        command: "ls -la /work",
        display: "ls",
        preface: ["cd"],
        exitCode: 0,
        startMs: 1000,
        endMs: 1100,
        output: [{ atMs: 1040, text: "a\nb" }],
      },
      { typeMsPerChar: 50, afterActionMs: 400, readMs: 0 },
    );
    const [head, ...lines] = cast.trimEnd().split("\n");
    expect(JSON.parse(head!)).toEqual({
      version: 2,
      width: 100,
      height: 30,
      idle_time_limit: 2,
    });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      [0, "o", "$ "],
      [0.05, "o", "c"],
      [0.1, "o", "d"],
      [0.3, "o", "\r\n"],
      [0.3, "o", "$ "],
      [0.35, "o", "l"],
      [0.4, "o", "s"],
      [0.6, "o", "\r\n"],
      [0.64, "o", "a\r\nb"],
      [0.7, "o", "\r\n"],
      [0.7, "o", "$ "],
    ]);
  });
});

describe("the media hooks outside a recorded scenario", () => {
  const untouchable = new Proxy(
    {},
    {
      get() {
        throw new Error("the locator was used");
      },
    },
  ) as never;

  it("point at and highlight nothing, keep no transcript, and click and fill at once", async () => {
    expect(plainMedia.recording).toBe(false);
    await plainMedia.pointAt(untouchable);
    await plainMedia.highlight(untouchable);
    plainMedia.terminal({ command: "ls", output: "" });
    const calls: string[] = [];
    const locator = {
      click: async () => void calls.push("click"),
      fill: async (t: string) => void calls.push(`fill ${t}`),
    } as never;
    await plainMedia.click(locator);
    await plainMedia.type(locator, "Weekly plan");
    expect(calls).toEqual(["click", "fill Weekly plan"]);
  });

  it("are what the World offers when the run is not recording", () => {
    process.env["ACME_SCENARIOS_ENV"] = "prod";
    const world = new ScenarioWorld({
      attach: (() => undefined) as never,
      log: () => undefined,
      link: () => undefined,
      parameters: {},
    });
    expect(world.recording).toBeUndefined();
    expect(world.media).toBe(plainMedia);
  });
});

describe("settledBox", () => {
  it("waits for a box that a smooth scroll still moves to stop", async () => {
    const reads = [500, 380, 260, 180, 150, 150, 150].map((y) => ({
      x: 10,
      y,
      width: 100,
      height: 20,
    }));
    let i = 0;
    const box = await settledBox(async () => reads[Math.min(i++, 6)]!, {
      intervalMs: 1,
    });
    expect(box).toEqual({ x: 10, y: 150, width: 100, height: 20 });
    expect(i).toBe(6);
  });

  it("answers the last box when it never settles in time", async () => {
    let y = 0;
    const box = await settledBox(
      async () => ({ x: 0, y: (y += 50), width: 1, height: 1 }),
      { intervalMs: 1, timeoutMs: 20 },
    );
    expect(box?.y).toBeGreaterThan(50);
  });
});
