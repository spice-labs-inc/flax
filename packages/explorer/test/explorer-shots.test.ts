import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_FILES, inlineShots, writeData } from "../scripts/build.ts";
import { writeSingleFile } from "../scripts/single.ts";
import { dataFiles, type DataFileName } from "../src/lib/model.ts";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");

const files = (shots: unknown): Record<DataFileName, unknown> => ({
  "coverage.json": { surfaces: [], items: [] },
  "journeys.json": { personas: [], stations: [], journeys: [], orphans: [] },
  "history.json": { scenarios: [], planned: [], snapshots: [] },
  "scenarios.json": { runs: [], scenarios: [], features: [] },
  "shots.json": shots,
  "board.json": { items: [], bugs: [] },
});

describe("failure screenshots as files", () => {
  it("are written as images beside the data, named by shots.json, and inlined again for the single-file page", () => {
    const dir = mkdtempSync(join(tmpdir(), "explorer-shots-"));
    try {
      writeData(dir, files({ "prod/3": `data:image/png;base64,${PNG}` }));
      const named = JSON.parse(readFileSync(join(dir, "shots.json"), "utf8"));
      expect(named).toEqual({ "prod/3": "shots/1.png" });
      expect(readFileSync(join(dir, "shots/1.png")).toString("base64")).toBe(
        PNG,
      );
      expect(inlineShots(dir)).toEqual({
        "prod/3": `data:image/png;base64,${PNG}`,
      });

      const built = join(dir, "built.html");
      writeFileSync(
        built,
        "<html><head><title>t</title></head><body>b</body></html>",
      );
      writeSingleFile({
        built,
        dataDir: dir,
        outDir: join(dir, "out"),
        builtAt: "2026-10-14T00:00:00Z",
      });
      expect(readFileSync(join(dir, "out/index.html"), "utf8")).toContain(
        `"prod/3":"data:image/png;base64,${PNG}"`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("make no shots directory when there are none", () => {
    const dir = mkdtempSync(join(tmpdir(), "explorer-shots-"));
    try {
      writeData(dir, files({}));
      expect(existsSync(join(dir, "shots"))).toBe(false);
      for (const name of DATA_FILES)
        expect(existsSync(join(dir, name))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolve to the data version on the page, and stay data URLs inside a single-file page", () => {
    const raw = files({
      "prod/3": "shots/1.png",
      "staging/2": "data:image/webp;base64,AA==",
      bad: "../x.png",
    });
    expect(dataFiles(raw, "/data/v1").shots).toEqual({
      "prod/3": "/data/v1/shots/1.png",
      "staging/2": "data:image/webp;base64,AA==",
    });
    expect(dataFiles(raw).shots).toEqual({
      "staging/2": "data:image/webp;base64,AA==",
    });
  });
});
