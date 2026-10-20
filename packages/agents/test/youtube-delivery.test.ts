import { generateKeyPairSync } from "node:crypto";
import { FIXTURE_WORKSPACE } from "./helpers.ts";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { parse, stringify } from "yaml";
import { allowlistsCheck } from "../src/check/allowlists.ts";
import { folderCheck } from "../src/check/folder.ts";
import { jobSchemaCheck } from "../src/check/job-schema.ts";
import { mediaCheck } from "../src/check/media.ts";
import type { OpenedPoster } from "../src/deliver/slack-poster.ts";
import {
  deliverVideoMap,
  mapPullBody,
  parseVideoMap,
  readDocsState,
  updatedMapText,
  type DocsState,
} from "../src/deliver/video-map.ts";
import type { OpenedYouTube } from "../src/deliver/youtube.ts";
import { generate } from "../src/generate/generate.ts";
import { deliverySecrets } from "../src/generate/render.ts";
import type { JobConfig } from "../src/lib/job.ts";
import { loadLinkHosts } from "../src/lib/link-hosts.ts";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { loadRepo } from "../src/lib/repo.ts";
import { readMediaManifest } from "../src/lib/media.ts";
import { ReportWriter } from "../src/run-job/report.ts";
import { runJob, type RunOptions } from "../src/run-job/run.ts";
import {
  deferOverLimit,
  runYouTubeStage,
  type YouTubeStageOptions,
} from "../src/run-job/youtube-output.ts";
import { FakeWriter } from "./fake-writer.ts";
import {
  ACCESS_TOKEN,
  CHANNEL,
  fakeYouTube,
  openFake,
  YOUTUBE_ENV,
} from "./fake-youtube.ts";
import { questionsLine } from "../src/output-check/youtube.ts";
import { makeRepo, POST_CHANNEL, READ_CHANNEL, REPO, run } from "./helpers.ts";
import {
  mediaDir,
  OVERVIEW,
  scenarioHash,
  writeMedia,
} from "./youtube-media.ts";

const DOCS = "notes-co/public-docs";
const MAP = "src/data/videos.json";
const BASE = "a".repeat(40);
const NOW = new Date("2026-10-05T20:00:00Z");
const DAY = "2026-10-05";
const JOB = "demo-videos";
const RUN_URL =
  "https://github.com/notes-co/agents/actions/runs/36606095916";
const RUN_ENV = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "notes-co/agents",
  GITHUB_RUN_ID: "36606095916",
};
const LINKS = loadLinkHosts(FIXTURE_WORKSPACE).hosts!;
const OUTPUT = {
  kind: "youtube" as const,
  playlist: null,
  docs_repo: DOCS,
  map_path: MAP,
};

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-youtube-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function files(dir: string, rel = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) for (const [k, v] of files(dir, path)) out.set(k, v);
    else out.set(path, readFileSync(join(dir, path), "utf8"));
  }
  return out;
}

function docsState(overrides: Partial<DocsState> = {}): DocsState {
  return {
    repo: DOCS,
    path: MAP,
    branch: "main",
    base: BASE,
    openPulls: [],
    ...overrides,
  };
}

function recordedMap(
  entries: Record<string, { id: string; hash: string; source?: string }>,
) {
  return `${JSON.stringify(
    Object.fromEntries(
      Object.entries(entries).map(([k, v]) => [
        k,
        {
          youtubeId: v.id,
          title: "Old",
          hash: v.hash,
          ...(v.source === undefined ? {} : { source: v.source }),
          publishedAt: "2026-09-01T00:00:00.000Z",
        },
      ]),
    ),
    null,
    2,
  )}\n`;
}

function recordingPoster() {
  const posts: { channel: string; text: string; blocks: unknown[] }[] = [];
  const open = (): Promise<OpenedPoster> =>
    Promise.resolve({
      poster: {
        post: (channel, message) => {
          posts.push({ channel, text: message.text, blocks: message.blocks });
          return Promise.resolve({
            channel,
            ts: "1790799964.081439",
            permalink: `https://notes-co.slack.com/archives/${channel}/p1790799964081439`,
          });
        },
      },
      secrets: [],
    });
  return { posts, open };
}

