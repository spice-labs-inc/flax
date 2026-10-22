import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { build, type Metafile } from "esbuild";
import {
  BUNDLE_DIR,
  BUNDLE_MANIFEST,
  bundledJobScript,
  jobFile,
  KIT_ROOT,
  REVISE_POLL_BUNDLE,
  RUNNER_BUNDLE,
  toolFile,
} from "../lib/paths.ts";
import { MEDIA_EXTERNALS } from "../lib/media.ts";
import { problem, type Problem } from "../lib/problem.ts";
import { byCodePoint } from "../lib/sort.ts";
import type { Check } from "../check/types.ts";
import {
  bundledJobScripts,
  bundledTools,
  KIT_PACKAGE,
  LOCKFILE,
  sha256,
  sourceFile,
  type BundleManifest,
} from "./manifest.ts";

/** The nearest package.json above a file, with the package's name. */
function packageOfFile(file: string): { dir: string; name: string } | undefined {
  let dir = dirname(file);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
      if (typeof name === "string" && name !== "") return { dir, name };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * A bundle input as the manifest records it: a workspace file by its path
 * from the root; a file of a linked package (the kit, or another package
 * esbuild followed a symlink into) as node_modules/<package>/<path>, which
 * every machine resolves the same way, never the checkout's own location.
 * Files inside an installed node_modules are the lockfile's business.
 */
export function manifestPath(root: string, input: string): string | undefined {
  if (input.includes("node_modules/")) return undefined;
  const real = resolve(root, input);
  if (!existsSync(real)) return undefined;
  const rootReal = realpathSync(root);
  if (real.startsWith(rootReal + sep)) return relative(rootReal, real).split(sep).join("/");
  // A workspace entry that is a symbolic link (tools -> elsewhere): its files keep the workspace's path.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    let linkedReal: string;
    try {
      linkedReal = realpathSync(join(root, entry.name));
    } catch {
      continue;
    }
    if (real === linkedReal || real.startsWith(linkedReal + sep))
      return `${entry.name}/${relative(linkedReal, real).split(sep).join("/")}`;
  }
  // The kit first: it holds a nested package (the Pi plugin) that is not a package of its own in any workspace.
  const kitReal = realpathSync(KIT_ROOT);
  if (real.startsWith(kitReal + sep)) return `node_modules/${KIT_PACKAGE}/${relative(kitReal, real).split(sep).join("/")}`;
  const pkg = packageOfFile(real);
  if (pkg === undefined) return undefined;
  return `node_modules/${pkg.name}/${relative(pkg.dir, real).split(sep).join("/")}`;
}

// The kit's own entry points, by absolute path: the bundle is built in the workspace, whose tree holds only tools and jobs.
const RUNNER_CLI = join(KIT_ROOT, "src/run-job/cli.ts");
const REVISE_POLL_CLI = join(KIT_ROOT, "src/revise/poll-cli.ts");
const MAPPING_MODULE = join(KIT_ROOT, "src/tools-server/mapping.ts");

/**
 * Optional peers that ws and debug look for with require inside try/catch;
 * none is installed, so the bundle runs without them, as the source does.
 */
const OPTIONAL_PEERS = new Set([
  "bufferutil",
  "utf-8-validate",
  "supports-color",
]);

// CommonJS packages call require for Node's own modules, which an ES module does not have.
const BANNER = [
  'import { createRequire as __notesAgentsCreateRequire } from "node:module";',
  "const require = __notesAgentsCreateRequire(import.meta.url);",
].join("\n");

/**
 * The runner's entry point: it hands the runner every tool mapping, so
 * the tools server imports nothing from the tree at run time, then starts
 * the run-job command line.
 */
export function runnerEntry(tools: readonly string[]): string {
  return [
    `import { useBundledMappings } from ${JSON.stringify(MAPPING_MODULE)};`,
    ...tools.map(
      (name, i) => `import * as tool${i} from "./${toolFile(name, "map.ts")}";`,
    ),
    "useBundledMappings({",
    ...tools.map((name, i) => `  ${JSON.stringify(name)}: tool${i},`),
    "});",
    `await import(${JSON.stringify(RUNNER_CLI)});`,
    "",
  ].join("\n");
}

