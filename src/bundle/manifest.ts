import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUNDLE_DIR,
  BUNDLE_MANIFEST,
  bundledJobScript,
  JOB_SCRIPTS,
  jobFile,
  JOBS_DIR,
  KIT_ROOT,
  REBUILD_DIST,
  toolFile,
  TOOLS_DIR,
} from "../lib/paths.ts";
import { problem, type Problem } from "../lib/problem.ts";
import { byCodePoint } from "../lib/sort.ts";

export const LOCKFILE = "pnpm-lock.yaml";

/** dist/manifest.json: what the committed bundles are and what they were built from. */
export interface BundleManifest {
  /** The kit package and version the bundles were built with. */
  kit?: { name: string; version: string };
  /** Each bundle, by path inside dist/, with its sha256. */
  files: Record<string, string>;
  /** Every file the bundles were built from, and the lockfile, with their sha256: workspace files by path, kit sources as node_modules/@flax/agents/... */
  sources: Record<string, string>;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(byCodePoint);
}

/** The tools whose map.ts goes into the runner bundle: every tool folder that has one. */
export function bundledTools(root: string): string[] {
  return subdirs(join(root, TOOLS_DIR)).filter((name) =>
    existsSync(join(root, toolFile(name, "map.ts"))),
  );
}

/** The job scripts that get a bundle of their own, as [job, file] pairs. */
export function bundledJobScripts(root: string): [string, string][] {
  return subdirs(join(root, JOBS_DIR)).flatMap((name) =>
    JOB_SCRIPTS.filter((file) =>
      existsSync(join(root, jobFile(name, file))),
    ).map((file): [string, string] => [name, file]),
  );
}

function hashOf(path: string): string | undefined {
  return existsSync(path) ? sha256(readFileSync(path)) : undefined;
}

/** The package the kit is, as a workspace's node_modules names it. */
export const KIT_PACKAGE = "@flax/agents";

/**
 * A manifest source on disk. A workspace file is under the root. A package
 * source (node_modules/<package>/<path>) is read through the workspace's own
 * node_modules, else through the kit's (the kit depends on everything a
 * bundle holds), else, for the kit itself, from the kit's own tree.
 */
export function sourceFile(root: string, file: string): string {
  if (!file.startsWith("node_modules/")) return join(root, file);
  const direct = join(root, file);
  if (existsSync(direct)) return direct;
  const viaKit = join(KIT_ROOT, file);
  if (existsSync(viaKit)) return viaKit;
  const own = `node_modules/${KIT_PACKAGE}/`;
  return file.startsWith(own) ? join(KIT_ROOT, file.slice(own.length)) : direct;
}

/**
 * Whether the committed bundles still match the tree, with nothing but
 * hashing, so the bundled runner can ask it too: every source and the
 * lockfile they were built from is unchanged, every bundle is the one the
 * manifest names, and every tool mapping and job script is in them. The
 * Rebuild dist workflow rebuilds them on main (flax agents generate --dist).
 */
export function manifestProblems(root: string): Problem[] {
  const path = join(root, BUNDLE_MANIFEST);
  if (!existsSync(path))
    return [problem(BUNDLE_MANIFEST, `is missing; ${REBUILD_DIST}`)];
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8")) as BundleManifest;
    if (
      typeof manifest.files !== "object" ||
      manifest.files === null ||
      typeof manifest.sources !== "object" ||
      manifest.sources === null
    )
      throw new Error("files and sources must be objects");
  } catch (err) {
    return [
      problem(
        BUNDLE_MANIFEST,
        `is not a bundle manifest (${(err as Error).message}); ${REBUILD_DIST}`,
      ),
    ];
  }
  const problems: Problem[] = [];
  for (const [file, hash] of Object.entries(manifest.sources).sort(([a], [b]) =>
    byCodePoint(a, b),
  )) {
    const now = hashOf(sourceFile(root, file));
    if (now === undefined)
      problems.push(
        problem(
          file,
          `is gone but the runner bundles were built from it; ${REBUILD_DIST}`,
        ),
      );
    else if (now !== hash)
      problems.push(
        problem(
          file,
          `changed after the runner bundles were built; ${REBUILD_DIST}`,
        ),
      );
  }
  for (const [file, hash] of Object.entries(manifest.files).sort(([a], [b]) =>
    byCodePoint(a, b),
  )) {
    const rel = `${BUNDLE_DIR}/${file}`;
    const now = hashOf(join(root, rel));
    if (now === undefined)
      problems.push(problem(rel, `is missing; ${REBUILD_DIST}`));
    else if (now !== hash)
      problems.push(
        problem(rel, `is not the bundle the manifest names; ${REBUILD_DIST}`),
      );
  }
  const newer = bundledTools(root)
    .map((name) => toolFile(name, "map.ts"))
    .filter((file) => !(file in manifest.sources));
  for (const file of newer)
    problems.push(
      problem(file, `is not in the runner bundles; ${REBUILD_DIST}`),
    );
  for (const [name, file] of bundledJobScripts(root)) {
    const bundle = bundledJobScript(name, file).slice(BUNDLE_DIR.length + 1);
    if (!(bundle in manifest.files))
      problems.push(
        problem(
          jobFile(name, file),
          `has no bundle in ${BUNDLE_DIR}/; ${REBUILD_DIST}`,
        ),
      );
  }
  return problems;
}
