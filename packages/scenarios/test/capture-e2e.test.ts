import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaptureManifest } from "../src/capture/manifest.ts";
import type { RunResult } from "../src/run/results.ts";

const workspace = fileURLToPath(new URL("fixtures/capture", import.meta.url));
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

const size = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

describe("run --capture --dry-run", () => {
  it("lists the tagged scenarios, cadence ones included, and writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capture-dry-"));
    try {
      const r = await run(["--capture", join(dir, "shots"), "--dry-run"]);
      expect(r.stderr).toContain(
        "to capture: every capture (features/notes/notes.feature:7 Add a note)",
      );
      expect(r.stderr).toContain(
        "to capture: notes-heading (features/notes/notes.feature:13 The heading)",
      );
      expect(r.stderr).not.toContain("Not captured");
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, "shots"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses --capture beside --record", async () => {
    const r = await run(["--capture", "a", "--record", "b", "--dry-run"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--capture and --record are separate runs");
  });
});

describe.skipIf(!(await chromiumInstalled()))(
  "run --capture against a page the test serves",
  () => {
    let dir: string;
    let server: Server;
    let result: { code: number | null; stderr: string };
    let manifest: CaptureManifest;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "capture-e2e-"));
      const html = await readFile(join(workspace, "site", "index.html"));
      server = createServer((_req, res) => {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(html);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;
      result = await run(
        ["--out", join(dir, "results"), "--capture", join(dir, "shots")],
        { NOTES_PAGE_URL: `http://127.0.0.1:${port}/` },
      );
      manifest = JSON.parse(
        await readFile(join(dir, "shots", "manifest.json"), "utf8"),
      ) as CaptureManifest;
    }, 120_000);

    afterAll(async () => {
      server?.closeAllConnections();
      await new Promise((r) => server?.close(r));
      await rm(dir, { recursive: true, force: true });
    });

    it("runs only the tagged scenarios, whose steps never read the stand-ins, and passes", async () => {
      expect(result.stderr).toContain(
        "captures: 3 of 3 from passed scenarios, passed",
      );
      expect(result.code).toBe(0);
      const env = join(dir, "results", "local");
      const runJson = JSON.parse(
        await readFile(join(env, readdirSync(env)[0]!, "run.json"), "utf8"),
      ) as RunResult;
      expect(runJson.scenarios.map((s) => [s.name, s.status])).toEqual([
        ["Add a note", "passed"],
        ["The heading", "passed"],
      ]);
    });

    it("writes each capture the tags ask for at the capture scale, and nothing else", async () => {
      expect(readdirSync(join(dir, "shots")).sort()).toEqual([
        "manifest.json",
        "notes-heading.png",
        "notes-list.png",
        "notes-page.png",
      ]);
      expect(
        size(await readFile(join(dir, "shots", "notes-page.png"))),
      ).toEqual([1200, 900]);
      const list = await readFile(join(dir, "shots", "notes-list.png"));
      expect(size(list)[0]).toBeLessThan(1200);
    });

    it("lists every capture in the manifest with its scenario, step, page, size and text", () => {
      expect(manifest).toMatchObject({
        env: "local",
        status: "passed",
        problems: [],
      });
      expect(manifest.captures.map((c) => c.name)).toEqual([
        "notes-heading",
        "notes-list",
        "notes-page",
      ]);
      const [heading, list, page] = manifest.captures;
      expect(page).toMatchObject({
        file: "notes-page.png",
        text: [
          {
            heading: "Notebook",
            lines: ["Save", "Weekly plan", "Example footer"],
          },
        ],
        scenario: "Add a note",
        feature: "features/notes/notes.feature",
        line: 7,
        status: "passed",
        step: {
          index: 3,
          keyword: "Then",
          text: 'the list shows "Weekly plan"',
        },
        target: "viewport",
        viewport: { width: 800, height: 600 },
        deviceScaleFactor: 1.5,
        width: 1200,
        height: 900,
      });
      expect(page!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(list).toMatchObject({
        target: "element",
        locator: "locator('#notes')",
        text: [{ heading: "", lines: ["Weekly plan"] }],
      });
      expect(heading).toMatchObject({
        scenario: "The heading",
        line: 13,
        text: null,
        step: { index: 1, keyword: "Then" },
      });
    });
  },
);
