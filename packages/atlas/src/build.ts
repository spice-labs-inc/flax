// `flax atlas build`: bundle the viewer into one self-contained HTML file.
//
// Everything is inlined: a strict CSP may block external hosts, and a single file
// with the data already embedded means no fetch round-trip on load.
//
//   --workspace <dir>   the directory holding flax.yml (default: the current directory)
//   --viz <path>        the directory holding data/ and dist/ (default: atlas.viz)
//   --graph <path>      bundle an alternate graph.json without disturbing the committed one

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAtlas, viewerConfig } from "./config.ts";

/** The viewer source the bundle is built from: src/app in the package, beside dist/. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(PACKAGE_ROOT, "src", "app");

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

export async function main(argv: string[]): Promise<number> {
  const workspaceDir = resolve(flag(argv, "workspace") ?? process.cwd());
  const { config, vizRoot: configuredViz } = loadAtlas(workspaceDir);
  const vizRoot = flag(argv, "viz")
    ? resolve(flag(argv, "viz")!)
    : configuredViz;
  const dist = join(vizRoot, "dist");
  const viewer = viewerConfig(config);
  mkdirSync(dist, { recursive: true });

  const graphPath = flag(argv, "graph")
    ? resolve(flag(argv, "graph")!)
    : join(vizRoot, "data", "graph.json");
  try {
    statSync(graphPath);
  } catch {
    console.error(`${graphPath} is missing; run flax atlas generate first.`);
    return 1;
  }

  const esbuild = await import("esbuild");
  const result = await esbuild.build({
    entryPoints: [join(APP, "main.ts")],
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2022",
    legalComments: "none",
    write: false,
  });

  const js = result.outputFiles[0].text;
  const css = readFileSync(join(APP, "style.css"), "utf8");
  // A JSON payload can legally contain "</script>"; neutralise it.
  const data = readFileSync(graphPath, "utf8").replace(/<\//g, "<\\/");

  const html = readFileSync(join(APP, "index.html"), "utf8")
    .replace(/__TITLE__/g, () => viewer.site.title)
    .replace("__SEARCH__", () => viewer.site.searchPlaceholder)
    .replace("__CONFIG__", () => JSON.stringify(viewer).replace(/<\//g, "<\\/"))
    .replace("__CSS__", () => css)
    .replace("__DATA__", () => data)
    .replace("__JS__", () => js);

  // index.html is what a static host serves for a directory URL; atlas-3d.html
  // is the same bytes under a name that makes sense as a downloaded file.
  const out = join(dist, "index.html");
  writeFileSync(out, html);
  writeFileSync(join(dist, "atlas-3d.html"), html);

  // Re-assert the custom domain on every build when the config names one, so a
  // Pages redeploy can never silently drop it (GitHub clears the domain if the CNAME file disappears).
  if (viewer.site.cname)
    writeFileSync(join(dist, "CNAME"), `${viewer.site.cname}\n`);

  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`built ${out} (+ atlas-3d.html)`);
  console.log(`  js    ${kb(js.length)}`);
  console.log(`  data  ${kb(data.length)}`);
  console.log(`  total ${kb(html.length)}`);
  return 0;
}
