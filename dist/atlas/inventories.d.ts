import { type InventoryDef } from "../config.ts";
import { renderTable } from "./markdown.ts";
import { parseYaml } from "./yaml.ts";
/** What a renderer gets besides the checkout: the table helper, the YAML reader and the org. */
export interface RenderHelpers {
    renderTable: typeof renderTable;
    parseYaml: typeof parseYaml;
    org: {
        github: string;
    };
    /** The inventory being rendered: its block id and the repository the checkout came from. */
    id: string;
    repo: string;
}
export type Renderer = (dir: string, helpers: RenderHelpers) => string | Promise<string>;
export interface Inventory extends InventoryDef {
    render(dir: string): Promise<string>;
}
/**
 * The renderer module named in flax.yml, resolved against the workspace directory: a JavaScript
 * module exporting `render` (or a default function) with the Renderer signature. A TypeScript
 * module works too: when the running Node does not strip types itself, its types are stripped
 * here and the module is loaded from memory, so it may import Node built-ins and nothing else.
 */
export declare function loadRenderer(spec: string, workspaceDir: string): Promise<Renderer>;
export declare function inventories(workspaceDir?: string): Promise<Inventory[]>;
/** A shallow, sparse, blobless clone of the default branch in a temp dir. */
export declare function sparseClone(repo: string, paths: string[], prefix?: string): string;
