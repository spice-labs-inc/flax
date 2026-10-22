import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Timeline } from "../src/record/timeline.ts";
import type { RunResult } from "../src/run/results.ts";

const workspace = fileURLToPath(new URL("fixtures/record", import.meta.url));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function chromiumInstalled(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const run = (
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [cli, "run", "--env", "local", ...args],
      {
        env: { ...process.env, FLAX_WORKSPACE: workspace, ...env },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += String(d)));
    child.on("close", (code) => resolve({ code, stderr }));
  });

describe("run --record --dry-run", () => {
  it("checks the sidecars and the steps, and writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "record-dry-"));
    try {
      const r = await run(["--record", join(dir, "media"), "--dry-run"]);
      expect(r.stderr).toContain(
        "to record: add-a-note (features/notes/add-note.feature:6 Add a note)",
      );
      expect(r.stderr).toContain("to record: lost-note");
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, "media"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!(await chromiumInstalled()))(
  "run --record against a page the test serves",
  () => {
    let dir: string;
    let server: Server;
    let result: { code: number | null; stderr: string };
    let timeline: Timeline;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "record-e2e-"));
      const html = await readFile(join(workspace, "site", "index.html"));
      server = createServer((_req, res) => {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(html);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;
      result = await run(
        ["--out", join(dir, "results"), "--record", join(dir, "media")],
        { NOTES_PAGE_URL: `http://127.0.0.1:${port}/` },
      );
      timeline = JSON.parse(
        await readFile(
          join(dir, "media", "add-a-note", "timeline.json"),
          "utf8",
        ),
      ) as Timeline;
    }, 120_000);

    afterAll(async () => {
      server?.closeAllConnections();
      await new Promise((r) => server?.close(r));
      await rm(dir, { recursive: true, force: true });
    });

    it("runs only the scenarios with a sidecar, and fails the run for the one that fails", async () => {
      expect(result.code).toBe(1);
      const env = join(dir, "results", "local");
      const runJson = JSON.parse(
        await readFile(join(env, readdirSync(env)[0]!, "run.json"), "utf8"),
      ) as RunResult;
      expect(runJson.scenarios.map((s) => s.status).sort()).toEqual([
        "failed",
        "passed",
      ]);
      expect(result.stderr).toContain("add-a-note: passed, with video");
      expect(result.stderr).toContain("lost-note: failed, with video");
      expect(readdirSync(join(dir, "media")).sort()).toEqual([
        "add-a-note",
        "lost-note",
      ]);
    });

    it("writes the video, a screen per step at the device scale, the terminal scene and the sidecar copies", async () => {
      const out = join(dir, "media", "add-a-note");
      const video = await readFile(join(out, "video.webm"));
      expect(video.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
      expect(video.length).toBeGreaterThan(1000);
      expect(readdirSync(join(out, "screens")).sort()).toEqual([
        "1.png",
        "2.png",
        "3.png",
        "4.png",
        "5.png",
        "6.png",
        "7.png",
      ]);
      const png = await readFile(join(out, "screens", "4.png"));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 900]);
      expect(readdirSync(join(out, "terminal")).sort()).toEqual([
        "5.cast",
        "5.json",
      ]);
      const scene = JSON.parse(
        await readFile(join(out, "terminal", "5.json"), "utf8"),
      );
      expect(scene).toMatchObject({
        index: 5,
        command: "notes list",
        display: "notes list --all",
        preface: ["export NOTES_TOKEN=example-token"],
        cwd: "/work",
        exitCode: 0,
        output: [{ text: "Weekly plan\n" }],
      });
      expect(scene.output[0].atMs).toBeGreaterThanOrEqual(scene.startMs);
      expect(scene.endMs).toBeGreaterThanOrEqual(scene.startMs);
      const cast = await readFile(join(out, "terminal", "5.cast"), "utf8");
      expect(cast).toContain('"n"');
      expect(cast).toContain('"Weekly plan\\r\\n"');
      expect(readdirSync(out).filter((n) => n.endsWith(".video.yml"))).toEqual([
        "add-a-note.video.yml",
      ]);
      expect(await readFile(join(out, "add-a-note.video.yml"), "utf8")).toMatch(
        /^scenario: Add a note\nid: add-a-note\n/,
      );
      const resolved = JSON.parse(
        await readFile(join(out, "sidecar.json"), "utf8"),
      );
      expect(resolved).toMatchObject({
        viewport: { width: 800, height: 600, deviceScaleFactor: 1.5 },
        intro: {
          heading: "Adding a note",
          items: [
            { label: "Type a title", icon: "pencil" },
            { label: "Save it" },
          ],
        },
        narration: [{ at: 2 }, { at: 4 }, { at: 5 }],
        hide: [1],
        highlight: [4, 6, 7],
        poster: { at: 4, title: "Adding a note", kicker: "How-to" },
        terminal: [{ at: 5, display: "notes list --all" }],
        pace: { typeMsPerChar: 15, afterActionMs: 100, readMs: 250 },
      });
    });

    it("times every step and action from the first frame, in order, with boxes inside the viewport", () => {
      expect(timeline).toMatchObject({
        id: "add-a-note",
        scenario: "Add a note",
        feature: "features/notes/add-note.feature",
        status: "passed",
        video: "video.webm",
        viewport: { width: 800, height: 600 },
        scale: 1.5,
      });
      expect(timeline.background).toMatchObject([
        {
          index: 0,
          keyword: "Given",
          hidden: true,
          status: "passed",
          screen: null,
        },
      ]);
      expect(timeline.background[0]!.actions.map((a) => a.kind)).toEqual([
        "goto",
      ]);
      expect(
        timeline.steps.map((s) => [
          s.index,
          s.keyword,
          s.hidden,
          s.highlight,
          s.status,
        ]),
      ).toEqual([
        [1, "Given", true, false, "passed"],
        [2, "When", false, false, "passed"],
        [3, "And", false, false, "passed"],
        [4, "Then", false, true, "passed"],
        [5, "When", false, false, "passed"],
        [6, "Then", false, true, "passed"],
        [7, "And", false, true, "passed"],
      ]);
      expect(timeline.steps.map((s) => s.actions.map((a) => a.kind))).toEqual([
        [],
        ["type"],
        ["click"],
        ["highlight"],
        [],
        [],
        ["highlight"],
      ]);
      let last = -Infinity;
      for (const s of timeline.steps) {
        expect(s.startMs).not.toBeNull();
        expect(s.startMs!).toBeGreaterThanOrEqual(last);
        expect(s.endMs!).toBeGreaterThanOrEqual(s.startMs!);
        for (const a of s.actions) {
          expect(a.atMs).toBeGreaterThanOrEqual(s.startMs!);
          expect(a.atMs).toBeLessThanOrEqual(s.endMs!);
          if (a.box) {
            expect(a.box.x).toBeGreaterThanOrEqual(0);
            expect(a.box.x + a.box.width).toBeLessThanOrEqual(800);
            expect(a.box.y + a.box.height).toBeLessThanOrEqual(600);
          }
        }
        last = s.endMs!;
      }
      // The page opened during the Background, so the first frame falls inside it.
      expect(timeline.background[0]!.startMs!).toBeLessThanOrEqual(0);
      expect(timeline.background[0]!.endMs!).toBeGreaterThanOrEqual(0);
      expect(timeline.steps[0]!.startMs!).toBeGreaterThanOrEqual(
        timeline.background[0]!.endMs!,
      );
      const typed = timeline.steps[1]!;
      // Typing 11 characters at 15 ms, then the 100 ms after-action pause (each time is rounded to the ms).
      expect(typed.endMs! - typed.actions[0]!.atMs).toBeGreaterThanOrEqual(
        11 * 15 + 100 - 2,
      );
      const check = timeline.steps[3]!;
      expect(check.endMs! - check.actions[0]!.atMs).toBeGreaterThanOrEqual(
        250 - 2,
      );
      expect(timeline.steps[3]!.screen).toBe("screens/4.png");
      expect(timeline.steps[4]!.terminal).toBe("terminal/5.json");
    });

    it("still writes a failed recording's timeline and video, marked failed", async () => {
      const out = join(dir, "media", "lost-note");
      const failed = JSON.parse(
        await readFile(join(out, "timeline.json"), "utf8"),
      ) as Timeline;
      expect(failed.status).toBe("failed");
      expect(failed.video).toBe("video.webm");
      expect(existsSync(join(out, "video.webm"))).toBe(true);
      expect(failed.steps.map((s) => s.status)).toEqual(["passed", "failed"]);
      expect(failed.steps[1]!.error).toContain("Timeout 2000ms exceeded");
    });
  },
);
