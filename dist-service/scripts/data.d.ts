import { type CoverageFile, type DocSource, type Env, type HistoryFile, type JourneysFile, type Persona, type PlannedScenario, type RunResult, type SurfaceFile, type SurfaceName } from "@flax/contract";
import { type CoverageMap } from "@flax/scenarios/coverage/map";
import type { JourneyResolution } from "@flax/scenarios/dataset/journeys";
/** One scheduled run as `pnpm results:fetch` leaves it: `<results>/<env>/<id>/run.json` and `planned.json`. */
export interface RunOnDisk {
    env: Env;
    id: string;
    run: RunResult;
    planned: PlannedScenario[];
}
export type { DocSource };
/** A README or internal doc that documents items, from the documentation file beside the coverage map; absent means none. */
export declare function readDocumentation(root: string): DocSource[];
export declare function readSurfaces(root: string): SurfaceFile[];
/** Every run on disk, oldest finish first. */
export declare function readRuns(resultsDir: string): RunOnDisk[];
/** The runs the timeline stops at: every run of the last week, and before that the last run of each day in the configured timezone. */
export declare function historyPoints<T extends {
    run: {
        finishedAt: string;
    };
}>(runs: T[]): T[];
/** The coverage map as it stood once these runs had finished. */
export declare function coverageAfter(files: SurfaceFile[], runs: RunOnDisk[], builtAt: string): CoverageMap;
/** Where an item can be opened in a browser: a site page.s one address, or a page of a surface with a link host on each environment it runs in. Pages whose route takes a parameter have no address to give. */
export declare function itemLinks(item: {
    id: string;
    surface: SurfaceName;
    envs: Env[];
}, details?: Record<string, unknown>): {
    env?: Env;
    url: string;
}[];
/** What kind of thing an item is, in product words, from the surface config: by details.kind, else by the id.s second segment, else the default. */
export declare function itemKind(id: string, details?: Record<string, unknown>): string;
/** The kind words a surface uses for a page that holds elements, and for an element; "Page" and "Element" unless the config says otherwise. */
export declare function pageElementKinds(surface: string): {
    page: string;
    element: string;
};
/** The page an element sits on: the route whose file the surface builder saw it in, else its area's only page. */
export declare function pageOfElement(files: SurfaceFile[], item: {
    id: string;
    surface: string;
}): string | undefined;
/** The component an element belongs to, as words, from the first source file the surface builder saw it in. */
export declare function componentOfElement(files: SurfaceFile[], item: {
    id: string;
    surface: string;
}): string | undefined;
export declare function coverageFile(map: CoverageMap, files: SurfaceFile[], documentation?: DocSource[], runs?: RunOnDisk[]): CoverageFile;
/** data/journeys.json: personas, and journeys with their stations resolved to item ids. */
export declare function journeysFile(personas: Persona[], resolved: JourneyResolution, commit: string): JourneysFile;
/**
 * data/history.json: the coverage map after each timeline point, rebuilt with the coverage map's own merge rules,
 * plus every scenario any run recorded and the planned scenarios the latest runs list.
 */
export declare function historyFile(root: string, files: SurfaceFile[], runs: RunOnDisk[], commit: string, builtAt: string): HistoryFile;
export type { BoardEntry, BoardFile } from "@flax/contract";
import type { BoardEntry } from "@flax/contract";
/** One GraphQL query reading whether each board issue is still open. */
export declare function boardQuery(entries: BoardEntry[]): string;
