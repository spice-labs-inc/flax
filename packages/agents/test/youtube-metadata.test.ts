import { symlinkSync, writeFileSync } from "node:fs";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_SOURCE_BYTES,
  scenarioMedia,
  videoAnswer,
} from "../src/deliver/media.ts";
import {
  mediaHash,
  readMediaFile,
  readMediaManifest,
  type MediaManifest,
} from "../src/lib/media.ts";
import { loadLinkHosts } from "../src/lib/link-hosts.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import {
  checkVideoAnswer,
  fullDescription,
  questionsLine,
  tagsLength,
  timestamp,
  type VideoMetadata,
} from "../src/output-check/youtube.ts";
import {
  mediaDir,
  OVERVIEW,
  scenarioHash,
  writeMedia,
} from "./youtube-media.ts";

const LINKS = loadLinkHosts(FIXTURE_WORKSPACE).hosts!;

function video(overrides: Partial<VideoMetadata> = {}): VideoMetadata {
  return {
    scenario: "dashboard-overview",
    title: OVERVIEW.title!,
    description: OVERVIEW.description!,
    tags: [...OVERVIEW.tags!],
    chapters: [...OVERVIEW.chapters!],
    ...overrides,
  };
}

function problems(
  videos: unknown[],
  durations?: ReadonlyMap<string, number>,
): string[] {
  const got = checkVideoAnswer(
    { videos },
    { links: LINKS, ...(durations === undefined ? {} : { durations }) },
  );
  return got.ok ? [] : got.problems;
}

