import type { Env, Sighting, SurfaceItem, SurfaceName } from "../lib/types.ts";
/** A file from a repo checkout; `path` is repo-relative with forward slashes. */
export interface SourceFile {
    path: string;
    text: string;
}
export interface RouteParam {
    name: string;
    kind: "required" | "optional" | "rest";
    matcher?: string;
}
export interface Route {
    /** SvelteKit's route id: the directory under src/routes, groups and matchers kept. */
    routeId: string;
    /** URL pattern: groups dropped, params kept as `[name]`, `[[name]]`, `[...name]`; matchers dropped unless two routes would then share a pattern. */
    path: string;
    dir: string;
    groups: string[];
    params: RouteParam[];
    page?: {
        files: string[];
        component: boolean;
        load: boolean;
        serverLoad: boolean;
        actions: string[];
        redirectsTo: string[];
    };
    endpoint?: {
        file: string;
        methods: string[];
    };
}
export declare function isSpecFile(path: string): boolean;
/** Index just past the string, template, comment or bracketed group starting at `i`, else `i + 1`. */
export declare function skip(text: string, i: number): number;
/** The text between the bracket at `open` and its match. */
export declare function bracketed(text: string, open: number): string;
export declare function splitTopLevel(text: string): string[];
/** `text` without the line and block comments it starts with. */
export declare function stripLeadingComments(text: string): string;
/** Keys of an object literal body: `a: ...`, `"b": ...`, `c() {}`, `async d() {}`, shorthand `e`. */
export declare function objectKeys(body: string): string[];
/** Names a module exports, with the module each re-export comes from. */
export declare function moduleExports(text: string): {
    name: string;
    from?: string;
}[];
export declare function formActions(text: string): string[];
/** Splits a route id into its URL pattern, groups and params, following SvelteKit's routing rules; `keepMatchers` keeps `[name=matcher]` in the pattern. */
export declare function parseRouteId(routeId: string, keepMatchers?: boolean): {
    path: string;
    groups: string[];
    params: RouteParam[];
};
/** A route id or `resolve()` target as a URL pattern: matchers dropped, groups dropped. */
export declare function urlPattern(target: string): string;
/** Every page and endpoint under `routesDir`. Layouts, error pages and other files are not routes. */
export declare function parseRoutes(files: SourceFile[], routesDir?: string): Route[];
/**
 * The nav section a URL belongs to: its first fully static segment after the app base,
 * skipping params. Landing and redirect routes with no such segment group as "landing".
 */
export declare function sectionOf(path: string, appBase?: string): string;
export interface ItemContext {
    surface: SurfaceName;
    envs: Env[];
    /** The sighting for an item read from this repo-relative file. */
    seen: (path: string) => Sighting;
    appBase?: string;
    /** Extra details per route, keyed by route id. */
    routeDetails?: (route: Route) => Record<string, unknown>;
    /** The product name of a nav section (see sectionOf); default: the section as is. */
    sectionLabel?: (section: string) => string;
    /** Product sections whose pages render each file (see fileSections); without it, test ids group by fileArea. */
    fileSections?: Map<string, string[]>;
    /** The route items whose pages render each file (see fileRoutes): a test id one page renders is that page's child. */
    fileRoutes?: Map<string, string[]>;
}
export declare function routeItems(routes: Route[], ctx: ItemContext): SurfaceItem[];
export interface TestIdHit {
    /** The id, with `*` for each interpolated part. */
    value: string;
    dynamic: boolean;
    file: string;
    /** The component that renders the attribute, when `file` passes the id in through a prop. */
    via?: string;
    /** The source expression, kept for ids that could not be resolved past a variable. */
    expression?: string;
}
/**
 * Every data-testid in the given source files (spec files skipped). Ids a component takes
 * through a prop (`data-testid={testid}`) are resolved at the places that pass the prop.
 */
export declare function findTestIds(files: SourceFile[]): TestIdHit[];
/** Where a file lives, for grouping: the route URL for files under the routes dir, else its lib dir. */
export declare function fileArea(path: string, routesDir?: string): string;
export declare const NAVIGATION_AREA = "Navigation";
export declare const SHARED_AREA = "Shared across sections";
export declare const UNUSED_AREA = "Not used by any page";
/**
 * For each file, the product sections whose pages render it, following imports from route files:
 * a +page file gives its route's section; a +layout or +error file gives its own section, or
 * "Navigation" for the app-wide chrome above every section.
 */
export declare function fileSections(files: SourceFile[], label: (section: string) => string, routesDir?: string, appBase?: string): Map<string, string[]>;
/**
 * For each file, the route items whose +page files render it, following imports: the page a
 * component belongs to. Layouts and error pages are left out, so app-wide chrome belongs to no page.
 */
export declare function fileRoutes(files: SourceFile[], routes: Route[], surface: SurfaceName): Map<string, string[]>;
/** "data-health" as "Data health". */
export declare function sentenceCase(section: string): string;
export declare function testIdItems(hits: TestIdHit[], ctx: ItemContext): SurfaceItem[];
/** Every .svelte/.ts/.js file under `dir/sub`, paths relative to `dir`. */
export declare function readSources(dir: string, sub?: string): Promise<SourceFile[]>;