describe("the map file", () => {
  it("records each scenario's video, keeps every other entry, and writes sorted two-space JSON", () => {
    const before = `{\n  "zeta": { "youtubeId": "zzzzzzzzzzz", "title": "Z", "hash": "h", "publishedAt": "p" },\n  "custom": 3\n}\n`;
    expect(parseVideoMap(before)).toEqual({
      entries: new Map([
        [
          "zeta",
          { youtubeId: "zzzzzzzzzzz", title: "Z", hash: "h", publishedAt: "p" },
        ],
      ]),
    });
    expect(parseVideoMap("[]")).toEqual({ error: "is not a JSON object" });
    expect(parseVideoMap("{")).toEqual({ error: "is not JSON" });
    expect(parseVideoMap(undefined)).toEqual({ entries: new Map() });
    const entry = {
      youtubeId: "vid1xxxxxxx",
      title: "New",
      hash: "f".repeat(64),
      publishedAt: NOW.toISOString(),
    };
    expect(updatedMapText(before, new Map([["alpha", entry]]))).toBe(
      `${JSON.stringify(
        {
          alpha: entry,
          custom: 3,
          zeta: {
            youtubeId: "zzzzzzzzzzz",
            title: "Z",
            hash: "h",
            publishedAt: "p",
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(updatedMapText(undefined, new Map([["alpha", entry]]))).toBe(
      `${JSON.stringify({ alpha: entry }, null, 2)}\n`,
    );
  });

  it("reads and records the fields of the docs' video page", () => {
    const entry = {
      youtubeId: "vid1xxxxxxx",
      title: "Notes Co in two minutes",
      hash: "f".repeat(64),
      publishedAt: NOW.toISOString(),
      description: "A tour.",
      chapters: [{ start: 0, title: "Intro" }],
      duration: 90,
      poster: "/videos/dashboard-overview/poster.png",
      captions: "/videos/dashboard-overview/captions.vtt",
    };
    const text = updatedMapText(
      "{}\n",
      new Map([["dashboard-overview", entry]]),
    );
    const parsed = parseVideoMap(text);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.entries.get("dashboard-overview")).toEqual(entry);
  });

  it("reads and records each video's source beside its media hash", () => {
    const sourced = {
      youtubeId: "vid1xxxxxxx",
      title: "New",
      hash: "f".repeat(64),
      source: "a".repeat(64),
      publishedAt: NOW.toISOString(),
    };
    const text = updatedMapText(undefined, new Map([["alpha", sourced]]));
    expect(JSON.parse(text)).toEqual({ alpha: sourced });
    expect(Object.keys(JSON.parse(text).alpha)).toEqual([
      "youtubeId",
      "title",
      "hash",
      "source",
      "publishedAt",
    ]);
    expect(parseVideoMap(text)).toEqual({
      entries: new Map([["alpha", sourced]]),
    });
  });

  it("is read with the reader app's token for the docs repository only, at the default branch's head, with the job's open pull requests", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const token = ["ghs", "readertokenforthetests"].join("_");
    const requests: { method: string; path: string; body?: unknown }[] = [];
    const text = recordedMap({ smoke: { id: "smokexxxxxx", hash: "1" } });
    const fn = (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ method, path: `${url.pathname}${url.search}`, body });
      const json = (v: unknown, status = 200) =>
        Promise.resolve(new Response(JSON.stringify(v), { status }));
      const repo = "/repos/notes-co/public-docs";
      if (url.pathname === "/orgs/notes-co/installation")
        return json({ id: 7 });
      if (url.pathname === "/app/installations/7/access_tokens")
        return json(
          {
            token,
            permissions: body.permissions,
            repositories: [{ name: "public-docs" }],
          },
          201,
        );
      if (method === "DELETE") return json({}, 204);
      if (url.pathname === repo) return json({ default_branch: "main" });
      if (url.pathname === `${repo}/git/ref/heads/main`)
        return json({ object: { sha: BASE } });
      if (url.pathname === `${repo}/contents/src/data/videos.json`)
        return json({
          type: "file",
          encoding: "base64",
          content: Buffer.from(text).toString("base64"),
        });
      if (url.pathname === `${repo}/pulls`)
        return json([
          {
            number: 9,
            html_url: "https://github.com/notes-co/public-docs/pull/9",
            head: {
              ref: `agent/${JOB}/2026-10-01`,
              repo: { full_name: DOCS },
            },
            user: { type: "Bot" },
          },
          {
            number: 10,
            head: {
              ref: "agent/other-job/2026-10-01",
              repo: { full_name: DOCS },
            },
            user: { type: "Bot" },
          },
          {
            number: 11,
            head: {
              ref: `agent/${JOB}/2026-10-02`,
              repo: { full_name: "x/y" },
            },
            user: { type: "Bot" },
          },
        ]);
      return json({}, 404);
    };
    const got = await readDocsState(DOCS, MAP, JOB, {
      appId: "12",
      privateKey,
      apiUrl: "https://api.test",
      fetch: fn as typeof fetch,
    });
    expect(got).toEqual({
      state: {
        repo: DOCS,
        path: MAP,
        branch: "main",
        base: BASE,
        text,
        openPulls: [
          {
            number: 9,
            url: "https://github.com/notes-co/public-docs/pull/9",
            branch: `agent/${JOB}/2026-10-01`,
          },
        ],
      },
      secrets: [token],
    });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /orgs/notes-co/installation",
      "POST /app/installations/7/access_tokens",
      "GET /repos/notes-co/public-docs",
      "GET /repos/notes-co/public-docs/git/ref/heads/main",
      `GET /repos/notes-co/public-docs/contents/src/data/videos.json?ref=${BASE}`,
      "GET /repos/notes-co/public-docs/pulls?state=open&per_page=100",
      "DELETE /installation/token",
    ]);
    expect(requests[1]!.body).toEqual({
      repositories: ["public-docs"],
      permissions: {
        contents: "read",
        metadata: "read",
        pull_requests: "read",
      },
    });
  });

  it("is updated in one pull request on the day's agent branch, after checking the file is what the run read", async () => {
    const writer = new FakeWriter();
    const text = recordedMap({ smoke: { id: "smokexxxxxx", hash: "1" } });
    writer.put(DOCS, BASE, MAP, text);
    const uploaded = [
      {
        scenario: "dashboard-overview",
        entry: {
          youtubeId: "vid1xxxxxxx",
          title: "Notes Co in two minutes",
          hash: "f".repeat(64),
          publishedAt: NOW.toISOString(),
        },
        replaces: "oldoldoldol",
      },
    ];
    const meta = {
      job: JOB,
      runName: "job-demo-videos-1",
      runUrl: RUN_URL,
      playlists: new Map([["dashboard-overview", "Demos"]]),
    };
    const pull = await deliverVideoMap(
      writer,
      docsState({ text }),
      uploaded,
      meta,
      NOW,
    );
    expect(pull).toEqual({
      repo: DOCS,
      number: 100,
      url: "https://github.com/notes-co/public-docs/pull/100",
      branch: `agent/${JOB}/${DAY}`,
      commit: "e".repeat(39) + "1",
      updated: false,
      check: expect.objectContaining({
        name: `Notes Agent / ${JOB}`,
        head: "e".repeat(39) + "1",
        conclusion: "success",
        title:
          "1 video uploaded as private; publish in YouTube Studio before merging",
      }),
    });
    expect(writer.checks[0]!.summary).toContain(
      "[`vid1xxxxxxx`](https://studio.youtube.com/video/vid1xxxxxxx/edit), replaces `oldoldoldol`",
    );
    const commit = writer.commits[0]!.request;
    expect(commit.base).toBe(BASE);
    expect(commit.files).toEqual([
      {
        path: MAP,
        mode: "100644",
        text: updatedMapText(
          text,
          new Map([["dashboard-overview", uploaded[0]!.entry]]),
        ),
      },
    ]);
    expect(commit.message).toBe(
      `${JOB}: 1 video\n\n- dashboard-overview: vid1xxxxxxx\n\nRun: job-demo-videos-1`,
    );
    const opened = writer.pulls[0]!;
    expect([opened.title, opened.draft, opened.base]).toEqual([
      `${JOB}: 1 video (${DAY})`,
      false,
      "main",
    ]);
    expect(opened.body).toBe(
      mapPullBody(docsState({ text }), uploaded, meta, `agent/${JOB}/${DAY}`),
    );
    expect(opened.body).toContain(
      "- `dashboard-overview`: [Notes Co in two minutes](https://studio.youtube.com/video/vid1xxxxxxx/edit), replaces `oldoldoldol`, playlist Demos.",
    );
    expect(opened.body).toContain(
      "| `dashboard-overview` | `vid1xxxxxxx` | `ffffffffffff` |",
    );
    expect(opened.body).not.toContain("```text");
    // A second run the same day updates the same pull request.
    const again = await deliverVideoMap(
      writer,
      docsState({ text }),
      uploaded,
      meta,
      NOW,
    );
    expect([again.number, again.updated]).toEqual([100, true]);
    expect(again.check?.head).toBe(again.commit);
    expect(writer.pulls).toHaveLength(1);
    writer.put(DOCS, BASE, MAP, "{}\n");
    await expect(
      deliverVideoMap(writer, docsState({ text }), uploaded, meta, NOW),
    ).rejects.toThrow(
      `${DOCS}/${MAP} at aaaaaaaaaaaa is not the file the run read, so the videos were not recorded`,
    );
  });

  it("asks the review team when it opens the map pull request, and nobody again on an update", async () => {
    const writer = new FakeWriter();
    const text = recordedMap({});
    writer.put(DOCS, BASE, MAP, text);
    const uploaded = [
      {
        scenario: "dashboard-overview",
        entry: {
          youtubeId: "vid1xxxxxxx",
          title: "Notes Co in two minutes",
          hash: "f".repeat(64),
          publishedAt: NOW.toISOString(),
        },
      },
    ];
    const meta = {
      job: JOB,
      runName: "job-demo-videos-1",
      playlists: new Map<string, string>(),
      reviewTeam: "engineering",
    };
    const pull = await deliverVideoMap(
      writer,
      docsState({ text }),
      uploaded,
      meta,
      NOW,
    );
    expect(pull.reviews).toEqual({
      requested: ["team:engineering"],
      refused: [],
    });
    const again = await deliverVideoMap(
      writer,
      docsState({ text }),
      uploaded,
      meta,
      NOW,
    );
    expect(again.reviews).toBeUndefined();
    expect(
      writer.calls.filter((c) => c.startsWith("requestReviewers")),
    ).toHaveLength(1);
  });
});

function stageOptions(
  dir: string,
  extra: Partial<YouTubeStageOptions> = {},
): YouTubeStageOptions {
  const manifest = readMediaManifest(join(dir, "media.json"), dir);
  return {
    job: JOB,
    output: OUTPUT,
    mode: "live",
    stub: false,
    runName: "job-demo-videos-1",
    runUrl: RUN_URL,
    report: new ReportWriter(scratch(), []),
    now: NOW,
    media: { dir, manifest },
    linkHosts: LINKS,
    slackLinks: ["https://github.com/notes-co/"],
    readDocs: () => Promise.resolve({ state: docsState(), secrets: [] }),
    openYouTube: () => Promise.reject(new Error("not in this test")),
    openWriter: () => Promise.reject(new Error("not in this test")),
    openPoster: () => Promise.reject(new Error("not in this test")),
    ...extra,
  };
}

describe("the upload limit", () => {
  it("uploads the videos the map never had first, then those it has had longest, and leaves the rest", () => {
    const plan = [
      {
        id: "newest",
        action: "upload",
        recorded: { publishedAt: "2026-10-01" },
      },
      {
        id: "skipped",
        action: "skip",
        recorded: { publishedAt: "2026-01-01" },
      },
      { id: "first", action: "upload" },
      {
        id: "oldest",
        action: "upload",
        recorded: { publishedAt: "2026-08-01" },
      },
      {
        id: "middle",
        action: "upload",
        recorded: { publishedAt: "2026-09-01" },
      },
    ];
    expect(deferOverLimit(plan, 3).map((v) => [v.id, v.action])).toEqual([
      ["newest", "defer"],
      ["skipped", "skip"],
      ["first", "upload"],
      ["oldest", "upload"],
      ["middle", "upload"],
    ]);
    expect(deferOverLimit(plan, 4)).toBe(plan);
  });
});

describe("the youtube delivery step", () => {
  it("in shadow keeps the plan and a readable page, skips media the map records, and uploads nothing", async () => {
    const dir = mediaDir();
    const written = writeMedia(dir, {
      "dashboard-overview": OVERVIEW,
      smoke: { title: "Smoke", chapters: [] },
    });
    const opened: string[] = [];
    const report = new ReportWriter(scratch(), []);
    const got = await runYouTubeStage(
      stageOptions(dir, {
        mode: "shadow",
        report,
        readDocs: () =>
          Promise.resolve({
            state: docsState({
              text: recordedMap({
                smoke: {
                  id: "smokexxxxxx",
                  hash: scenarioHash(written, "smoke"),
                },
                "dashboard-overview": { id: "oldoldoldol", hash: "0" },
              }),
            }),
            secrets: [],
          }),
        openYouTube: () => {
          opened.push("youtube");
          return Promise.reject(new Error("no"));
        },
      }),
    );
    expect(got.failure).toBeUndefined();
    expect(got.record).toEqual({
      outcome: "shadow",
      reason:
        "a shadow run uploads nothing; delivery/youtube.md holds what it would upload",
      docsRepo: DOCS,
      mapPath: MAP,
      base: BASE,
      videos: [
        {
          scenario: "dashboard-overview",
          action: "upload",
          hash: scenarioHash(written, "dashboard-overview"),
          replaces: "oldoldoldol",
        },
        {
          scenario: "smoke",
          action: "skip",
          hash: scenarioHash(written, "smoke"),
        },
      ],
      quotaUnits: 2051,
    });
    expect(opened).toEqual([]);
    const out = files(report.dir);
    const plan = JSON.parse(out.get("delivery/youtube-plan.json")!);
    expect(plan.uploads).toBe(1);
    expect(plan.videos[0].resource).toEqual({
      snippet: {
        title: OVERVIEW.title,
        description: `${OVERVIEW.description}\n\n0:00 Intro\n0:12 Survey\n0:40 Portfolio\n\n${questionsLine()}`,
        tags: OVERVIEW.tags,
        categoryId: "28",
        defaultLanguage: "en",
        defaultAudioLanguage: "en",
      },
      status: {
        privacyStatus: "private",
        selfDeclaredMadeForKids: false,
        embeddable: true,
      },
    });
    expect(plan.videos[1].recorded.youtubeId).toBe("smokexxxxxx");
    expect(out.get("delivery/youtube.md")).toContain(
      "## dashboard-overview: upload",
    );
    expect(out.get("delivery/youtube.md")).toContain(
      "The map records `smokexxxxxx` with this media hash",
    );
    expect(JSON.parse(out.get("youtube-check.json")!).ok).toBe(true);
  });

  it("leaves uploads past four for the next run, and refuses metadata that breaks the rules", async () => {
    const many = mediaDir();
    writeMedia(
      many,
      Object.fromEntries(
        ["a1", "a2", "a3", "a4", "a5"].map((id) => [id, { title: id }]),
      ),
    );
    const got = await runYouTubeStage(stageOptions(many, { mode: "shadow" }));
    expect([got.failure, got.record.outcome]).toEqual([undefined, "shadow"]);
    expect(got.record.videos.map((v) => [v.scenario, v.action])).toEqual([
      ["a1", "upload"],
      ["a2", "upload"],
      ["a3", "upload"],
      ["a4", "upload"],
      ["a5", "defer"],
    ]);
    // Quota for the four that go up, not the fifth.
    expect(got.record.quotaUnits).toBeLessThan(10_000);
    const bad = mediaDir();
    writeMedia(bad, { smoke: { title: "x".repeat(101) } });
    const refused = await runYouTubeStage(stageOptions(bad));
    expect(refused.failure).toBe(
      "the videos' metadata breaks YouTube's or the kit's rules (1 problem; first: videos[0].title is 101 characters, over the limit of 100); see youtube-check.json",
    );
  });

  it("live, uploads nothing while the job's map pull request is open, or when the map records every hash", async () => {
    const dir = mediaDir();
    const written = writeMedia(dir, { smoke: { title: "Smoke" } });
    const open = await runYouTubeStage(
      stageOptions(dir, {
        readDocs: () =>
          Promise.resolve({
            state: docsState({
              openPulls: [{ number: 9, url: "u", branch: `agent/${JOB}/x` }],
            }),
            secrets: [],
          }),
      }),
    );
    expect(open.failure).toBeUndefined();
    expect(open.record.outcome).toBe("report_only");
    expect(open.record.reason).toBe(
      `the job's map pull request #9 in ${DOCS} is still open; merge or close it, then run again`,
    );
    const same = await runYouTubeStage(
      stageOptions(dir, {
        readDocs: () =>
          Promise.resolve({
            state: docsState({
              text: recordedMap({
                smoke: {
                  id: "smokexxxxxx",
                  hash: scenarioHash(written, "smoke"),
                },
              }),
            }),
            secrets: [],
          }),
      }),
    );
    expect([same.record.outcome, same.record.reason]).toEqual([
      "nothing",
      "the map records every video's media hash or source",
    ]);
  });

  it("skips a scenario whose source the map records, and uploads when either side has no source", async () => {
    const A = "a".repeat(64);
    const B = "b".repeat(64);
    const dir = mediaDir();
    const written = writeMedia(dir, {
      same: { title: "Same", source: A },
      changed: { title: "Changed", source: A },
      unrecorded: { title: "Unrecorded", source: A },
      nosource: { title: "No source" },
    });
    const report = new ReportWriter(scratch(), []);
    const got = await runYouTubeStage(
      stageOptions(dir, {
        mode: "shadow",
        report,
        readDocs: () =>
          Promise.resolve({
            state: docsState({
              text: recordedMap({
                same: { id: "samexxxxxxx", hash: "0", source: A },
                changed: { id: "changedxxxx", hash: "0", source: B },
                unrecorded: { id: "unrecordedx", hash: "0" },
                nosource: { id: "nosourcexxx", hash: "0", source: A },
              }),
            }),
            secrets: [],
          }),
      }),
    );
    expect(got.failure).toBeUndefined();
    expect(
      got.record.videos.map((v) => [v.scenario, v.action, v.source]),
    ).toEqual([
      ["changed", "upload", A],
      ["nosource", "upload", undefined],
      ["same", "skip", A],
      ["unrecorded", "upload", A],
    ]);
    const page = files(report.dir).get("delivery/youtube.md")!;
    expect(page).toContain(
      `The map records \`samexxxxxxx\` with this source, \`${A.slice(0, 12)}\`.`,
    );
    expect(page).toContain(
      `Media hash \`${scenarioHash(written, "changed").slice(0, 12)}\`, source \`${A.slice(0, 12)}\`, the map records \`changedxxxx\` with media hash \`0\` and source \`${B.slice(0, 12)}\`.`,
    );
  });

  it("live, uploads private with captions, thumbnail and playlist, records the ids in a pull request and posts one review notice", async () => {
    const dir = mediaDir();
    writeMedia(dir, {
      "dashboard-overview": OVERVIEW,
      smoke: {
        title: "Smoke",
        chapters: [],
        playlist: "Tests",
        source: "c".repeat(64),
      },
    });
    const yt = fakeYouTube({
      playlists: { PLdemosdemos1: "Demos", PLteststests: "Tests" },
    });
    const writer = new FakeWriter();
    writer.put(DOCS, BASE, MAP, "{}\n");
    const poster = recordingPoster();
    let closed = 0;
    const report = new ReportWriter(scratch(), []);
    const got = await runYouTubeStage(
      stageOptions(dir, {
        output: { ...OUTPUT, playlist: "Demos", notify: "product" },
        notify: { name: "product", id: "C0TEST00001" },
        report,
        readDocs: () =>
          Promise.resolve({ state: docsState({ text: "{}\n" }), secrets: [] }),
        openYouTube: () => openFake(yt),
        openWriter: (repos) => {
          expect(repos).toEqual([DOCS]);
          return Promise.resolve({
            writer,
            secrets: [],
            close: () => {
              closed++;
              return Promise.resolve();
            },
          });
        },
        openPoster: poster.open,
      }),
    );
    expect(got.failure).toBeUndefined();
    expect(got.record.outcome).toBe("delivered");
    expect(
      got.record.videos.map((v) => [v.scenario, v.youtubeId, v.playlist]),
    ).toEqual([
      ["dashboard-overview", "vid1xxxxxxx", "Demos"],
      ["smoke", "vid2xxxxxxx", "Tests"],
    ]);
    const calls = yt.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`);
    expect(calls).toEqual([
      "POST https://oauth2.test/token",
      "GET https://yt.test/youtube/v3/channels",
      "GET https://yt.test/youtube/v3/playlists",
      "GET https://yt.test/youtube/v3/playlists",
      "POST https://yt.test/upload/youtube/v3/videos",
      "PUT https://yt.test/upload/youtube/v3/videos",
      "POST https://yt.test/upload/youtube/v3/captions",
      "POST https://yt.test/upload/youtube/v3/thumbnails/set",
      "POST https://yt.test/youtube/v3/playlistItems",
      "POST https://yt.test/upload/youtube/v3/videos",
      "PUT https://yt.test/upload/youtube/v3/videos",
      "POST https://yt.test/upload/youtube/v3/captions",
      "POST https://yt.test/upload/youtube/v3/thumbnails/set",
      "POST https://yt.test/youtube/v3/playlistItems",
    ]);
    const items = yt.calls
      .filter((c) => c.url.includes("playlistItems"))
      .map((c) => JSON.parse(String(c.body)).snippet.playlistId);
    expect(items).toEqual(["PLdemosdemos1", "PLteststests"]);
    expect(closed).toBe(1);
    const map = JSON.parse(
      (writer.commits[0]!.request.files[0] as { text: string }).text,
    );
    expect(Object.keys(map)).toEqual(["dashboard-overview", "smoke"]);
    expect(map.smoke).toEqual({
      youtubeId: "vid2xxxxxxx",
      title: "Smoke",
      hash: got.record.videos[1]!.hash,
      source: "c".repeat(64),
      publishedAt: NOW.toISOString(),
    });
    expect(got.record.pull?.number).toBe(100);
    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0]!.channel).toBe("C0TEST00001");
    expect(poster.posts[0]!.text).toBe(
      `${JOB}: 2 demo videos uploaded to YouTube as private, waiting for review`,
    );
    const blocks = JSON.stringify(poster.posts[0]!.blocks);
    expect(blocks).toContain(
      "<https://studio.youtube.com/video/vid1xxxxxxx/edit|dashboard-overview>",
    );
    expect(blocks).toContain(
      "<https://github.com/notes-co/public-docs/pull/100|notes-co/public-docs#100>",
    );
    expect(got.record.notice?.permalink).toBe(
      "https://notes-co.slack.com/archives/C0TEST00001/p1790799964081439",
    );
    const out = files(report.dir);
    expect(JSON.parse(out.get("delivery/youtube-notice.json")!).channel).toBe(
      "C0TEST00001",
    );
  });

  it("live, with docs_media_dir, commits each video's poster and captions and names them in the map entry with its description, chapters and length", async () => {
    const dir = mediaDir();
    writeMedia(dir, { "dashboard-overview": OVERVIEW });
    const yt = fakeYouTube();
    const writer = new FakeWriter();
    writer.put(DOCS, BASE, MAP, "{}\n");
    const got = await runYouTubeStage(
      stageOptions(dir, {
        output: { ...OUTPUT, docs_media_dir: "public/videos" },
        readDocs: () =>
          Promise.resolve({ state: docsState({ text: "{}\n" }), secrets: [] }),
        openYouTube: () => openFake(yt),
        openWriter: () =>
          Promise.resolve({
            writer,
            secrets: [],
            close: () => Promise.resolve(),
          }),
      }),
    );
    expect(got.failure).toBeUndefined();
    const commit = writer.commits[0]!.request;
    expect(commit.files.map((x) => x.path)).toEqual([
      MAP,
      "public/videos/dashboard-overview/poster.png",
      "public/videos/dashboard-overview/captions.vtt",
    ]);
    const bytes = (path: string) =>
      (commit.files.find((x) => x.path === path) as { bytes: Buffer }).bytes;
    expect(bytes("public/videos/dashboard-overview/poster.png")).toEqual(
      readFileSync(join(dir, "dashboard-overview/poster.png")),
    );
    expect(bytes("public/videos/dashboard-overview/captions.vtt")).toEqual(
      readFileSync(join(dir, "dashboard-overview/captions.vtt")),
    );
    const map = JSON.parse((commit.files[0] as { text: string }).text);
    expect(map["dashboard-overview"]).toMatchObject({
      youtubeId: "vid1xxxxxxx",
      description: OVERVIEW.description,
      chapters: OVERVIEW.chapters,
      duration: 150,
      poster: "/videos/dashboard-overview/poster.png",
      captions: "/videos/dashboard-overview/captions.vtt",
    });
    expect(writer.pulls[0]!.body).toContain(
      "with its poster and captions in `public/videos/dashboard-overview/` for the docs' video page",
    );
  });

  it("without docs_media_dir, changes only the map file", async () => {
    const dir = mediaDir();
    writeMedia(dir, { "dashboard-overview": OVERVIEW });
    const writer = new FakeWriter();
    writer.put(DOCS, BASE, MAP, "{}\n");
    const got = await runYouTubeStage(
      stageOptions(dir, {
        readDocs: () =>
          Promise.resolve({ state: docsState({ text: "{}\n" }), secrets: [] }),
        openYouTube: () => openFake(fakeYouTube()),
        openWriter: () =>
          Promise.resolve({
            writer,
            secrets: [],
            close: () => Promise.resolve(),
          }),
      }),
    );
    expect(got.failure).toBeUndefined();
    const commit = writer.commits[0]!.request;
    expect(commit.files.map((x) => x.path)).toEqual([MAP]);
    expect(
      Object.keys(
        JSON.parse((commit.files[0] as { text: string }).text)[
          "dashboard-overview"
        ],
      ),
    ).toEqual(["youtubeId", "title", "hash", "publishedAt"]);
  });

  it("live, delivers the scenarios that were recorded, names each one the media stage could not record, and fails the run", async () => {
    const dir = mediaDir();
    writeMedia(dir, { "dashboard-overview": OVERVIEW }, (m) => {
      (m.data as Record<string, unknown>).failed = [
        {
          scenario: "board-ready-posture",
          reason:
            "TimeoutError: locator.waitFor:\n  Timeout 15000ms exceeded | trend-row",
        },
        { scenario: "../escape", reason: "dropped" },
      ];
    });
    const yt = fakeYouTube();
    const writer = new FakeWriter();
    writer.put(DOCS, BASE, MAP, "{}\n");
    const report = new ReportWriter(scratch(), []);
    const got = await runYouTubeStage(
      stageOptions(dir, {
        report,
        readDocs: () =>
          Promise.resolve({ state: docsState({ text: "{}\n" }), secrets: [] }),
        openYouTube: () => openFake(yt),
        openWriter: () =>
          Promise.resolve({
            writer,
            secrets: [],
            close: () => Promise.resolve(),
          }),
      }),
    );
    const reason =
      "TimeoutError: locator.waitFor: Timeout 15000ms exceeded | trend-row";
    const note = `1 scenario was not recorded: board-ready-posture (${reason})`;
    expect(got.record.outcome).toBe("delivered");
    expect(got.record.videos.map((v) => [v.scenario, v.youtubeId])).toEqual([
      ["dashboard-overview", "vid1xxxxxxx"],
    ]);
    expect(got.record.notRecorded).toEqual([
      { scenario: "board-ready-posture", reason },
    ]);
    expect(got.record.reason).toBe(note);
    expect(got.failure).toBe(note);
    expect(writer.pulls[0]!.body).toContain(
      "- `board-ready-posture`: not recorded this run, so its video is unchanged: TimeoutError",
    );
    expect(writer.checks[0]).toMatchObject({
      conclusion: "neutral",
      title:
        "1 video uploaded as private; publish in YouTube Studio before merging; 1 not recorded this run",
    });
    expect(writer.checks[0]!.summary).toContain(
      "**Not recorded this run** (their videos are unchanged):",
    );
    expect(writer.checks[0]!.summary).toContain("- `board-ready-posture`: ");
    expect(files(report.dir).get("delivery/youtube.md")).toContain(
      "## board-ready-posture: not recorded",
    );
  });

  it("in shadow, keeps the plan for the recorded scenarios and still fails, naming the missing one", async () => {
    const dir = mediaDir();
    writeMedia(dir, { "dashboard-overview": OVERVIEW }, (m) => {
      (m.data as Record<string, unknown>).failed = [
        { scenario: "finding-to-fix", reason: "seed failed" },
        { scenario: "board-ready-posture", reason: "timeout" },
      ];
    });
    const got = await runYouTubeStage(stageOptions(dir, { mode: "shadow" }));
    expect(got.record.outcome).toBe("shadow");
    expect(got.record.videos.map((v) => v.scenario)).toEqual([
      "dashboard-overview",
    ]);
    expect(got.failure).toBe(
      "2 scenarios were not recorded: finding-to-fix (seed failed); board-ready-posture (timeout)",
    );
    expect(got.record.reason).toBe(
      "a shadow run uploads nothing; delivery/youtube.md holds what it would upload; 2 scenarios were not recorded: finding-to-fix (seed failed); board-ready-posture (timeout)",
    );
  });

  it("live, refuses a grant for another channel and uploads nothing, opens nothing", async () => {
    const dir = mediaDir();
    writeMedia(dir, { smoke: { title: "Smoke" } });
    const yt = fakeYouTube({ channels: ["UCxxxxxxxxxxxxxxxxxxxxxx"] });
    const writer = new FakeWriter();
    const got = await runYouTubeStage(
      stageOptions(dir, {
        openYouTube: () => openFake(yt),
        openWriter: () =>
          Promise.resolve({
            writer,
            secrets: [],
            close: () => Promise.resolve(),
          }),
      }),
    );
    expect(got.failure).toBe(
      `the YouTube uploader could not start: the YouTube grant answers for channel UCxxxxxxxxxxxxxxxxxxxxxx, not ${CHANNEL} (YOUTUBE_CHANNEL_ID); nothing was uploaded`,
    );
    expect(yt.calls.some((c) => c.url.includes("/upload/"))).toBe(false);
    expect(writer.calls).toEqual([]);
  });

  it("live, records what finished when a later upload fails, and names the incomplete video to delete", async () => {
    const dir = mediaDir();
    writeMedia(dir, { a1: { title: "One" }, a2: { title: "Two" } });
    const yt = fakeYouTube();
    const writer = new FakeWriter();
    writer.put(DOCS, BASE, MAP, "{}\n");
    let captions = 0;
    const got = await runYouTubeStage(
      stageOptions(dir, {
        readDocs: () =>
          Promise.resolve({ state: docsState({ text: "{}\n" }), secrets: [] }),
        openYouTube: async () => {
          const opened = await openFake(yt);
          const real = opened.youtube.insertCaptions.bind(opened.youtube);
          opened.youtube.insertCaptions = (id, vtt) =>
            ++captions === 2
              ? Promise.reject(
                  new Error("captions.insert returned 403 (quotaExceeded)"),
                )
              : real(id, vtt);
          return opened;
        },
        openWriter: () =>
          Promise.resolve({
            writer,
            secrets: [],
            close: () => Promise.resolve(),
          }),
      }),
    );
    expect(got.failure).toBe(
      "uploading a2 failed: captions.insert returned 403 (quotaExceeded); vid2xxxxxxx (a2) is on the channel, private and incomplete: delete it in YouTube Studio",
    );
    expect(got.record.orphans).toEqual([
      { scenario: "a2", youtubeId: "vid2xxxxxxx" },
    ]);
    const map = JSON.parse(
      (writer.commits[0]!.request.files[0] as { text: string }).text,
    );
    expect(Object.keys(map)).toEqual(["a1"]);
  });
});

const EPISODE_ID = "whats-new-2026-10-14";
const EPISODE_SOURCE = '{\n  "items": [{ "title": "Org switcher" }]\n}\n';
const EPISODE_TITLE = "What's new: Org switcher, October 14, 2026";
const EPISODE = {
  title: EPISODE_TITLE,
  chapters: [],
  scenarioFile: { bytes: EPISODE_SOURCE, path: "2026-10-14.json" },
  leftOut: [
    {
      title: "CBOM export",
      why: "no recording yet for notes cbom export, see <https://elsewhere.example/x|here>",
    },
  ],
};
const EPISODE_OUTPUT = {
  ...OUTPUT,
  notify: "product",
  docs_source_dir: "scenarios/whats-new",
  video_noun: "What's new episode",
};
const SHADOW = { name: "agents-shadow", id: "C0TEST00019" };

function liveWriter() {
  const writer = new FakeWriter();
  writer.put(DOCS, BASE, MAP, "{}\n");
  return {
    writer,
    open: () =>
      Promise.resolve({
        writer,
        secrets: [],
        close: () => Promise.resolve(),
      }),
  };
}

const READ_EMPTY_MAP = () =>
  Promise.resolve({ state: docsState({ text: "{}\n" }), secrets: [] });

describe("the youtube options an episode job sets", () => {
  it("live, with docs_source_dir and video_noun, commits each video's scenario source byte for byte, names the episode and lists what was left out", async () => {
    const dir = mediaDir();
    writeMedia(dir, { [EPISODE_ID]: EPISODE });
    const { writer, open } = liveWriter();
    const poster = recordingPoster();
    const report = new ReportWriter(scratch(), []);
    const got = await runYouTubeStage(
      stageOptions(dir, {
        output: EPISODE_OUTPUT,
        notify: { name: "product", id: "C0TEST00001" },
        report,
        readDocs: READ_EMPTY_MAP,
        openYouTube: () => openFake(fakeYouTube()),
        openWriter: open,
        openPoster: poster.open,
      }),
    );
    expect(got.failure).toBeUndefined();
    expect(got.record.outcome).toBe("delivered");
    const commit = writer.commits[0]!.request;
    expect(commit.files.map((x) => x.path)).toEqual([
      MAP,
      "scenarios/whats-new/2026-10-14.json",
    ]);
    const committed = commit.files.find(
      (x) => x.path === "scenarios/whats-new/2026-10-14.json",
    ) as { bytes: Buffer };
    expect(committed.bytes).toEqual(readFileSync(join(dir, "2026-10-14.json")));
    expect(committed.bytes.toString("utf8")).toBe(EPISODE_SOURCE);
    expect(
      Object.keys(
        JSON.parse((commit.files[0] as { text: string }).text)[EPISODE_ID],
      ),
    ).toEqual(["youtubeId", "title", "hash", "publishedAt"]);
    const out = files(report.dir);
    expect(out.get("delivery/youtube-sources/2026-10-14.json")).toBe(
      EPISODE_SOURCE,
    );
    const body = writer.pulls[0]!.body;
    expect(body).toContain(
      "Points the docs at 1 new What's new episode, uploaded to the Notes Co YouTube channel as **private**.",
    );
    expect(body).toContain(
      ", with its scenario source at `scenarios/whats-new/2026-10-14.json`. Recorded because",
    );
    expect(body).toContain(
      "  - Left out of this video: CBOM export: no recording yet for notes cbom export, see &lt;https:\u2060//elsewhere.example/x\\|here&gt;",
    );
    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0]!.text).toBe(
      `${JOB}: 1 What's new episode uploaded to YouTube as private, waiting for review`,
    );
    expect(poster.posts[0]!.blocks[2]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Left out of What's new: Org switcher, October 14, 2026:\n• CBOM export: no recording yet for notes cbom export, see &lt;https://elsewhere.example/x|here&gt;",
        verbatim: true,
      },
    });
    const plan = out.get("delivery/youtube.md")!;
    expect(plan).toContain(
      "- Scenario source: `2026-10-14.json`, committed as `scenarios/whats-new/2026-10-14.json`",
    );
    expect(plan).toContain("- Left out: CBOM export: no recording yet");
    const planJson = JSON.parse(out.get("delivery/youtube-plan.json")!);
    expect(planJson.videos[0].files.scenarioFile.path).toBe("2026-10-14.json");
    expect(planJson.videos[0].leftOut).toEqual(EPISODE.leftOut);
  });

  it("in shadow, keeps the scenario source in the report, commits nothing and posts one line with the run link to the shadow channel", async () => {
    const dir = mediaDir();
    writeMedia(dir, { [EPISODE_ID]: EPISODE });
    const poster = recordingPoster();
    const report = new ReportWriter(scratch(), []);
    const got = await runYouTubeStage(
      stageOptions(dir, {
        mode: "shadow",
        output: EPISODE_OUTPUT,
        notify: { name: "product", id: "C0TEST00001" },
        shadowChannel: SHADOW,
        report,
        readDocs: READ_EMPTY_MAP,
        openPoster: poster.open,
      }),
    );
    expect(got.failure).toBeUndefined();
    expect(got.record.outcome).toBe("shadow");
    expect(got.record.problems).toBeUndefined();
    expect(got.record.notice?.channel).toBe(SHADOW.id);
    expect(poster.posts).toEqual([
      {
        channel: SHADOW.id,
        text: `Shadow run of ${JOB}, not a live post. ${JOB} would upload 1 What's new episode to YouTube as private for review: ${RUN_URL}`,
        blocks: [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `Shadow run of ${JOB}, not a live post. Live, it posts to #product.`,
                verbatim: true,
              },
            ],
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${JOB}* would upload 1 What's new episode to YouTube as private for review (${EPISODE_TITLE}); <${RUN_URL}|workflow run 36606095916> keeps it and the upload plan.`,
              verbatim: true,
            },
          },
        ],
      },
    ]);
    const out = files(report.dir);
    expect(out.get("delivery/youtube-sources/2026-10-14.json")).toBe(
      EPISODE_SOURCE,
    );
    expect(JSON.parse(out.get("delivery/youtube-notice.json")!).channel).toBe(
      SHADOW.id,
    );

    // No shadow channel id: the line is kept in the report and posted nowhere.
    const quiet = recordingPoster();
    const noChannel = new ReportWriter(scratch(), []);
    const unposted = await runYouTubeStage(
      stageOptions(dir, {
        mode: "shadow",
        output: EPISODE_OUTPUT,
        notify: { name: "product", id: "C0TEST00001" },
        report: noChannel,
        readDocs: READ_EMPTY_MAP,
        openPoster: quiet.open,
      }),
    );
    expect([unposted.failure, unposted.record.notice]).toEqual([
      undefined,
      undefined,
    ]);
    expect(quiet.posts).toEqual([]);
    expect(
      JSON.parse(files(noChannel.dir).get("delivery/youtube-notice.json")!)
        .channel,
    ).toBe(null);

    // A stub run, a job without notify, and a run with nothing to upload post nothing.
    const stub = await runYouTubeStage(
      stageOptions(dir, {
        mode: "shadow",
        stub: true,
        output: EPISODE_OUTPUT,
        notify: { name: "product", id: "C0TEST00001" },
        shadowChannel: SHADOW,
        openPoster: quiet.open,
      }),
    );
    expect(stub.record.reason).toBe("a stub run uploads nothing");
    await runYouTubeStage(
      stageOptions(dir, {
        mode: "shadow",
        output: EPISODE_OUTPUT,
        shadowChannel: SHADOW,
        openPoster: quiet.open,
      }),
    );
    const written = writeMedia(mediaDir(), { [EPISODE_ID]: EPISODE });
    const recorded = await runYouTubeStage(
      stageOptions(dir, {
        mode: "shadow",
        output: EPISODE_OUTPUT,
        notify: { name: "product", id: "C0TEST00001" },
        shadowChannel: SHADOW,
        readDocs: () =>
          Promise.resolve({
            state: docsState({
              text: recordedMap({
                [EPISODE_ID]: {
                  id: "episodexxxx",
                  hash: scenarioHash(written, EPISODE_ID),
                },
              }),
            }),
            secrets: [],
          }),
        openPoster: quiet.open,
      }),
    );
    expect(recorded.record.videos.map((v) => v.action)).toEqual(["skip"]);
    expect(quiet.posts).toEqual([]);
  });

  it("in shadow, records a line it could not post as a problem and still passes", async () => {
    const dir = mediaDir();
    writeMedia(dir, { [EPISODE_ID]: EPISODE });
    const got = await runYouTubeStage(
      stageOptions(dir, {
        mode: "shadow",
        output: EPISODE_OUTPUT,
        notify: { name: "product", id: "C0TEST00001" },
        shadowChannel: SHADOW,
        openPoster: () => Promise.reject(new Error("not_in_channel")),
      }),
    );
    expect(got.failure).toBeUndefined();
    expect(got.record.problems).toEqual([
      "the shadow notice to #agents-shadow failed: not_in_channel",
    ]);
  });

  it("refuses, before any upload, a video with no scenario source, a source that is not UTF-8 JSON, and one that holds a secret", async () => {
    const opened: string[] = [];
    const attempt = async (
      scenario: Parameters<typeof writeMedia>[1][string],
      secrets: string[] = [],
    ) => {
      const dir = mediaDir();
      writeMedia(dir, { smoke: { title: "Smoke", ...scenario } });
      return runYouTubeStage(
        stageOptions(dir, {
          output: EPISODE_OUTPUT,
          report: new ReportWriter(scratch(), secrets),
          readDocs: READ_EMPTY_MAP,
          openYouTube: () => {
            opened.push("youtube");
            return Promise.reject(new Error("no"));
          },
        }),
      );
    };
    expect((await attempt({})).failure).toBe(
      "media.json: data.scenarios.smoke names no scenarioFile, and docs_source_dir commits one for every video",
    );
    expect((await attempt({ scenarioFile: { bytes: "{" } })).failure).toBe(
      "smoke's scenarioFile smoke/scenario.json is not JSON",
    );
    expect(
      (
        await attempt({
          scenarioFile: { bytes: Buffer.from([0x22, 0xff, 0x22]) },
        })
      ).failure,
    ).toBe("smoke's scenarioFile smoke/scenario.json is not UTF-8");
    const secret = ["hunter", "two", "secret"].join("-");
    expect(
      (
        await attempt({ scenarioFile: { bytes: `{"x":"${secret}"}` } }, [
          secret,
        ])
      ).failure,
    ).toBe(
      "smoke's scenarioFile smoke/scenario.json holds a secret value, so it is neither kept nor committed",
    );
    expect(opened).toEqual([]);
  });

  it("ends with outcome nothing, reading no map and uploading nothing, when the media stage made no video", async () => {
    for (const mode of ["live", "shadow"] as const) {
      const dir = mediaDir();
      writeMedia(dir, {});
      const report = new ReportWriter(scratch(), []);
      const calls: string[] = [];
      const got = await runYouTubeStage(
        stageOptions(dir, {
          mode,
          output: EPISODE_OUTPUT,
          notify: { name: "product", id: "C0TEST00001" },
          shadowChannel: SHADOW,
          report,
          readDocs: () => {
            calls.push("read");
            return READ_EMPTY_MAP();
          },
          openYouTube: () => {
            calls.push("youtube");
            return Promise.reject(new Error("no"));
          },
          openPoster: () => {
            calls.push("poster");
            return Promise.reject(new Error("no"));
          },
        }),
      );
      expect(got).toEqual({
        record: {
          outcome: "nothing",
          reason: "the media stage made no video this run",
          docsRepo: DOCS,
          mapPath: MAP,
          videos: [],
          quotaUnits: 0,
        },
      });
      expect(calls).toEqual([]);
      expect(files(report.dir).get("delivery/youtube.md")).toContain(
        "The media stage made no video this run",
      );
    }
    const failed = mediaDir();
    writeMedia(failed, {}, (m) => {
      (m.data as Record<string, unknown>).failed = [
        { scenario: "whats-new-2026-10-14", reason: "every item was dropped" },
      ];
    });
    const got = await runYouTubeStage(stageOptions(failed));
    expect(got.record.outcome).toBe("nothing");
    expect(got.failure).toBe(
      "1 scenario was not recorded: whats-new-2026-10-14 (every item was dropped)",
    );
  });

  it("without the new keys, posts the same notice and opens the same map pull request as before, even when media.json names a scenario source", async () => {
    const dir = mediaDir();
    writeMedia(dir, {
      smoke: { title: "Smoke", chapters: [], scenarioFile: { bytes: "{}" } },
    });
    const { writer, open } = liveWriter();
    const poster = recordingPoster();
    const report = new ReportWriter(scratch(), []);
    const got = await runYouTubeStage(
      stageOptions(dir, {
        output: { ...OUTPUT, notify: "product" },
        notify: { name: "product", id: "C0TEST00001" },
        shadowChannel: SHADOW,
        report,
        readDocs: READ_EMPTY_MAP,
        openYouTube: () => openFake(fakeYouTube()),
        openWriter: open,
        openPoster: poster.open,
      }),
    );
    expect(got.failure).toBeUndefined();
    expect(writer.commits[0]!.request.files.map((x) => x.path)).toEqual([MAP]);
    expect(writer.pulls[0]!.body!.split("\n").slice(0, 12)).toEqual([
      `Points the docs at 1 new demo video, uploaded to the Notes Co YouTube channel as **private**. Opened by the Notes Agent \`${JOB}\`; a person reviews and merges it.`,
      "",
      "**Before merging**",
      "",
      "1. Watch each video in YouTube Studio (links below) and set it to Public or Unlisted. The docs embed a video only once this pull request is merged.",
      "2. Merge.",
      "3. Nothing else: within a day the Notes Agent takes each replaced video out of its playlist and sets it to unlisted.",
      "",
      "**What changed and why**",
      "",
      "- `smoke`: [Smoke](https://studio.youtube.com/video/vid1xxxxxxx/edit), the scenario's first video. Recorded because the scenario changed since its last published video.",
      "",
    ]);
    expect(poster.posts).toEqual([
      {
        channel: "C0TEST00001",
        text: `${JOB}: 1 demo video uploaded to YouTube as private, waiting for review`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${JOB}*: 1 demo video uploaded to YouTube as private, waiting for review.`,
              verbatim: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "• <https://studio.youtube.com/video/vid1xxxxxxx/edit|smoke>: Smoke",
              verbatim: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Watch each one in YouTube Studio and set it to Public or Unlisted there, then merge <https://github.com/notes-co/public-docs/pull/100|notes-co/public-docs#100>, which records the new ids for the docs.",
              verbatim: true,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `<${RUN_URL}|Workflow run 36606095916> · job ${JOB} · model none`,
                verbatim: true,
              },
            ],
          },
        ],
      },
    ]);
    const out = files(report.dir);
    expect([...out.keys()].some((k) => k.includes("youtube-sources"))).toBe(
      false,
    );
    expect(out.get("delivery/youtube.md")).not.toContain("Scenario source");
    expect(
      JSON.parse(out.get("delivery/youtube-plan.json")!).videos[0].leftOut,
    ).toBeUndefined();
  });
});

const SHADOW_LINKS = Array.from(
  { length: 4 },
  (_, i) =>
    `- https://github.com/notes-co/agents/actions/runs/${i + 1}`,
).join("\n");

function youtubeJob(overrides: Record<string, unknown> = {}): JobConfig {
  return {
    name: JOB,
    owner: "octocat",
    purpose: "Uploads the demo videos for review.",
    trigger: { manual: true },
    model: "none",
    tools: [],
    media: { network: "public", secrets: [], timeout_minutes: 5 },
    output: OUTPUT,
    mode: "shadow",
    ...overrides,
  } as JobConfig;
}

async function youtubeRepo(
  config: JobConfig,
  extra: Record<string, string | null> = {},
  shadow?: { id: string; name: string },
): Promise<string> {
  const root = makeRepo({
    jobs: {
      [JOB]: {
        "job.yml": stringify(config),
        ...(config.media === undefined ? {} : { "media.ts": "export {};\n" }),
        ...(config.mode === "live" ? { "SHADOW_RUNS.md": SHADOW_LINKS } : {}),
        ...extra,
      },
    },
    repos: [REPO, DOCS],
    channels: {
      post: [POST_CHANNEL, { id: "C0TEST00001", name: "product" }],
      read: [READ_CHANNEL],
      ...(shadow === undefined ? {} : { shadow }),
    },
  });
  await generate(loadRepo(root));
  return root;
}

/** Options for a run of the job; readDocs: undefined leaves the reader stand-in out. */
function runOptions(
  root: string,
  media: string,
  extra: Omit<Partial<RunOptions>, "readDocs"> & {
    readDocs?: RunOptions["readDocs"] | undefined;
  } = {},
): RunOptions {
  const dir = scratch();
  const { readDocs, ...rest } = extra;
  const opts: RunOptions = {
    root,
    name: JOB,
    scratch: dir,
    out: join(dir, "report"),
    env: { PATH: process.env.PATH ?? "", ...RUN_ENV },
    log: () => {},
    now: () => NOW,
    mediaDir: media,
    readDocs: (repo, path, job) => {
      expect([repo, path, job]).toEqual([DOCS, MAP, JOB]);
      return Promise.resolve({
        state: docsState({ text: "{}\n" }),
        secrets: [],
      });
    },
    ...rest,
  };
  if ("readDocs" in extra) {
    if (readDocs === undefined) delete opts.readDocs;
    else opts.readDocs = readDocs;
  }
  return opts;
}

describe("a youtube job with model: none", () => {
  it("in shadow runs no box and no model, and keeps the plan, the media manifest and a summary", async () => {
    const root = await youtubeRepo(youtubeJob());
    const media = mediaDir();
    writeMedia(media, { "dashboard-overview": OVERVIEW });
    const opts = runOptions(root, media, {
      env: { PATH: process.env.PATH ?? "", ...RUN_ENV },
    });
    const result = await runJob(opts);
    expect(result.messages[0]).toBe(`${JOB}: delivered without a model.`);
    const out = files(opts.out!);
    const status = JSON.parse(out.get("status.json")!);
    expect([
      status.launcher,
      status.model,
      status.thinking,
      status.inputSource,
    ]).toEqual(["none", "none", undefined, "media"]);
    expect(status.youtube.outcome).toBe("shadow");
    expect(status.gateway).toBeUndefined();
    expect(out.has("media/media.json")).toBe(true);
    expect(out.has("delivery/youtube-plan.json")).toBe(true);
    expect(JSON.parse(out.get("answer.json")!).videos[0].scenario).toBe(
      "dashboard-overview",
    );
    const summary = out.get("summary.md")!;
    expect(summary).toContain("| Mode | shadow (no model) |");
    expect(summary).toContain(
      "| YouTube | 1 to upload, 0 skipped (media hash in the map); not uploaded (a shadow run uploads nothing; delivery/youtube.md holds what it would upload), see delivery/youtube.md |",
    );
    expect(summary).not.toContain("Thinking");
    expect(summary).not.toContain("lbx status");
  });

  it("live, uploads with the grant only the delivery step holds, records the ids, and scrubs every token from the report", async () => {
    const root = await youtubeRepo(
      youtubeJob({ mode: "live", output: { ...OUTPUT, notify: "product" } }),
    );
    const media = mediaDir();
    writeMedia(media, { smoke: { title: "Smoke", chapters: [] } });
    const yt = fakeYouTube();
    const writer = new FakeWriter();
    writer.put(DOCS, BASE, MAP, "{}\n");
    const poster = recordingPoster();
    const opts = runOptions(root, media, {
      env: { PATH: process.env.PATH ?? "", ...RUN_ENV, ...YOUTUBE_ENV },
      youtube: () => openFake(yt),
      writer: () =>
        Promise.resolve({
          writer,
          secrets: [],
          close: () => Promise.resolve(),
        }),
      poster: poster.open,
    });
    const result = await runJob(opts);
    expect(result.messages[0]).toBe(`${JOB}: delivered without a model.`);
    expect(yt.videos).toEqual(["vid1xxxxxxx"]);
    expect(writer.pulls[0]!.branch).toBe(`agent/${JOB}/${DAY}`);
    expect(poster.posts).toHaveLength(1);
    const out = files(opts.out!);
    expect(out.get("summary.md")).toContain(
      `| YouTube | uploaded private: smoke \`vid1xxxxxxx\`; recorded in ${DOCS}#100; notice posted: https://notes-co.slack.com/archives/C0TEST00001/p1790799964081439 |`,
    );
    for (const [file, text] of out) {
      expect(text.includes(ACCESS_TOKEN), file).toBe(false);
      expect(text.includes(YOUTUBE_ENV.YOUTUBE_REFRESH_TOKEN), file).toBe(
        false,
      );
      expect(text.includes(YOUTUBE_ENV.YOUTUBE_CLIENT_SECRET), file).toBe(
        false,
      );
    }
  });

  it("refuses to start without the secrets its mode needs, and a stub run reads and uploads nothing", async () => {
    const live = await youtubeRepo(
      youtubeJob({ mode: "live", output: { ...OUTPUT, notify: "product" } }),
    );
    const media = mediaDir();
    writeMedia(media, { smoke: { title: "Smoke" } });
    expect(
      (await runJob(runOptions(live, media, { readDocs: undefined }))).messages,
    ).toEqual([
      "AGENTS_READER_APP_ID, AGENTS_READER_PRIVATE_KEY, YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN, YOUTUBE_CHANNEL_ID, AGENTS_WRITER_APP_ID, AGENTS_WRITER_PRIVATE_KEY, SLACK_AGENTS_POST_TOKEN are not set; a live youtube job needs them",
    ]);
    const shadow = await youtubeRepo(youtubeJob());
    expect(
      (await runJob(runOptions(shadow, media, { readDocs: undefined })))
        .messages,
    ).toEqual([
      "AGENTS_READER_APP_ID, AGENTS_READER_PRIVATE_KEY are not set; a shadow youtube job needs them",
    ]);
    const stub = runOptions(live, media, { stub: true, readDocs: undefined });
    const result = await runJob(stub);
    expect(result.ok).toBe(true);
    const status = JSON.parse(files(stub.out!).get("status.json")!);
    expect([
      status.youtube.outcome,
      status.youtube.reason,
      status.youtube.base,
    ]).toEqual(["shadow", "a stub run uploads nothing", undefined]);
    expect(
      (await runJob(runOptions(live, media, { preflight: true }))).messages,
    ).toEqual([`${JOB}: ready to run (mode live, no model).`]);
    expect(
      (await runJob(runOptions(live, media, { model: "acme/test-model" })))
        .messages,
    ).toEqual([`--model: ${JOB} runs no model (model: none)`]);
    const none = mediaDir();
    const missing = await runJob(
      runOptions(shadow, none, { readDocs: undefined, stub: true }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.messages[0]).toMatch(new RegExp(`^${JOB}: .*media.json`));
  });

  it("runs its media stage when no media directory is given: a stub run delivers the fixture's media", async () => {
    const root = await youtubeRepo(youtubeJob());
    const fixtures = join(root, "jobs", JOB, "fixtures");
    mkdirSync(join(fixtures, "media"), { recursive: true });
    writeMedia(join(fixtures, "media"), { smoke: { title: "Smoke" } });
    renameSync(
      join(fixtures, "media", "media.json"),
      join(fixtures, "media.json"),
    );
    const opts = runOptions(root, "", { readDocs: undefined, stub: true });
    delete opts.mediaDir;
    const result = await runJob(opts);
    expect(result.messages).toEqual([
      `${JOB}: delivered without a model.`,
      `Report: ${opts.out}`,
    ]);
    const status = JSON.parse(files(opts.out!).get("status.json")!);
    expect([status.media.source, status.media.files]).toEqual(["fixture", 3]);
    expect(status.youtube.reason).toBe("a stub run uploads nothing");

    const noFixture = await youtubeRepo(youtubeJob());
    const bare = runOptions(noFixture, "", { readDocs: undefined, stub: true });
    delete bare.mediaDir;
    expect((await runJob(bare)).messages[0]).toBe(
      `${JOB}: a stub run without fixtures/media.json has no media to deliver`,
    );
  });

  it("passes with outcome nothing when its media stage made no video", async () => {
    const root = await youtubeRepo(youtubeJob());
    const media = mediaDir();
    writeMedia(media, {});
    const opts = runOptions(root, media, {
      readDocs: () => Promise.reject(new Error("the map is not read")),
    });
    const result = await runJob(opts);
    expect(result.ok).toBe(true);
    expect(result.messages[0]).toBe(`${JOB}: delivered without a model.`);
    const out = files(opts.out!);
    const status = JSON.parse(out.get("status.json")!);
    expect([status.youtube.outcome, status.youtube.reason]).toEqual([
      "nothing",
      "the media stage made no video this run",
    ]);
    expect(out.get("summary.md")).toContain(
      "| YouTube | nothing to upload: the media stage made no video this run |",
    );
  });

  it("in shadow with notify, needs the posting token when the shadow channel has an id, and posts one line there", async () => {
    const config = youtubeJob({
      output: {
        ...OUTPUT,
        notify: "product",
        video_noun: "What's new episode",
      },
    });
    const media = mediaDir();
    writeMedia(media, { smoke: { title: "Smoke" } });
    const shadow = { id: "C0SHADOW001", name: "shadow-runs" };
    const withShadow = await youtubeRepo(config, {}, shadow);
    expect(
      (await runJob(runOptions(withShadow, media, { readDocs: undefined })))
        .messages,
    ).toEqual([
      "AGENTS_READER_APP_ID, AGENTS_READER_PRIVATE_KEY, SLACK_AGENTS_POST_TOKEN are not set; a shadow youtube job needs them",
    ]);
    const noShadow = await youtubeRepo(config);
    expect(
      (await runJob(runOptions(noShadow, media, { readDocs: undefined })))
        .messages,
    ).toEqual([
      "AGENTS_READER_APP_ID, AGENTS_READER_PRIVATE_KEY are not set; a shadow youtube job needs them",
    ]);
    const poster = recordingPoster();
    const opts = runOptions(withShadow, media, { poster: poster.open });
    const result = await runJob(opts);
    expect(result.ok).toBe(true);
    expect(poster.posts.map((p) => [p.channel, p.text])).toEqual([
      [
        shadow.id,
        `Shadow run of ${JOB}, not a live post. ${JOB} would upload 1 What's new episode to YouTube as private for review: ${RUN_URL}`,
      ],
    ]);
    const status = JSON.parse(files(opts.out!).get("status.json")!);
    expect(status.youtube.notice.channel).toBe(shadow.id);
  });

  it("needs media in job.yml: its media.ts makes what the job delivers", async () => {
    const { media: _, ...bare } = youtubeJob();
    const root = makeRepo({
      jobs: { [JOB]: { "job.yml": stringify(bare) } },
      repos: [REPO, DOCS],
    });
    expect(await run(mediaCheck, root)).toEqual([
      `jobs/${JOB}/job.yml: media: a job with model: none delivers what its media.ts makes; add media`,
    ]);
  });
});

describe("the youtube and no-model rules in flax agents check", () => {
  it("need docs_repo in repos.yml, a notify channel from the post list with an id when live, and model: none with youtube, a media pull request or a file only", async () => {
    const root = makeRepo({
      jobs: {
        "job-a": {
          "job.yml": stringify({
            ...youtubeJob(),
            name: "job-a",
            output: {
              ...OUTPUT,
              docs_repo: "notes-co/elsewhere",
              notify: "nowhere",
            },
          }),
        },
        "job-b": {
          "job.yml": stringify({
            ...youtubeJob(),
            name: "job-b",
            mode: "live",
            output: { ...OUTPUT, notify: "agents-shadow" },
          }),
          "SHADOW_RUNS.md": SHADOW_LINKS,
        },
        "job-c": {
          "job.yml": stringify({
            ...youtubeJob(),
            name: "job-c",
            model: "acme/test-model",
            thinking: "high",
            limits: { turns: 1, tokens_per_run: 10, usd_per_month: 1 },
          }),
          "prompt.md": "x\n",
          "output.json": "{}",
          "fixtures/input.json": "{}",
          "fixtures/output.json": "{}",
        },
        "job-d": {
          "job.yml": stringify({
            ...youtubeJob(),
            name: "job-d",
            output: { kind: "slack", channel: "agents-shadow" },
          }),
        },
        "job-e": {
          "job.yml": stringify({
            ...youtubeJob(),
            name: "job-e",
            output: { kind: "file" },
          }),
        },
      },
      repos: [REPO, DOCS],
      channels: {
        post: [{ name: "agents-shadow" }],
        read: [READ_CHANNEL],
      },
    });
    expect(await run(allowlistsCheck, root)).toEqual([
      'jobs/job-a/job.yml: output.docs_repo: "notes-co/elsewhere" is not listed in repos.yml',
      'jobs/job-a/job.yml: output.notify: "nowhere" is not listed in channels.yml',
      'jobs/job-b/job.yml: output.notify: "agents-shadow" has no id in channels.yml; a live job posts by channel id',
      "jobs/job-c/job.yml: model: output kind youtube publishes what the scenario files say and runs no model; set model: none",
      "jobs/job-d/job.yml: model: a job with model: none runs no model, so its answer must be one the kit builds: output kind youtube, output kind results, output kind pr with media.pr_paths whose media.ts builds the answer, or output kind file (the media stage's files and manifest stay in the report), not slack",
    ]);
  });

  it("hold docs_source_dir to a plain folder of its own, apart from docs_media_dir and map_path, and video_noun to a short plain name", async () => {
    const job = (name: string, output: Record<string, unknown>) => ({
      "job.yml": stringify({
        ...youtubeJob(),
        name,
        output: { ...OUTPUT, ...output },
      }),
    });
    const root = makeRepo({
      jobs: {
        "job-a": job("job-a", {
          docs_media_dir: "public/videos",
          docs_source_dir: "public/videos/sources",
        }),
        "job-b": job("job-b", {
          docs_media_dir: "public/videos/whats-new",
          docs_source_dir: "public/videos",
        }),
        "job-c": job("job-c", { docs_source_dir: "src/data" }),
        "job-d": job("job-d", {
          docs_media_dir: "public/videos",
          docs_source_dir: "scenarios/whats-new",
          video_noun: "What's new episode",
        }),
      },
      repos: [REPO, DOCS],
    });
    expect(await run(allowlistsCheck, root)).toEqual([
      'jobs/job-a/job.yml: output.docs_source_dir: "public/videos/sources" and docs_media_dir "public/videos" overlap; the scenario sources need a folder of their own',
      'jobs/job-b/job.yml: output.docs_source_dir: "public/videos" and docs_media_dir "public/videos/whats-new" overlap; the scenario sources need a folder of their own',
      `jobs/job-c/job.yml: output.docs_source_dir: map_path "${MAP}" is inside "src/data", where a scenario source could overwrite it`,
    ]);
    expect(await run(jobSchemaCheck, root)).toEqual([]);
    for (const output of [
      { docs_source_dir: "../scenarios" },
      { docs_source_dir: "/scenarios" },
      { docs_source_dir: "scenarios/" },
      { docs_source_dir: ".github/workflows" },
      { video_noun: "<b>episode</b>" },
      { video_noun: "episode\nlink" },
      { video_noun: "x".repeat(41) },
    ]) {
      const bad = makeRepo({ jobs: { [JOB]: job(JOB, output) } });
      expect(
        await run(jobSchemaCheck, bad),
        JSON.stringify(output),
      ).toHaveLength(1);
    }
  });

  it("take no thinking level, limits, shell or tools, and no prompt, schema or job script for a job with model: none", async () => {
    const root = makeRepo({
      jobs: {
        [JOB]: {
          "job.yml": stringify({
            ...youtubeJob(),
            thinking: "high",
            shell: true,
            tools: ["web-fetch"],
            limits: { turns: 1, tokens_per_run: 10, usd_per_month: 1 },
          }),
        },
      },
    });
    expect(await run(jobSchemaCheck, root)).toEqual([
      `jobs/${JOB}/job.yml: thinking: is not taken by a job with model: none`,
      `jobs/${JOB}/job.yml: limits: is not taken by a job with model: none`,
      `jobs/${JOB}/job.yml: shell: is not taken by a job with model: none`,
      `jobs/${JOB}/job.yml: tools: must be empty for a job with model: none`,
    ]);
    const folder = makeRepo({
      jobs: {
        [JOB]: {
          "job.yml": stringify(youtubeJob()),
          "prompt.md": "Summarize.\n",
          "collect.ts": "export {};\n",
        },
      },
    });
    expect(await run(folderCheck, folder)).toEqual([
      `jobs/${JOB}/prompt.md: is not taken by a job with model: none, which runs no model and no job script`,
      `jobs/${JOB}/collect.ts: is not taken by a job with model: none, which runs no model and no job script`,
    ]);
    const clean = makeRepo({
      jobs: { [JOB]: { "job.yml": stringify(youtubeJob()) } },
      repos: [REPO, DOCS],
    });
    expect(await run(folderCheck, clean)).toEqual([]);
    expect(await run(allowlistsCheck, clean)).toEqual([]);
  });

  it("generate a workflow with no box, no model choice and no issuer key, whose run step alone gets the youtube secrets", async () => {
    expect(deliverySecrets(youtubeJob())).toEqual([
      "AGENTS_READER_APP_ID",
      "AGENTS_READER_PRIVATE_KEY",
    ]);
    // A shadow run with notify posts one line to the shadow channel.
    expect(
      deliverySecrets(youtubeJob({ output: { ...OUTPUT, notify: "product" } })),
    ).toEqual([
      "AGENTS_READER_APP_ID",
      "AGENTS_READER_PRIVATE_KEY",
      "SLACK_AGENTS_POST_TOKEN",
    ]);
    expect(
      deliverySecrets(
        youtubeJob({ mode: "live", output: { ...OUTPUT, notify: "product" } }),
      ),
    ).toEqual([
      "AGENTS_READER_APP_ID",
      "AGENTS_READER_PRIVATE_KEY",
      "YOUTUBE_CLIENT_ID",
      "YOUTUBE_CLIENT_SECRET",
      "YOUTUBE_REFRESH_TOKEN",
      "YOUTUBE_CHANNEL_ID",
      "AGENTS_WRITER_APP_ID",
      "AGENTS_WRITER_PRIVATE_KEY",
      "SLACK_AGENTS_POST_TOKEN",
    ]);
    const root = await youtubeRepo(youtubeJob({ mode: "live" }));
    const workflow = parse(
      readFileSync(join(root, `.github/workflows/job-${JOB}.yml`), "utf8"),
    );
    expect(workflow.on).toEqual({ workflow_dispatch: {} });
    const job = workflow.jobs.run;
    // 30 minutes for the delivery and 5 for the media stage.
    expect(job["timeout-minutes"]).toBe(35);
    expect(
      job.steps.map((s: { name?: string; uses?: string }) => s.name ?? s.uses),
    ).toEqual([
      "actions/checkout@v5",
      "actions/setup-node@v6",
      "Check the job",
      "Run the job",
      "Keep the report",
    ]);
    const withSecrets = job.steps.filter(
      (s: { env?: Record<string, string> }) =>
        JSON.stringify(s.env ?? {}).includes("secrets."),
    );
    expect(withSecrets.map((s: { name: string }) => s.name)).toEqual([
      "Run the job",
    ]);
    expect(Object.keys(withSecrets[0].env)).toEqual([
      "AGENTS_READER_APP_ID",
      "AGENTS_READER_PRIVATE_KEY",
      "YOUTUBE_CLIENT_ID",
      "YOUTUBE_CLIENT_SECRET",
      "YOUTUBE_REFRESH_TOKEN",
      "YOUTUBE_CHANNEL_ID",
      "AGENTS_WRITER_APP_ID",
      "AGENTS_WRITER_PRIVATE_KEY",
    ]);
    expect(
      readFileSync(join(root, "JOBS.md"), "utf8").replace(/ +/g, " "),
    ).toContain(`| manual | \`none\` | none | 0 | youtube ${DOCS} | live |`);

    const tailnet = await youtubeRepo(
      youtubeJob({
        mode: "live",
        media: {
          network: "tailnet",
          secrets: ["ELEVENLABS_API_KEY"],
          timeout_minutes: 40,
        },
      }),
    );
    const onTailnet = parse(
      readFileSync(join(tailnet, `.github/workflows/job-${JOB}.yml`), "utf8"),
    ).jobs.run;
    expect(onTailnet["timeout-minutes"]).toBe(30 + 40 + 5);
    expect(
      onTailnet.steps.map(
        (s: { name?: string; uses?: string }) => s.name ?? s.uses,
      ),
    ).toEqual([
      "actions/checkout@v5",
      "actions/setup-node@v6",
      "Check the job",
      "Join the tailnet",
      "Run the job",
      "Leave the tailnet",
      "Keep the report",
    ]);
    const runStep = onTailnet.steps.find(
      (s: { name?: string }) => s.name === "Run the job",
    );
    expect(Object.keys(runStep.env)).toContain("ELEVENLABS_API_KEY");
  });
});

describe("the youtube secrets", () => {
  it("stay with the runner: kept from lbx and job code, and scrubbed from reports, all but the public channel id", async () => {
    const { RUNNER_SECRET_ENV } = await import("../src/run-job/argv.ts");
    const { secretValues } = await import("../src/run-job/report.ts");
    const { withoutRunnerSecrets } = await import("../src/run-job/input.ts");
    for (const name of Object.keys(YOUTUBE_ENV))
      expect(RUNNER_SECRET_ENV as readonly string[]).toContain(name);
    expect(
      Object.keys(withoutRunnerSecrets({ ...YOUTUBE_ENV, PATH: "/bin" })),
    ).toEqual(["PATH"]);
    expect(secretValues(YOUTUBE_ENV)).toEqual([
      YOUTUBE_ENV.YOUTUBE_CLIENT_ID,
      YOUTUBE_ENV.YOUTUBE_CLIENT_SECRET,
      YOUTUBE_ENV.YOUTUBE_REFRESH_TOKEN,
    ]);
  });

  it("fail the run when one reaches the report, as when a scenario's title carries the client secret", async () => {
    const root = await youtubeRepo(youtubeJob());
    const media = mediaDir();
    writeMedia(media, {
      smoke: { title: `Leak ${YOUTUBE_ENV.YOUTUBE_CLIENT_SECRET}` },
    });
    const opts = runOptions(root, media, {
      env: { PATH: process.env.PATH ?? "", ...YOUTUBE_ENV },
    });
    const result = await runJob(opts);
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toBe(
      `${JOB}: a secret value appeared in the run's output; it was replaced with [redacted] in the report. Rotate the key.`,
    );
    for (const [file, text] of files(opts.out!))
      expect(text.includes(YOUTUBE_ENV.YOUTUBE_CLIENT_SECRET), file).toBe(
        false,
      );
  });
});

describe("a youtube job whose media stage gets a model", () => {
  /** Posts one messages call to the runner's model socket: what a workspace's media.ts does with its own HTTP client. */
  const SOCKET_POST = `import { request as httpRequest } from "node:http";
  const socketPost = (socketPath, timeout) => (body) => new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json" }, timeout }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(body);
  });`;

  /** Copies prepared media into the media directory and notes what one model call answered. */
  const mediaScript = (
    from: string,
    note: string,
  ) => `import { cpSync, writeFileSync } from "node:fs";
${SOCKET_POST}
void socketPost(process.env.FLAX_AGENTS_MEDIA_MODEL_SOCKET, 5000)(
  JSON.stringify({ max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
).then((reply) => {
writeFileSync(${JSON.stringify(note)}, JSON.stringify({
  status: reply.status,
  model: JSON.parse(reply.text).got.model,
  names: Object.keys(process.env).filter((n) => /FLAX_AGENTS_MEDIA_MODEL|GATEWAY/.test(n)).sort(),
}));
cpSync(${JSON.stringify(from)}, process.env.FLAX_AGENTS_MEDIA_DIR, { recursive: true });
});
`;
  const MEDIA_MODEL = {
    network: "public",
    secrets: [],
    timeout_minutes: 5,
    model: { model: "acme/test-model", usd_per_run: 1, usd_per_month: 5 },
  };

  async function setUp(gatewayConfig = {}) {
    const prepared = mediaDir();
    writeMedia(prepared, { "dashboard-overview": OVERVIEW });
    const note = join(mediaDir(), "note.json");
    const root = await youtubeRepo(youtubeJob({ media: MEDIA_MODEL }), {
      "media.ts": mediaScript(prepared, note),
    });
    const { testGateway } = await import("./fake-gateway.ts");
    const gw = await testGateway(gatewayConfig);
    const opts = runOptions(root, "", {
      env: { PATH: process.env.PATH ?? "", ...RUN_ENV, ...gw.env },
      gateway: gw.gateway,
      socketBases: [mediaDir()],
    });
    delete opts.mediaDir;
    return { opts, gw, note };
  }

  it("runs its media stage with a capped key it never holds, counted in the job's month", async () => {
    const { opts, gw, note } = await setUp({ spendOfIssued: 0.3 });
    const result = await runJob(opts);
    expect(result.messages[0]).toBe(`${JOB}: delivered without a model.`);
    expect(JSON.parse(readFileSync(note, "utf8"))).toEqual({
      status: 200,
      model: "test-model",
      names: ["FLAX_AGENTS_MEDIA_MODEL", "FLAX_AGENTS_MEDIA_MODEL_SOCKET"],
    });
    expect(gw.fake.keys.map((k) => [k.key_alias, k.blocked])).toEqual([
      [`agents/${JOB}/2026-10/job-${JOB}-36606095916-1-media`, true],
    ]);
    const out = files(opts.out!);
    const status = JSON.parse(out.get("status.json")!);
    expect(status.budget).toEqual({
      month: "2026-10",
      spentUsd: 0,
      reserveUsd: 1,
      ledger: "durable",
      shared: {
        who: "all jobs (gateway team agents)",
        spentUsd: 0,
        limitUsd: 150,
      },
    });
    expect(status.mediaModel).toMatchObject({
      model: "acme/test-model",
      maxBudgetUsd: 1,
      minutes: 15,
      blocked: true,
      spendUsd: 0.3,
    });
    expect(out.has("media-forwarder.json")).toBe(true);
    for (const [file, text] of out)
      expect(text.includes(gw.fake.issued[0]!), file).toBe(false);
  });

  it("needs the issuer key, and a month that holds the key's budget", async () => {
    const { opts } = await setUp();
    expect(
      (await runJob({ ...opts, env: { PATH: process.env.PATH ?? "" } }))
        .messages,
    ).toEqual([
      "LLM_GATEWAY_ISSUER_KEY is not set; a shadow youtube job needs it",
    ]);
    const full = await setUp({
      keys: [{ key_alias: `agents/${JOB}/2026-10/earlier`, spend: 4.5 }],
    });
    expect((await runJob(full.opts)).messages).toEqual([
      `${JOB} has spent $4.50 of its $5 in 2026-10; a run can cost up to $1.00`,
    ]);
    expect(full.gw.fake.issued).toEqual([]);
  });

  it("gives the run step the issuer key only when media.model asks for a key", async () => {
    const step = async (config: JobConfig) => {
      const root = await youtubeRepo(config);
      const workflow = parse(
        readFileSync(
          join(root, ".github", "workflows", `job-${JOB}.yml`),
          "utf8",
        ),
      ) as { jobs: { run: { steps: { name?: string; env?: object }[] } } };
      return workflow.jobs.run.steps.find((s) => s.name === "Run the job")!
        .env!;
    };
    expect(await step(youtubeJob({ media: MEDIA_MODEL }))).toHaveProperty(
      "LLM_GATEWAY_ISSUER_KEY",
      "${{ secrets.LLM_GATEWAY_ISSUER_KEY }}",
    );
    expect(await step(youtubeJob())).not.toHaveProperty(
      "LLM_GATEWAY_ISSUER_KEY",
    );
  });
});