describe("the videos' metadata", () => {
  it("accepts a scenario's metadata and appends the chapter lines and the questions line to the description", () => {
    const got = checkVideoAnswer({ videos: [video()] }, { links: LINKS });
    expect(got.ok).toBe(true);
    expect(fullDescription(video())).toBe(
      [
        "A tour of the dashboard.",
        "Docs: https://docs.notes-co.example/start/",
        "",
        "0:00 Intro",
        "0:12 Survey",
        "0:40 Portfolio",
        "",
        questionsLine(),
      ].join("\n"),
    );
    expect(fullDescription(video({ chapters: [] }))).toBe(
      `${OVERVIEW.description}\n\n${questionsLine()}`,
    );
    expect([timestamp(0), timestamp(65), timestamp(3725)]).toEqual([
      "0:00",
      "1:05",
      "1:02:05",
    ]);
  });

  it("holds titles, descriptions and tags to YouTube's limits, counting the kit's chapter lines", () => {
    expect(problems([video({ title: "x".repeat(101) })])).toEqual([
      "videos[0].title is 101 characters, over the limit of 100",
    ]);
    expect(problems([video({ title: "é".repeat(100) })])).toEqual([]);
    const tail = Buffer.byteLength(`\n\n${questionsLine()}`);
    expect(problems([video({ description: "x".repeat(4990) })])).toEqual([
      `videos[0].description is ${5029 + tail} bytes with the chapter and questions lines, over the limit of 5000`,
    ]);
    expect(
      problems([video({ description: "x".repeat(5000 - tail), chapters: [] })]),
    ).toEqual([]);
    expect(
      problems([video({ description: "x".repeat(5001 - tail), chapters: [] })]),
    ).toEqual([
      "videos[0].description is 5001 bytes with the chapter and questions lines, over the limit of 5000",
    ]);
    const tags = Array.from({ length: 50 }, (_, i) =>
      `tag ${i}`.padEnd(8, "x"),
    );
    expect(tagsLength(["a b", "c"])).toBe(7);
    expect(tagsLength(tags)).toBe(549);
    expect(problems([video({ tags })])).toEqual([
      "videos[0].tags come to 549 characters as YouTube counts them, over the limit of 500",
    ]);
    expect(problems([video({ tags: ["a,b", " "] })])).toEqual([
      "videos[0].tags[0] has a comma, which separates tags",
      "videos[0].tags[1] is empty",
    ]);
  });

  it("refuses < and >, control characters, a title of two lines and the model's own timestamp lines", () => {
    expect(
      problems([
        video({
          title: "A <b>bold</b> title",
          description: "Watch\n1:23 the good part\n\u0007",
          tags: ["<script>"],
        }),
      ]),
    ).toEqual([
      "videos[0].title has < or >, which YouTube does not take",
      "videos[0].description has a control character",
      "videos[0].description: line 2 starts with a timestamp; chapters go in chapters, and the kit writes their lines",
      "videos[0].tags[0] has < or >, which YouTube does not take",
    ]);
    expect(problems([video({ title: "one\ntwo" })])).toEqual([
      "videos[0].title must be one line",
    ]);
  });

  it("allows links only to link-hosts.yml hosts, in every text", () => {
    expect(
      problems([
        video({
          title: "See evil.example",
          description:
            "Read https://docs.notes-co.example/x and https://collect.evil.example/c?d=c2VjcmV0",
          chapters: [
            { start: 0, title: "Intro" },
            { start: 10, title: "www.evil.example" },
            { start: 20, title: "End" },
          ],
          tags: ["https://evil.example/t"],
        }),
      ]),
    ).toEqual([
      'videos[0].description: line 1 links to collect.evil.example, which is not in link-hosts.yml and not already linked from the page: "https://collect.evil.example/c?d=c2VjcmV0"',
      'videos[0].tags[0]: links to evil.example, which is not in link-hosts.yml and not already linked from the page: "https://evil.example/t"',
      'videos[0].chapters[1].title: links to www.evil.example, which is not in link-hosts.yml and not already linked from the page: "www.evil.example"',
    ]);
  });

  it("holds chapters to what YouTube shows: none, or at least three from 0:00, each at least 10 s long", () => {
    const ch = (...starts: number[]) =>
      starts.map((start, i) => ({ start, title: `Part ${i}` }));
    expect(problems([video({ chapters: [] })])).toEqual([]);
    expect(problems([video({ chapters: ch(0, 20) })])).toEqual([
      "videos[0].chapters has 2; YouTube shows chapters only with at least 3, so give none or at least 3",
    ]);
    expect(problems([video({ chapters: ch(5, 20, 40) })])).toEqual([
      "videos[0].chapters[0] must start at 0",
    ]);
    expect(problems([video({ chapters: ch(0, 30, 30, 20) })])).toEqual([
      "videos[0].chapters[2] must start after the chapter before it",
      "videos[0].chapters[3] must start after the chapter before it",
    ]);
    expect(problems([video({ chapters: ch(0, 9, 40) })])).toEqual([
      "videos[0].chapters[0] is 9 s long; YouTube needs at least 10 s",
    ]);
    expect(
      problems(
        [video({ chapters: ch(0, 20, 145) })],
        new Map([["dashboard-overview", 150]]),
      ),
    ).toEqual([
      "videos[0].chapters[2] starts at 145 s, less than 10 s before the video ends at 150 s",
    ]);
  });

  it("refuses a malformed answer, an unknown scenario id, a repeated scenario and a bad playlist", () => {
    expect(problems([])).toEqual([
      "videos must be a list of at least one video",
    ]);
    expect(
      checkVideoAnswer(
        { videos: [{ scenario: "x" }], extra: 1 },
        { links: LINKS },
      ),
    ).toEqual({
      ok: false,
      problems: [
        'the answer has a property "extra"',
        "videos[0].title must be a string",
        "videos[0].description must be a string",
        "videos[0].tags must be a list of strings",
        "videos[0].chapters must be a list of { start, title }, start in whole seconds",
      ],
    });
    expect(
      problems([
        video({ scenario: "Bad Id" }),
        video(),
        video(),
        video({ scenario: "other", playlist: "Demos <new>" }),
      ]),
    ).toEqual([
      'videos[0].scenario "Bad Id" is not a scenario id',
      'videos[2].scenario "dashboard-overview" is listed more than once',
      "videos[3].playlist has < or >, which YouTube does not take",
    ]);
  });
});

