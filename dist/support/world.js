import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World } from "@cucumber/cucumber";
import { config, envConfig, surfaceConfig } from "../config.js";
import { markSynthetic } from "../lib/http.js";
import { currentEnv, currentRunId } from "../run/env.js";
import { matchRoute } from "../run/routes.js";
import { plainMedia, } from "../record/media.js";
const surfaces = new Map();
/** A committed surface file, read once per run. */
export function surface(name) {
    let file = surfaces.get(name);
    if (!file) {
        file = JSON.parse(readFileSync(join(config().paths.surfaces, `${name}.json`), "utf8"));
        surfaces.set(name, file);
    }
    return file;
}
let browser;
/** One headless Chromium per run (per worker in a parallel run), launched by the first scenario that needs a page. */
export async function sharedBrowser() {
    if (!browser) {
        const { chromium } = await import("playwright");
        browser = chromium.launch();
    }
    return browser;
}
const filming = new Map();
/**
 * The Chromium a record run films in, one per device scale factor. A screencast captures CSS
 * pixels, so the scale is the browser's own (a launch flag) rather than the context's.
 */
async function filmingBrowser(scale) {
    let b = filming.get(scale);
    if (!b) {
        const { chromium } = await import("playwright");
        b = chromium.launch({
            args: ["--hide-scrollbars", `--force-device-scale-factor=${scale}`],
        });
        filming.set(scale, b);
    }
    return b;
}
let stills;
/** The Chromium a capture run takes its screenshots in: the shared one's settings, with scrollbars hidden. */
async function stillsBrowser() {
    if (!stills) {
        const { chromium } = await import("playwright");
        stills = chromium.launch({ args: ["--hide-scrollbars"] });
    }
    return stills;
}
export async function closeSharedBrowser() {
    if (browser)
        await (await browser).close();
    browser = undefined;
    if (stills)
        await (await stills).close();
    stills = undefined;
    for (const b of filming.values())
        await (await b).close();
    filming.clear();
}
/**
 * The base World: env, hosts, run id, touches, a page per scenario. A workspace subclasses it, registers
 * its subclass with setWorldConstructor, and adds its API client and fixtures.
 */
export class ScenarioWorld extends World {
    env;
    /** The env's hosts by key, from the config. */
    hosts;
    runId;
    touches = [];
    context;
    currentPage;
    constructor(options) {
        super(options);
        this.env = currentEnv();
        this.hosts = envConfig(this.env).hosts;
        this.runId = currentRunId();
    }
    /** The index of the step running now, which each touch carries; set by the BeforeStep hook. */
    step;
    /** Records that this scenario proved something about a surface item. */
    touch(item, need) {
        this.record(need === undefined ? { item } : { item, need });
    }
    /** Keeps a touch, tagged with the step running now. */
    record(t) {
        this.touches.push(this.step === undefined ? t : { ...t, step: this.step });
    }
    /**
     * What steps tell a recording (the element they act on or check, the commands they run). In a
     * scenario a record run films, the recording paces and draws them; anywhere else they only click and type.
     */
    get media() {
        return this.recording ?? this.capturing ?? plainMedia;
    }
    /** The recording of this scenario, set by the base hooks in a record run. */
    recording;
    /** This scenario's screenshots, set by the base hooks in a capture run for a scenario its tags select. */
    capturing;
    /** A browser page in this scenario's own context; routes of every surface with a link host that it lands on are recorded. */
    async page() {
        if (!this.currentPage) {
            this.context = this.recording
                ? await (await filmingBrowser(this.recording.scale)).newContext({ viewport: this.recording.viewport })
                : this.capturing
                    ? await (await stillsBrowser()).newContext(this.capturing.contextOptions())
                    : await (await sharedBrowser()).newContext({ viewport: { width: 1440, height: 900 } });
            await markSynthetic(this.context, Object.values(this.hosts));
            this.currentPage = await this.context.newPage();
            await this.recording?.attach(this.currentPage);
            await this.capturing?.attach(this.currentPage);
            const tracked = config()
                .surfaces.filter((s) => s.linkHost && this.hosts[s.linkHost])
                .map((s) => ({
                surface: s.name,
                host: new URL(this.hosts[s.linkHost]).host,
                routes: surface(s.name)
                    .items.filter((i) => i.id.startsWith(`${s.name}:route:`))
                    .map((i) => i.id.slice(`${s.name}:route:`.length)),
            }));
            this.currentPage.on("framenavigated", (frame) => {
                if (frame !== this.currentPage?.mainFrame())
                    return;
                const url = new URL(frame.url());
                for (const t of tracked) {
                    if (url.host !== t.host)
                        continue;
                    const route = matchRoute(t.routes, url.pathname);
                    if (route)
                        this.touch(`${t.surface}:route:${route}`);
                }
            });
        }
        return this.currentPage;
    }
    /** An element by test id on a UI surface; acting on it or asserting it covers the test id. */
    async byTestId(surfaceName, id) {
        if (!surfaceConfig(surfaceName))
            throw new Error(`unknown surface ${surfaceName}`);
        this.touch(`${surfaceName}:testid:${id}`);
        return (await this.page()).getByTestId(id);
    }
    async closePage() {
        await this.recording?.detach();
        this.capturing?.detach();
        await this.context?.close().catch(() => undefined);
        this.context = undefined;
        this.currentPage = undefined;
    }
}
//# sourceMappingURL=world.js.map