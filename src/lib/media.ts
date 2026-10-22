import { workspace } from "./workspace.ts";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, sep } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { describeErrors } from "./ajv.ts";
import { MEDIA_SCHEMA } from "./schemas.ts";
import { byCodePoint } from "./sort.ts";

/** The empty directory media.ts writes into, in its environment. */
export const MEDIA_DIR_ENV = "FLAX_AGENTS_MEDIA_DIR";
/** The Unix socket media.ts reaches its model on (media.model in job.yml): the messages API, the key added by the runner. */
export const MEDIA_MODEL_SOCKET_ENV = "FLAX_AGENTS_MEDIA_MODEL_SOCKET";
/** The models.yml id of that model; the socket forces it on every call that names no other model it serves. */
export const MEDIA_MODEL_ENV = "FLAX_AGENTS_MEDIA_MODEL";
/** The models.yml id of media.model.fallback, which the socket serves to a call that names it; unset without one. */
export const MEDIA_MODEL_FALLBACK_ENV = "FLAX_AGENTS_MEDIA_MODEL_FALLBACK";
/** The absolute path of media.json, in the environment collect.ts gets. */
export const MEDIA_MANIFEST_ENV = "FLAX_AGENTS_MEDIA_MANIFEST";
export const MEDIA_MANIFEST = "media.json";
/** The part of a stage split into parts that this run of media.ts makes, in its environment. */
export const MEDIA_PART_ENV = "FLAX_AGENTS_MEDIA_PART";
/** A contents-read token for every repository the reader app can see, in the environment of a stage with media.org_read. */
export const MEDIA_ORG_READ_ENV = "FLAX_AGENTS_ORG_READ_TOKEN";
/** The heap an edition run uses instead of its scenario's, such as 8g, in the environment of a part with edition_heap. */
export const EDITION_HEAP_ENV = "FLAX_AGENTS_EDITION_HEAP";
/** The media inputs ticked for this run (media.inputs in job.yml), comma-separated, in media.ts's environment; unset when none is. */
export const MEDIA_INPUTS_ENV = "FLAX_AGENTS_MEDIA_INPUTS";

/** The names of the media inputs ticked for this run. */
export function mediaInputs(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env[MEDIA_INPUTS_ENV] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );
}

/**
 * The names a run's --media-input <name>=<value> flags tick: true ticks
 * the input, false or empty (a scheduled run's) leaves it off; any other
 * value, or a flag without =, is refused.
 */
export function mediaInputsOn(flags: readonly string[]): string[] {
  const on: string[] = [];
  for (const flag of flags) {
    const eq = flag.indexOf("=");
    const name = eq < 0 ? "" : flag.slice(0, eq);
    const value = eq < 0 ? "" : flag.slice(eq + 1);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name))
      throw new Error(`--media-input takes <name>=<true|false>, not "${flag}"`);
    if (value === "true") on.push(name);
    else if (value !== "false" && value !== "")
      throw new Error(
        `--media-input ${name} takes true or false, not "${value}"`,
      );
  }
  return [...new Set(on)];
}

/** What a part whose media stage failed leaves instead of its media: { part, reason }. */
export const MEDIA_PART_FAILED = "failed.json";

/** The artifact a part's media go up in for the delivery job, which downloads each into a folder of this name. */
export function mediaPartArtifact(job: string, part: string): string {
  return `job-${job}-media-${part}`;
}
/** The run directory's media directory, beside the data directory, never in it. */
export const MEDIA_DIR = "media";

/** The most media one run may make; the runner refuses more. */
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * The secrets a job's media.ts may be given, each listed by name in the
 * job's media.secrets. The runner holds them and gives media.ts only the
 * ones its job lists; lbx, the box, collect.ts and render.ts get none.
 */
export function mediaSecretEnv(): readonly string[] {
  return workspace().mediaSecrets;
}

