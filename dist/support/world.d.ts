import { World, type IWorldOptions } from "@cucumber/cucumber";
import type { Browser, Page } from "playwright";
import type { Env, SurfaceFile } from "../lib/types.ts";
import type { Touch } from "@flax/contract";
/** A committed surface file, read once per run. */
export declare function surface(name: string): SurfaceFile;
/** One headless Chromium per run (per worker in a parallel run), launched by the first scenario that needs a page. */
export declare function sharedBrowser(): Promise<Browser>;
export declare function closeSharedBrowser(): Promise<void>;
/**
 * The base World: env, hosts, run id, touches, a page per scenario. A workspace subclasses it, registers
 * its subclass with setWorldConstructor, and adds its API client and fixtures.
 */
export declare class ScenarioWorld extends World {
    readonly env: Env;
    /** The env's hosts by key, from the config. */
    readonly hosts: Record<string, string>;
    readonly runId: string;
    readonly touches: Touch[];
    private context;
    private currentPage;
    constructor(options: IWorldOptions);
    /** The index of the step running now, which each touch carries; set by the BeforeStep hook. */
    step: number | undefined;
    /** Records that this scenario proved something about a surface item. */
    touch(item: string, need?: string): void;
    /** Keeps a touch, tagged with the step running now. */
    record(t: Touch): void;
    /** A browser page in this scenario's own context; routes of every surface with a link host that it lands on are recorded. */
    page(): Promise<Page>;
    /** An element by test id on a UI surface; acting on it or asserting it covers the test id. */
    byTestId(surfaceName: string, id: string): Promise<import("playwright").Locator>;
    closePage(): Promise<void>;
}
