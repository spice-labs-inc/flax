import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { JobConfig, MediaStage } from "../lib/job.ts";
import {
  MEDIA_BASE_ENV,
  MEDIA_ORG_READ_ENV,
  MEDIA_DIR,
  MEDIA_DIR_ENV,
  MEDIA_DISPATCH_ENV,
  MEDIA_DISPATCH_TOKEN_ENV,
  MEDIA_FIXTURE,
  MEDIA_FIXTURE_DIR,
  MEDIA_GH_TOKEN_ENV,
  MEDIA_MANIFEST,
  MEDIA_READ_TOKEN_ENV,
  readMediaFile,
  readMediaManifest,
  type MediaManifest,
} from "../lib/media.ts";
import { jobFile } from "../lib/paths.ts";
import { firstLine } from "../lib/problem.ts";
import { failureLine, jobScriptArgs } from "./input.ts";
import type { ReportWriter } from "./report.ts";

/** What the run's report says about its media. */
export interface MediaRecord {
  /** media.ts made the media; in a stub run the fixture stood in, or there was none; parts: merged from a stage's parts. */
  source: "media.ts" | "fixture" | "none" | "parts";
  network: MediaStage["network"];
  files: number;
  bytes: number;
  hash?: string;
  /** Files copied into the report, under media/. */
  kept: string[];
  /** Files left out of the report, with why. */
  notKept: { path: string; reason: string }[];
}

/** The media types a report keeps: the final video, its captions and the poster or screenshots, and plain text. */
export const REPORT_MEDIA_TYPES: readonly string[] = [
  "video/mp4",
  "text/vtt",
  "image/png",
  "text/plain",
];
/** The most media bytes one report keeps; the rest stays out, named in status.json. */
export const MAX_REPORT_MEDIA_BYTES = 50 * 1024 * 1024;
const STDERR_TAIL_BYTES = 16 * 1024;

/**
 * media.ts's whole environment: the few basics from the runner's, the
 * secrets its job lists, the media directory, the reader app's token as
 * GH_TOKEN when its job has media.read_repos, the writer app's dispatch
 * token when it has media.dispatch_repos and, when its job has
 * media.model, the socket its model is served on (extra). Nothing else of
 * the runner's reaches it, so no key the job did not list can.
 */
export function mediaEnv(
  env: NodeJS.ProcessEnv,
  stage: MediaStage,
  dir: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [
    ...MEDIA_BASE_ENV,
    ...stage.secrets,
    ...(stage.org_read === true ? [MEDIA_ORG_READ_ENV] : []),
  ]) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  const readToken = env[MEDIA_READ_TOKEN_ENV];
  if ((stage.read_repos ?? []).length > 0 && readToken !== undefined)
    out[MEDIA_GH_TOKEN_ENV] = readToken;
  const dispatchToken = env[MEDIA_DISPATCH_TOKEN_ENV];
  if ((stage.dispatch_repos ?? []).length > 0 && dispatchToken !== undefined)
    out[MEDIA_DISPATCH_ENV] = dispatchToken;
  Object.assign(out, extra);
  out[MEDIA_DIR_ENV] = dir;
  return out;
}

/**
 * media.ts's TMPDIR when the runner sets none: a directory in the run
 * directory. The runner's /tmp is a tmpfs, so working files there (frames,
 * clips, recordings) would take the memory the encoders need.
 */
export function mediaTmpEnv(
  env: NodeJS.ProcessEnv,
  runRoot: string,
): Record<string, string> {
  if (env.TMPDIR) return {};
  const tmp = join(runRoot, "tmp");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return { TMPDIR: tmp };
}

/** The run's media directory: in the run directory, never in the data directory the box mounts. */
export function createMediaDir(runRoot: string): string {
  const dir = join(runRoot, MEDIA_DIR);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is gone already.
  }
}

/**
 * Runs media.ts in a process group of its own with exactly env, its output
 * in the workflow log. When it ends, or runs past timeoutMs, everything it
 * started is stopped, so no browser or encoder keeps running beside the box.
 */
export function runMediaScript(
  root: string,
  name: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<void> {
  const label = jobFile(name, "media.ts");
  let args: string[];
  try {
    args = jobScriptArgs(root, name, "media.ts");
  } catch (err) {
    return Promise.reject(err as Error);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    let stderrTail = "";
    child.stdout!.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(
        -STDERR_TAIL_BYTES,
      );
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      killGroup(child.pid);
      if (timedOut)
        return reject(
          new Error(
            `${label} ran longer than media.timeout_minutes in job.yml allows and was stopped`,
          ),
        );
      if (code !== 0) {
        const why = failureLine(stderrTail);
        return reject(
          new Error(
            `${label} failed (${signal === null ? `exit ${code}` : signal})${why === undefined ? "" : `: ${why}`}`,
          ),
        );
      }
      resolve();
    });
  });
}

