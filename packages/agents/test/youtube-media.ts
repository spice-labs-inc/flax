import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";

export interface FakeScenario {
  title?: string;
  description?: string;
  tags?: string[];
  chapters?: { start: number; title: string }[];
  playlist?: string | null;
  duration?: number;
  /** Changes the video's bytes, and so the media hash. */
  cut?: string;
  /** What the media stage records the video was made from. */
  source?: unknown;
  /** The scenario's source file, written at <scenario>/scenario.json unless path says otherwise, and named in scenarioFile. */
  scenarioFile?: { bytes: string | Buffer; path?: string; type?: string };
  /** data.scenarios[id].leftOut as given. */
  leftOut?: unknown;
}

export const OVERVIEW: FakeScenario = {
  title: "Notes Co in two minutes",
  description:
    "A tour of the dashboard.\nDocs: https://docs.notes-co.example/start/",
  tags: ["notes labs", "sbom", "pqc"],
  chapters: [
    { start: 0, title: "Intro" },
    { start: 12, title: "Survey" },
    { start: 40, title: "Portfolio" },
  ],
  duration: 150,
};

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function mediaDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-media-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Writes what a media stage would: per scenario a video, captions and a
 * poster under <scenario>/, and media.json with their sha256 and the
 * scenario's metadata in data.scenarios.
 */
export function writeMedia(
  dir: string,
  scenarios: Record<string, FakeScenario>,
  edit: (manifest: Record<string, unknown>) => void = () => {},
): Record<string, unknown> {
  const files: { path: string; sha256: string; bytes: number; type: string }[] =
    [];
  const data: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(scenarios)) {
    const put = (path: string, bytes: Buffer, type: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), bytes);
      files.push({ path, sha256: sha(bytes), bytes: bytes.length, type });
    };
    put(
      `${id}/video.mp4`,
      Buffer.from(`mp4 bytes of ${id} ${s.cut ?? "v1"} `.repeat(20)),
      "video/mp4",
    );
    put(
      `${id}/captions.vtt`,
      Buffer.from("WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n"),
      "text/vtt",
    );
    put(`${id}/poster.png`, Buffer.from(`png of ${id}`), "image/png");
    const sf = s.scenarioFile;
    const sfPath = sf?.path ?? `${id}/scenario.json`;
    if (sf !== undefined && !files.some((f) => f.path === sfPath))
      put(sfPath, Buffer.from(sf.bytes), sf.type ?? "application/json");
    data[id] = {
      video: `${id}/video.mp4`,
      captions: `${id}/captions.vtt`,
      poster: `${id}/poster.png`,
      title: s.title ?? OVERVIEW.title,
      description: s.description ?? OVERVIEW.description,
      tags: s.tags ?? OVERVIEW.tags,
      chapters: s.chapters ?? OVERVIEW.chapters,
      ...(s.playlist === undefined ? {} : { playlist: s.playlist }),
      ...(s.duration === undefined ? {} : { duration: s.duration }),
      ...(s.source === undefined ? {} : { source: s.source }),
      ...(sf === undefined ? {} : { scenarioFile: sfPath }),
      ...(s.leftOut === undefined ? {} : { leftOut: s.leftOut }),
    };
  }
  const lines = files
    .map((f) => `${f.path} ${f.sha256}`)
    .sort()
    .join("\n");
  const manifest: Record<string, unknown> = {
    version: 1,
    files,
    hash: createHash("sha256").update(lines).digest("hex"),
    data: { scenarios: data },
  };
  edit(manifest);
  writeFileSync(join(dir, "media.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** The media hash the kit records for one scenario: its three files only. */
export function scenarioHash(
  manifest: Record<string, unknown>,
  id: string,
): string {
  const three = ["video.mp4", "captions.vtt", "poster.png"].map(
    (name) => `${id}/${name}`,
  );
  const files = (manifest.files as { path: string; sha256: string }[]).filter(
    (f) => three.includes(f.path),
  );
  return createHash("sha256")
    .update(
      files
        .map((f) => `${f.path} ${f.sha256}`)
        .sort()
        .join("\n"),
    )
    .digest("hex");
}