// The kit's and the workspace's devDependencies: neither may end up in a bundle.
function devDependencies(root: string): Set<string> {
  const out = new Set<string>();
  for (const dir of [KIT_ROOT, root]) {
    const file = join(dir, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    for (const name of Object.keys(pkg.devDependencies ?? {})) out.add(name);
  }
  return out;
}

/** The package a node_modules input belongs to, the innermost one in pnpm's nested layout. */
function packageOf(input: string): string | undefined {
  const parts = input.split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return undefined;
  const first = parts[at + 1]!;
  return first.startsWith("@") ? `${first}/${parts[at + 2]}` : first;
}

export async function bundleOne(
  root: string,
  out: string,
  entry: { stdin: string } | { file: string },
  externals: readonly string[] = [],
): Promise<{ text: string; metafile: Metafile }> {
  const outfile = join(root, out);
  const result = await build({
    absWorkingDir: root,
    ...("stdin" in entry
      ? {
          stdin: {
            contents: entry.stdin,
            resolveDir: root,
            sourcefile: "run-job-entry.ts",
            loader: "ts" as const,
          },
        }
      : { entryPoints: [entry.file] }),
    outfile,
    ...(externals.length > 0 ? { external: [...externals] } : {}),
    write: false,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Whitespace and syntax only: names stay readable in stack traces, and no comment carries a path.
    minifyWhitespace: true,
    minifySyntax: true,
    banner: { js: BANNER },
    define: {
      // The kit root, relative to the bundle: schemas and the agent Dockerfile are read from the package at run time.
      FLAX_AGENTS_BUNDLE_ROOT: JSON.stringify(
        `${relative(dirname(outfile), KIT_ROOT)}/`,
      ),
    },
    legalComments: "eof",
    metafile: true,
    logLevel: "silent",
  });
  const foreign = Object.values(result.metafile.outputs)
    .flatMap((o) => o.imports)
    .filter(
      (i) =>
        i.external &&
        !isBuiltin(i.path) &&
        !externals.includes(i.path) &&
        !(i.kind === "require-call" && OPTIONAL_PEERS.has(i.path)),
    )
    .map((i) => i.path);
  if (foreign.length > 0)
    throw new Error(
      `${out} still imports ${[...new Set(foreign)].join(", ")}; a bundle may import only Node's own modules${externals.length > 0 ? ` and ${externals.join(", ")}` : ""}`,
    );
  const dev = devDependencies(root);
  const tools = [
    ...new Set(
      Object.keys(result.metafile.inputs)
        .map(packageOf)
        .filter((p): p is string => p !== undefined && dev.has(p)),
    ),
  ].sort(byCodePoint);
  if (tools.length > 0)
    throw new Error(
      `${out} would contain ${tools.join(", ")}, listed in devDependencies; the runner may use only runtime dependencies`,
    );
  const file = result.outputFiles.find((f) => f.path === outfile);
  if (file === undefined) throw new Error(`esbuild made no ${out}`);
  return { text: file.text, metafile: result.metafile };
}

/**
 * Builds the runner (run-job with every tool mapping), the revision
 * poller, and each job's collect.ts, render.ts and media.ts into single ES
 * modules that import nothing but Node's own modules (a media.ts may also
 * import MEDIA_EXTERNALS from node_modules), plus the manifest of what
 * they were built from, all keyed by path from the repository root. The
 * same sources and lockfile give the same bytes on every machine.
 */
export async function buildBundles(root: string): Promise<Map<string, string>> {
  const outputs: [
    string,
    { stdin: string } | { file: string },
    readonly string[],
  ][] = [
    [RUNNER_BUNDLE, { stdin: runnerEntry(bundledTools(root)) }, []],
    [REVISE_POLL_BUNDLE, { file: REVISE_POLL_CLI }, []],
    ...bundledJobScripts(root).map(
      ([name, file]): [string, { file: string }, readonly string[]] => [
        bundledJobScript(name, file),
        { file: jobFile(name, file) },
        file === "media.ts" ? MEDIA_EXTERNALS : [],
      ],
    ),
  ];
  const files = new Map<string, string>();
  const sources = new Set<string>(
    existsSync(join(root, LOCKFILE)) ? [LOCKFILE] : [],
  );
  for (const [out, entry, externals] of outputs) {
    const { text, metafile } = await bundleOne(root, out, entry, externals);
    files.set(out, text);
    for (const input of Object.keys(metafile.inputs)) {
      const path = manifestPath(root, input);
      if (path !== undefined) sources.add(path);
    }
  }
  const kitPackage = JSON.parse(readFileSync(join(KIT_ROOT, "package.json"), "utf8")) as { version: string };
  const manifest: BundleManifest = {
    kit: { name: KIT_PACKAGE, version: kitPackage.version },
    files: Object.fromEntries(
      [...files].map(([path, text]) => [
        path.slice(BUNDLE_DIR.length + 1),
        sha256(text),
      ]),
    ),
    sources: Object.fromEntries(
      [...sources]
        .sort(byCodePoint)
        .map((path) => [path, sha256(readFileSync(sourceFile(root, path)))]),
    ),
  };
  files.set(BUNDLE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}

/** Every file under dist/ now, by path from the repository root. */
export function existingBundleFiles(root: string): string[] {
  const dir = join(root, BUNDLE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => !e.isDirectory())
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .sort(byCodePoint);
}

export interface WriteBundlesResult {
  written: string[];
  unchanged: string[];
  removed: string[];
}

/** Rebuilds dist/: writes what changed and removes what no longer belongs there. */
export async function writeBundles(root: string): Promise<WriteBundlesResult> {
  const files = await buildBundles(root);
  const result: WriteBundlesResult = {
    written: [],
    unchanged: [],
    removed: [],
  };
  for (const [file, content] of files) {
    const path = join(root, file);
    if (existsSync(path) && readFileSync(path, "utf8") === content) {
      result.unchanged.push(file);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    result.written.push(file);
  }
  for (const file of existingBundleFiles(root)) {
    if (files.has(file)) continue;
    rmSync(join(root, file));
    result.removed.push(file);
  }
  return result;
}

/**
 * The runner bundles build from this tree. Whether the committed dist/ is
 * that build is not asked: pull requests never carry dist/, and main gets
 * it rebuilt after each merge (flax agents generate --dist in rebuild-dist.yml).
 */
export async function bundleProblems(root: string): Promise<Problem[]> {
  // A tree without the runner sources, such as a test repository, has nothing to bundle.
  if (!existsSync(RUNNER_CLI)) return [];
  try {
    await buildBundles(root);
    return [];
  } catch (err) {
    return [
      problem(
        BUNDLE_DIR,
        `the runner bundles do not build: ${(err as Error).message}`,
      ),
    ];
  }
}

export const bundleCheck: Check = {
  id: "bundle",
  title: "the runner bundles build",
  run: (repo) => bundleProblems(repo.root),
};