/** Puts the job's media fixture into the media directory, for a stub run; false when the job has none. */
export function copyMediaFixture(
  root: string,
  name: string,
  dir: string,
): boolean {
  const fixture = join(root, jobFile(name, MEDIA_FIXTURE));
  if (!existsSync(fixture)) return false;
  const manifest = JSON.parse(readFileSync(fixture, "utf8")) as {
    files?: { path?: unknown }[];
  };
  for (const file of manifest.files ?? []) {
    if (typeof file.path !== "string") continue;
    const to = join(dir, file.path);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(join(root, jobFile(name, MEDIA_FIXTURE_DIR), file.path), to);
  }
  copyFileSync(fixture, join(dir, MEDIA_MANIFEST));
  return true;
}

/**
 * Keeps media.json and, below the report cap, the files of the types a
 * report keeps, in manifest order, each read again and checked against
 * its sha256.
 */
export function keepMedia(
  report: ReportWriter,
  dir: string,
  manifest: MediaManifest,
): Pick<MediaRecord, "kept" | "notKept"> {
  report.write(
    `${MEDIA_DIR}/${MEDIA_MANIFEST}`,
    readFileSync(join(dir, MEDIA_MANIFEST), "utf8"),
  );
  const kept: string[] = [];
  const notKept: { path: string; reason: string }[] = [];
  let total = 0;
  for (const file of manifest.files) {
    if (!REPORT_MEDIA_TYPES.includes(file.type)) {
      notKept.push({
        path: file.path,
        reason: `${file.type} is not a type a report keeps`,
      });
      continue;
    }
    if (total + file.bytes > MAX_REPORT_MEDIA_BYTES) {
      notKept.push({
        path: file.path,
        reason: `over the report's ${MAX_REPORT_MEDIA_BYTES / (1024 * 1024)} MB of media`,
      });
      continue;
    }
    const data = readMediaFile(dir, file);
    const name = `${MEDIA_DIR}/${file.path}`;
    if (file.type === "text/vtt") report.write(name, data.toString("utf8"));
    else if (!report.writeBytes(name, data)) {
      notKept.push({ path: file.path, reason: "it holds a secret value" });
      continue;
    }
    total += file.bytes;
    kept.push(file.path);
  }
  return { kept, notKept };
}

export interface MediaStageResult {
  record: MediaRecord;
  /** The media directory and its checked manifest; unset when a stub run had no fixture. */
  media?: { dir: string; manifestPath: string; manifest: MediaManifest };
  failure?: string;
}

/**
 * The media stage: media.ts (in a stub run, the job's media fixture) fills
 * the run's media directory, then the manifest and every file are checked
 * and media.json and the files a report keeps go into the report.
 */
export async function runMediaStage(options: {
  root: string;
  config: JobConfig & { media: MediaStage };
  runRoot: string;
  env: NodeJS.ProcessEnv;
  stub: boolean;
  report: ReportWriter;
  /** Added to media.ts's environment: the media model's socket, when the job has one. */
  extraEnv?: Record<string, string>;
}): Promise<MediaStageResult> {
  const { config, report } = options;
  const stage = config.media;
  const record: MediaRecord = {
    source: options.stub ? "fixture" : "media.ts",
    network: stage.network,
    files: 0,
    bytes: 0,
    kept: [],
    notKept: [],
  };
  const dir = createMediaDir(options.runRoot);
  try {
    if (options.stub) {
      if (!copyMediaFixture(options.root, config.name, dir)) {
        record.source = "none";
        return { record };
      }
    } else {
      await runMediaScript(
        options.root,
        config.name,
        mediaEnv(options.env, stage, dir, {
          ...mediaTmpEnv(options.env, options.runRoot),
          ...options.extraEnv,
        }),
        stage.timeout_minutes * 60_000,
      );
    }
  } catch (err) {
    return { record, failure: firstLine(err) };
  }
  const manifestPath = join(dir, MEDIA_MANIFEST);
  let manifest: MediaManifest;
  try {
    manifest = readMediaManifest(manifestPath, dir);
  } catch (err) {
    return {
      record,
      failure: `the media of ${jobFile(config.name, "media.ts")} were refused: ${firstLine(err)}`,
    };
  }
  record.files = manifest.files.length;
  record.bytes = manifest.files.reduce((sum, f) => sum + f.bytes, 0);
  record.hash = manifest.hash;
  try {
    Object.assign(record, keepMedia(report, dir, manifest));
  } catch (err) {
    return {
      record,
      failure: `keeping the media in the report failed: ${firstLine(err)}`,
    };
  }
  return { record, media: { dir, manifestPath, manifest } };
}
