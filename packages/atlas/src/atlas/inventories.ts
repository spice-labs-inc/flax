// Inventories: tables generated from another repository at head and written into a
// generated block of an atlas doc. What a table says is the workspace's business
// (its job files, its gitops layout), so each inventory in flax.yml names a renderer
// module of its own; this file only clones the repository and calls it.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config, paths, type InventoryDef } from "../config.ts";
import { renderTable } from "./markdown.ts";
import { parseYaml } from "./yaml.ts";

/** What a renderer gets besides the checkout: the table helper, the YAML reader and the org. */
export interface RenderHelpers {
  renderTable: typeof renderTable;
  parseYaml: typeof parseYaml;
  org: { github: string };
  /** The inventory being rendered: its block id and the repository the checkout came from. */
  id: string;
  repo: string;
}

export type Renderer = (
  dir: string,
  helpers: RenderHelpers,
) => string | Promise<string>;

export interface Inventory extends InventoryDef {
  render(dir: string): Promise<string>;
}

/**
 * The renderer module named in flax.yml, resolved against the workspace directory: a JavaScript
 * module exporting `render` (or a default function) with the Renderer signature. A TypeScript
 * module works too: when the running Node does not strip types itself, its types are stripped
 * here and the module is loaded from memory, so it may import Node built-ins and nothing else.
 */
export async function loadRenderer(spec: string, workspaceDir: string): Promise<Renderer> {
  const file = isAbsolute(spec) ? spec : resolve(workspaceDir, spec);
  let mod: Record<string, unknown>;
  try {
    if (/\.[cm]?ts$/.test(file) && !process.features.typescript) {
      const { stripTypeScriptTypes } = await import('node:module');
      const js = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
      mod = (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)) as Record<string, unknown>;
    } else {
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    }
  } catch (e) {
    throw new Error(`cannot load the inventory renderer ${spec}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const fn = typeof mod['render'] === 'function' ? mod['render'] : typeof mod['default'] === 'function' ? mod['default'] : undefined;
  if (!fn) throw new Error(`inventory renderer ${spec} exports neither render nor a default function`);
  return fn as Renderer;
}

export async function inventories(
  workspaceDir: string = paths().workspace.dir,
): Promise<Inventory[]> {
  const out: Inventory[] = [];
  for (const i of config().inventories) {
    const render = await loadRenderer(i.renderer, workspaceDir);
    const helpers: RenderHelpers = {
      renderTable,
      parseYaml,
      org: { github: config().org.github },
      id: i.id,
      repo: i.repo,
    };
    out.push({ ...i, render: async (dir) => render(dir, helpers) });
  }
  return out;
}

/** A shallow, sparse, blobless clone of the default branch in a temp dir. */
export function sparseClone(
  repo: string,
  paths: string[],
  prefix = `https://github.com/${config().org.github}/`,
): string {
  const dir = mkdtempSync(join(tmpdir(), `atlas-${repo}-`));
  const git = (...args: string[]) =>
    execFileSync("git", args, { stdio: ["ignore", "ignore", "pipe"] });
  git(
    "clone",
    "-q",
    "--depth",
    "1",
    "--filter=blob:none",
    "--sparse",
    `${prefix}${repo}.git`,
    dir,
  );
  git("-C", dir, "sparse-checkout", "set", ...paths);
  return dir;
}