describe("the media manifest", () => {
  it("reads each scenario's files and metadata from data.scenarios, with the media hash of its three files", () => {
    const dir = mediaDir();
    const written = writeMedia(dir, {
      "dashboard-overview": OVERVIEW,
      smoke: { title: "Smoke", chapters: [], playlist: "Tests" },
    });
    const manifest = readManifest(dir);
    const media = scenarioMedia(manifest);
    if ("error" in media) throw new Error(media.error);
    expect([...media.scenarios.keys()]).toEqual([
      "dashboard-overview",
      "smoke",
    ]);
    const overview = media.scenarios.get("dashboard-overview")!;
    expect(overview.hash).toBe(scenarioHash(written, "dashboard-overview"));
    expect(overview.duration).toBe(150);
    // With one scenario, the scenario's hash is the manifest's own.
    expect(mediaHash(manifest.files)).toBe(written.hash);
    expect(videoAnswer(manifest)).toEqual({
      videos: [
        {
          scenario: "dashboard-overview",
          title: OVERVIEW.title,
          description: OVERVIEW.description,
          tags: OVERVIEW.tags,
          chapters: OVERVIEW.chapters,
        },
        {
          scenario: "smoke",
          title: "Smoke",
          description: OVERVIEW.description,
          tags: OVERVIEW.tags,
          chapters: [],
          playlist: "Tests",
        },
      ],
    });
    expect(readMediaFile(dir, overview.video).length).toBe(
      overview.video.bytes,
    );
  });

  it("hashes the sorted '<path> <sha256>' lines joined with a newline, with no final newline, as media.json's hash does", () => {
    // The sha256 of exactly "a.vtt <64 a>\nb.mp4 <64 b>".
    expect(
      mediaHash([
        { path: "b.mp4", sha256: "b".repeat(64) },
        { path: "a.vtt", sha256: "a".repeat(64) },
      ]),
    ).toBe("a13b6092be2cc249d3b64c2bf5c35624f11882b52e819023b8fc366fe02bab64");
  });

  it("refuses wrong types, a scenarios field that is no object, and files the manifest does not list", () => {
    const cases: [(m: Record<string, unknown>) => void, string][] = [
      [
        (m) => {
          const file = (m.files as { path: string; type: string }[]).find(
            (f) => f.path === "smoke/video.mp4",
          )!;
          file.type = "video/webm";
        },
        "media.json: data.scenarios.smoke.video: smoke/video.mp4 is video/webm, not video/mp4",
      ],
      [
        (m) => ((m.data as Record<string, unknown>).scenarios = []),
        "media.json: data.scenarios is not an object of scenarios",
      ],
      [
        (m) => delete (m.data as Record<string, unknown>).scenarios,
        "media.json: data.scenarios is not an object of scenarios",
      ],
      [
        (m) =>
          ((
            m.data as { scenarios: Record<string, Record<string, unknown>> }
          ).scenarios.smoke!.captions = "nope.vtt"),
        "media.json: data.scenarios.smoke.captions names no file of the manifest",
      ],
      [
        (m) =>
          ((
            m.data as { scenarios: Record<string, Record<string, unknown>> }
          ).scenarios.smoke!.source = "abc"),
        "media.json: data.scenarios.smoke.source is not a sha256",
      ],
    ];
    for (const [edit, error] of cases) {
      const dir = mediaDir();
      writeMedia(dir, { smoke: { title: "Smoke" } }, edit);
      expect(scenarioMedia(readManifest(dir) as MediaManifest)).toEqual({
        error,
      });
    }
  });

  it("has no video when the media stage made none: an empty data.scenarios, or no files and no data", () => {
    const empty = mediaDir();
    writeMedia(empty, {});
    expect(scenarioMedia(readManifest(empty))).toEqual({
      scenarios: new Map(),
    });
    expect(videoAnswer(readManifest(empty))).toEqual({ videos: [] });
    const bare = mediaDir();
    writeMedia(bare, {}, (m) => delete m.data);
    expect(scenarioMedia(readManifest(bare))).toEqual({
      scenarios: new Map(),
    });
  });

  it("reads a scenario's source file and the items left out of its video, cleaned and clipped, outside the media hash", () => {
    const dir = mediaDir();
    const written = writeMedia(dir, {
      "whats-new-2026-10-14": {
        title: "What's new",
        scenarioFile: { bytes: '{"scenes":[]}\n', path: "2026-10-14.json" },
        leftOut: [
          {
            title: "  Org\nswitcher  ",
            why: "the rehearsal\tfound no [data-testid=org-menu]",
          },
          { title: "T".repeat(150), why: "W".repeat(250) },
        ],
      },
      plain: { title: "Plain", leftOut: [] },
    });
    const media = scenarioMedia(readManifest(dir));
    if ("error" in media) throw new Error(media.error);
    const episode = media.scenarios.get("whats-new-2026-10-14")!;
    expect(episode.hash).toBe(scenarioHash(written, "whats-new-2026-10-14"));
    expect(episode.sourceFile).toMatchObject({
      path: "2026-10-14.json",
      type: "application/json",
      bytes: 14,
    });
    expect(episode.leftOut).toEqual([
      {
        title: "Org switcher",
        why: "the rehearsal found no [data-testid=org-menu]",
      },
      { title: `${"T".repeat(94)} [cut]`, why: `${"W".repeat(194)} [cut]` },
    ]);
    const plain = media.scenarios.get("plain")!;
    expect([plain.sourceFile, plain.leftOut]).toEqual([undefined, undefined]);
  });

  it("refuses a scenario source that is no JSON file of the manifest, too large, or shared, and left-out items of another shape", () => {
    const scenarios = (m: Record<string, unknown>) =>
      (m.data as { scenarios: Record<string, Record<string, unknown>> })
        .scenarios;
    const cases: [
      Record<string, Parameters<typeof writeMedia>[1][string]>,
      ((m: Record<string, unknown>) => void) | undefined,
      string,
    ][] = [
      [
        { smoke: { scenarioFile: { bytes: "{}" } } },
        (m) => (scenarios(m).smoke!.scenarioFile = "nope.json"),
        "media.json: data.scenarios.smoke.scenarioFile names no file of the manifest",
      ],
      [
        { smoke: { scenarioFile: { bytes: "x: 1", type: "text/yaml" } } },
        undefined,
        "media.json: data.scenarios.smoke.scenarioFile: smoke/scenario.json is text/yaml, not application/json",
      ],
      [
        { smoke: { scenarioFile: { bytes: "" } } },
        undefined,
        "media.json: data.scenarios.smoke.scenarioFile is empty",
      ],
      [
        {
          smoke: {
            scenarioFile: { bytes: Buffer.alloc(MAX_SOURCE_BYTES + 1, 32) },
          },
        },
        undefined,
        `media.json: data.scenarios.smoke.scenarioFile is ${MAX_SOURCE_BYTES + 1} bytes, over the ${MAX_SOURCE_BYTES} byte limit`,
      ],
      [
        {
          one: { scenarioFile: { bytes: "{}", path: "same.json" } },
          two: { scenarioFile: { bytes: "{}", path: "same.json" } },
        },
        undefined,
        "media.json: data.scenarios.two.scenarioFile is one's scenarioFile too; each video has its own",
      ],
      [
        { smoke: { leftOut: { title: "x", why: "y" } } },
        undefined,
        "media.json: data.scenarios.smoke.leftOut is not a list of { title, why }",
      ],
      [
        { smoke: { leftOut: [{ title: "x", why: " " }] } },
        undefined,
        "media.json: data.scenarios.smoke.leftOut[0] is not { title, why } with text in both",
      ],
      [
        { smoke: { leftOut: Array(9).fill({ title: "x", why: "y" }) } },
        undefined,
        "media.json: data.scenarios.smoke.leftOut names 9 items, over the limit of 8",
      ],
    ];
    for (const [given, edit, error] of cases) {
      const dir = mediaDir();
      writeMedia(dir, given, edit);
      expect(scenarioMedia(readManifest(dir))).toEqual({ error });
    }
  });

  it("re-checks each file before use: its size, its sha256, and no link", () => {
    const dir = mediaDir();
    writeMedia(dir, { smoke: { title: "Smoke" } });
    const media = scenarioMedia(readManifest(dir));
    if ("error" in media) throw new Error(media.error);
    const smoke = media.scenarios.get("smoke")!;
    writeFileSync(join(dir, "smoke/poster.png"), "png of smokE");
    expect(() => readMediaFile(dir, smoke.poster)).toThrow(
      "smoke/poster.png changed after media.json was checked",
    );
    writeFileSync(join(dir, "smoke/poster.png"), "png of smoke, longer");
    expect(() => readMediaFile(dir, smoke.poster)).toThrow(
      "smoke/poster.png is 20 bytes now, but media.json says 12",
    );
    const outside = mediaDir();
    writeFileSync(join(outside, "v.mp4"), "x");
    symlinkSync(join(outside, "v.mp4"), join(dir, "smoke/link.mp4"));
    expect(() =>
      readMediaFile(dir, {
        path: "smoke/link.mp4",
        sha256: "0".repeat(64),
        bytes: 1,
        type: "video/mp4",
      }),
    ).toThrow();
  });
});

function readManifest(dir: string): MediaManifest {
  return readMediaManifest(join(dir, "media.json"), dir);
}
