// Inventories: tables generated from another repository at head and written into a
// generated block of an atlas doc. What a table says is the workspace's business
// (its job files, its gitops layout), so each inventory in flax.yml names a renderer
// module of its own; this file only clones the repository and calls it.
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config, paths } from "../config.js";
import { renderTable } from "./markdown.js";
import { parseYaml } from "./yaml.js";
/**
 * The renderer module named in flax.yml, resolved against the workspace directory: a JavaScript
 * module exporting `render` (or a default function) with the Renderer signature. A TypeScript
 * module works too: when the running Node does not strip types itself, its types are stripped
 * here and the module is loaded from memory, so it may import Node built-ins and nothing else.
 */
export async function loadRenderer(spec, workspaceDir) {
    const file = isAbsolute(spec) ? spec : resolve(workspaceDir, spec);
    let mod;
    try {
        if (/\.[cm]?ts$/.test(file) && !process.features.typescript) {
            const { stripTypeScriptTypes } = await import('node:module');
            const js = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
            mod = (await import(__rewriteRelativeImportExtension(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)));
        }
        else {
            mod = (await import(__rewriteRelativeImportExtension(pathToFileURL(file).href)));
        }
    }
    catch (e) {
        throw new Error(`cannot load the inventory renderer ${spec}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const fn = typeof mod['render'] === 'function' ? mod['render'] : typeof mod['default'] === 'function' ? mod['default'] : undefined;
    if (!fn)
        throw new Error(`inventory renderer ${spec} exports neither render nor a default function`);
    return fn;
}
export async function inventories(workspaceDir = paths().workspace.dir) {
    const out = [];
    for (const i of config().inventories) {
        const render = await loadRenderer(i.renderer, workspaceDir);
        const helpers = {
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
export function sparseClone(repo, paths, prefix = `https://github.com/${config().org.github}/`) {
    const dir = mkdtempSync(join(tmpdir(), `atlas-${repo}-`));
    const git = (...args) => execFileSync("git", args, { stdio: ["ignore", "ignore", "pipe"] });
    git("clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", `${prefix}${repo}.git`, dir);
    git("-C", dir, "sparse-checkout", "set", ...paths);
    return dir;
}
//# sourceMappingURL=inventories.js.map