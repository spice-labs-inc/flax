import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

/** The plugin's entry point and package, relative to the repository root. */
export const PLUGIN_DIR = "images/agent/pi-mcp-mailbox";
export const PLUGIN_ENTRY = `${PLUGIN_DIR}/src/extension.ts`;

export interface Bundle {
  path: string;
  bytes: number;
  sha256: string;
  /** The version in the plugin's package.json. */
  version: string;
}

/**
 * Bundles the Pi plugin (pi-mcp-mailbox) and its dependencies (the MCP client SDK)
 * into one ES module that imports nothing but Node's own modules, so the
 * agent image needs no node_modules for it and Pi needs to supply nothing.
 * The same sources and lockfile give the same bytes.
 */
export async function bundlePiPlugin(
  root: string,
  outFile: string,
): Promise<Bundle> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [PLUGIN_ENTRY],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "eof",
    metafile: true,
    logLevel: "silent",
  });
  const outputs = Object.values(result.metafile.outputs);
  const foreign = outputs
    .flatMap((o) => o.imports)
    .filter((i) => i.external && !i.path.startsWith("node:"))
    .map((i) => i.path);
  if (foreign.length > 0)
    throw new Error(
      `the bundle still imports ${[...new Set(foreign)].join(", ")}; it may import only node: modules`,
    );
  const data = readFileSync(outFile);
  const pkg = JSON.parse(
    readFileSync(join(root, PLUGIN_DIR, "package.json"), "utf8"),
  ) as { version: string };
  return {
    path: outFile,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    version: pkg.version,
  };
}
