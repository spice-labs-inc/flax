import type { SurfaceName } from "@flax/contract";
/** One feature file as the catalog reads it: the product's own description of what a customer can do. */
export interface FeatureEntry {
    /** Path from the repo root, as scenario ids start with it. */
    id: string;
    name: string;
    description: string;
    tags: string[];
    /** The surface the file sits under; "core" features cross surfaces. */
    surface: SurfaceName | "core";
    /** The @area tag, else the file's own name. */
    area: string;
    /** A Scenario Outline counts once per Examples row, keyed by the row's line as runs key it. */
    scenarios: {
        id: string;
        name: string;
        description: string;
        tags: string[];
        example?: OutlineRow;
    }[];
}
/** A row of a Scenario Outline: the outline as written, and the row's cells that tell the rows apart. */
export interface OutlineRow {
    /** The outline's own line. */
    outline: number;
    /** The outline's name as written, placeholders and all. */
    name: string;
    cells: string[];
}
/** Every feature file under `<root>/features`, in path order, with its scenarios. */
export declare function featuresCatalog(root: string): FeatureEntry[];