/** The reader app's token for media.read_repos, in the run step's environment; media.ts gets it as GH_TOKEN. */
export const MEDIA_READ_TOKEN_ENV = "FLAX_AGENTS_MEDIA_READ_TOKEN";
/** What media.ts finds that token under: the name gh and the GitHub API clients read. */
export const MEDIA_GH_TOKEN_ENV = "GH_TOKEN";
/** The writer app's token for media.dispatch_repos, in the run step's environment. */
export const MEDIA_DISPATCH_TOKEN_ENV = "FLAX_AGENTS_MEDIA_DISPATCH_TOKEN";
/** What media.ts finds that token under. */
export const MEDIA_DISPATCH_ENV = "FLAX_AGENTS_DISPATCH_TOKEN";

/** The secrets the workspace's network join steps name (${{ secrets.X }}), which only those steps get. */
export function networkJoinSecrets(): string[] {
  const out = new Set<string>();
  for (const join of Object.values(workspace().networkJoins))
    for (const step of [...join.join, ...(join.leave ?? [])])
      for (const value of [
        ...Object.values(step.with ?? {}),
        ...Object.values(step.env ?? {}),
      ])
        for (const m of String(value).matchAll(/secrets\.([A-Z0-9_]+)/g))
          out.add(m[1]!);
  return [...out];
}

/** Variables media.ts gets from the runner's environment besides its secrets. */
export const MEDIA_BASE_ENV: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "CI",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_REPOSITORY",
  "GITHUB_SERVER_URL",
];

export interface MediaFile {
  /** Relative to the media directory. */
  path: string;
  sha256: string;
  bytes: number;
  /** The media type, such as video/mp4. */
  type: string;
}

/** A media.json that has passed schema/media.schema.json and every check against the files. */
export interface MediaManifest {
  version: 1;
  files: MediaFile[];
  hash: string;
  data?: unknown;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The manifest's hash: sha256 of the sorted `<path> <sha256>` lines, joined with a newline. */
export function mediaHash(
  files: readonly Pick<MediaFile, "path" | "sha256">[],
): string {
  return sha256Hex(
    files
      .map((f) => `${f.path} ${f.sha256}`)
      .sort(byCodePoint)
      .join("\n"),
  );
}

/** Why a manifest path is not a plain relative path, or undefined when it is. */
export function mediaPathProblem(path: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path))
    return "must be a relative path of letters, digits, dots, dashes and underscores";
  if (path.split("/").some((part) => part === "." || part === ".."))
    return "must not name . or ..";
  if (path === MEDIA_MANIFEST) return `must not be ${MEDIA_MANIFEST} itself`;
  return undefined;
}

let validator: ValidateFunction | undefined;

function schemaProblems(data: unknown): string[] {
  validator ??= new Ajv2020({
    allErrors: true,
    strict: true,
    verbose: true,
  }).compile(MEDIA_SCHEMA);
  if (validator(data)) return [];
  return describeErrors(validator.errors).map((e) =>
    e.field === undefined ? e.message : `${e.field}: ${e.message}`,
  );
}

function within(path: string, dir: string): boolean {
  return path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * Opens a file media.ts wrote, refusing a link, anything but a regular file,
 * and a path that leads out of the media directory through a linked
 * directory.
 */
function openMediaFile(dir: string, path: string): number {
  const full = join(dir, path);
  let real: string;
  try {
    real = realpathSync(full);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? `${path} does not exist`
        : `${path} cannot be opened (${code ?? "unknown error"})`,
    );
  }
  if (!within(real, realpathSync(dir)))
    throw new Error(`${path} leads out of the media directory`);
  let fd: number;
  try {
    fd = openSync(
      full,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ELOOP"
        ? `${path} is a symbolic link`
        : `${path} cannot be opened (${code ?? "unknown error"})`,
    );
  }
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new Error(`${path} is not a regular file`);
  }
  return fd;
}

const CHUNK = 1024 * 1024;

/** The size and sha256 of an open file, read in chunks so a large video never sits in memory whole. */
function digest(fd: number): { bytes: number; sha256: string } {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(CHUNK);
  let bytes = 0;
  for (;;) {
    const n = readSync(fd, buffer, 0, CHUNK, bytes);
    if (n === 0) break;
    hash.update(buffer.subarray(0, n));
    bytes += n;
  }
  return { bytes, sha256: hash.digest("hex") };
}

