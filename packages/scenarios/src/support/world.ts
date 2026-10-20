import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World, type IWorldOptions } from "@cucumber/cucumber";
import type { Browser, BrowserContext, Page } from "playwright";
import { config, envConfig, surfaceConfig } from "../config.ts";
import { markSynthetic } from "../lib/http.ts";
import type { Env, SurfaceFile } from "../lib/types.ts";
import type { Touch } from "@flax/contract";
import { currentEnv, currentRunId } from "../run/env.ts";
import { matchRoute } from "../run/routes.ts";

const surfaces = new Map<string, SurfaceFile>();

/** A committed surface file, read once per run. */
export function surface(name: string): SurfaceFile {
  let file = surfaces.get(name);
  if (!file) {
    file = JSON.parse(
      readFileSync(join(config().paths.surfaces, `${name}.json`), "utf8"),
    ) as SurfaceFile;
    surfaces.set(name, file);
  }
  return file;
}

let browser: Promise<Browser> | undefined;

/** One headless Chromium per run (per worker in a parallel run), launched by the first scenario that needs a page. */
export async function sharedBrowser(): Promise<Browser> {
  if (!browser) {
    const { chromium } = await import("playwright");
    browser = chromium.launch();
  }
  return browser;
}

export async function closeSharedBrowser(): Promise<void> {
  if (browser) await (await browser).close();
  browser = undefined;
}

/**
 * The base World: env, hosts, run id, touches, a page per scenario. A workspace subclasses it, registers
 * its subclass with setWorldConstructor, and adds its API client and fixtures.
 */
export class ScenarioWorld extends World {
  readonly env: Env;
  /** The env's hosts by key, from the config. */
  readonly hosts: Record<string, string>;
  readonly runId: string;
  readonly touches: Touch[] = [];
  private context: BrowserContext | undefined;
  private currentPage: Page | undefined;

  constructor(options: IWorldOptions) {
    super(options);
    this.env = currentEnv();
    this.hosts = envConfig(this.env).hosts;
    this.runId = currentRunId();
  }

  /** The index of the step running now, which each touch carries; set by the BeforeStep hook. */
  step: number | undefined;

  /** Records that this scenario proved something about a surface item. */
  touch(item: string, need?: string): void {
    this.record(need === undefined ? { item } : { item, need });
  }

  /** Keeps a touch, tagged with the step running now. */
  record(t: Touch): void {
    this.touches.push(this.step === undefined ? t : { ...t, step: this.step });
  }

  /** A browser page in this scenario's own context; routes of every surface with a link host that it lands on are recorded. */
  async page(): Promise<Page> {
    if (!this.currentPage) {
      this.context = await (
        await sharedBrowser()
      ).newContext({ viewport: { width: 1440, height: 900 } });
      await markSynthetic(this.context, Object.values(this.hosts));
      this.currentPage = await this.context.newPage();
      const tracked = config()
        .surfaces.filter((s) => s.linkHost && this.hosts[s.linkHost])
        .map((s) => ({
          surface: s.name,
          host: new URL(this.hosts[s.linkHost!]!).host,
          routes: surface(s.name)
            .items.filter((i) => i.id.startsWith(`${s.name}:route:`))
            .map((i) => i.id.slice(`${s.name}:route:`.length)),
        }));
      this.currentPage.on("framenavigated", (frame) => {
        if (frame !== this.currentPage?.mainFrame()) return;
        const url = new URL(frame.url());
        for (const t of tracked) {
          if (url.host !== t.host) continue;
          const route = matchRoute(t.routes, url.pathname);
          if (route) this.touch(`${t.surface}:route:${route}`);
        }
      });
    }
    return this.currentPage;
  }

  /** An element by test id on a UI surface; acting on it or asserting it covers the test id. */
  async byTestId(surfaceName: string, id: string) {
    if (!surfaceConfig(surfaceName))
      throw new Error(`unknown surface ${surfaceName}`);
    this.touch(`${surfaceName}:testid:${id}`);
    return (await this.page()).getByTestId(id);
  }

  async closePage(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.currentPage = undefined;
  }
}