function readManifestText(path: string): string {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? `${MEDIA_MANIFEST} does not exist`
        : code === "ELOOP"
          ? `${MEDIA_MANIFEST} is a symbolic link`
          : `${MEDIA_MANIFEST} cannot be opened (${code ?? "unknown error"})`,
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new Error(`${MEDIA_MANIFEST} is not a regular file`);
    if (stat.size > MAX_MANIFEST_BYTES)
      throw new Error(
        `${MEDIA_MANIFEST} is ${stat.size} bytes, over the ${MAX_MANIFEST_BYTES} byte limit`,
      );
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads and checks a media manifest: its shape, every path plain and
 * unique, every file a regular file in dir whose size and sha256 match,
 * the total within MAX_MEDIA_BYTES, and the hash recomputed. Throws with
 * one line on the first thing wrong.
 */
export function readMediaManifest(
  manifestPath: string,
  dir: string,
): MediaManifest {
  let value: unknown;
  try {
    value = JSON.parse(readManifestText(manifestPath));
  } catch (err) {
    if (err instanceof SyntaxError)
      throw new Error(`${MEDIA_MANIFEST} is not valid JSON: ${err.message}`);
    throw err;
  }
  const problems = schemaProblems(value);
  if (problems.length > 0)
    throw new Error(
      `${MEDIA_MANIFEST} does not match schema/media.schema.json: ${problems.slice(0, 3).join("; ")}`,
    );
  const manifest = value as MediaManifest;
  const seen = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    const problem = mediaPathProblem(file.path);
    if (problem !== undefined)
      throw new Error(`${MEDIA_MANIFEST}: path ${file.path} ${problem}`);
    if (seen.has(file.path))
      throw new Error(`${MEDIA_MANIFEST}: ${file.path} is listed twice`);
    seen.add(file.path);
    total += file.bytes;
  }
  if (total > MAX_MEDIA_BYTES)
    throw new Error(
      `${MEDIA_MANIFEST} lists ${total} bytes of media, over the ${MAX_MEDIA_BYTES} byte limit`,
    );
  for (const file of manifest.files) {
    const fd = openMediaFile(dir, file.path);
    try {
      const actual = digest(fd);
      if (actual.bytes !== file.bytes)
        throw new Error(
          `${file.path} is ${actual.bytes} bytes, but ${MEDIA_MANIFEST} says ${file.bytes}`,
        );
      if (actual.sha256 !== file.sha256)
        throw new Error(
          `${file.path} does not match its sha256 in ${MEDIA_MANIFEST}`,
        );
    } finally {
      closeSync(fd);
    }
  }
  if (mediaHash(manifest.files) !== manifest.hash)
    throw new Error(
      `${MEDIA_MANIFEST}: hash is not the hash of its files' paths and sha256`,
    );
  return manifest;
}

/**
 * The bytes of one file of a checked manifest, read again and checked
 * against its sha256 first, for delivery code that uses a media file.
 */
export function readMediaFile(dir: string, file: MediaFile): Buffer {
  const fd = openMediaFile(dir, file.path);
  try {
    const size = fstatSync(fd).size;
    if (size !== file.bytes)
      throw new Error(
        `${file.path} is ${size} bytes now, but ${MEDIA_MANIFEST} says ${file.bytes}`,
      );
    const data = readFileSync(fd);
    if (sha256Hex(data) !== file.sha256)
      throw new Error(
        `${file.path} changed after ${MEDIA_MANIFEST} was checked`,
      );
    return data;
  } finally {
    closeSync(fd);
  }
}

/** A stub run's stand-in for media.ts: a manifest in the job's fixtures and its files under fixtures/media/. */
export const MEDIA_FIXTURE = "fixtures/media.json";
export const MEDIA_FIXTURE_DIR = "fixtures/media";

/**
 * Packages a media.ts bundle leaves out and imports from node_modules at run
 * time: Playwright cannot be bundled (it loads its own files and its browser
 * protocol modules by path). A job whose media.ts imports one installs the
 * locked packages first (media.setup: packages).
 */
export const MEDIA_EXTERNALS: readonly string[] = ["playwright"];
