import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pageTextScript } from "@flax/core/page-text";
/** The media type of the attachment each capture adds to its scenario; the runner builds the manifest from them. */
export const CAPTURE_MEDIA_TYPE = "application/vnd.flax.capture+json";
/** A capture's name: its file is `<name>.png`. */
export const CAPTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** The captures a scenario's tags ask for: every one (`all`), or only the names in `<tag>:<name>` tags; undefined when the tags select it for none. */
export function wantedCaptures(tags, tag) {
    const names = tags
        .filter((t) => t.startsWith(`${tag}:`))
        .map((t) => t.slice(tag.length + 1));
    const all = tags.includes(tag);
    return all || names.length > 0 ? { all, names } : undefined;
}
/**
 * The page script that applies the rewrites, in order, to every text node and every field's
 * value (passwords left alone), and keeps what each said for UNDO_REWRITE.
 */
export function rewriteScript(sources) {
    return `(() => {
  const rewrites = [${sources.join(", ")}];
  const rewrite = (text) => rewrites.reduce((t, f) => f(t), text);
  const undo = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement && n.parentElement.closest("script,style,noscript,template")) continue;
    const before = n.nodeValue || "";
    const after = rewrite(before);
    if (after === before) continue;
    n.nodeValue = after;
    undo.push(() => { if (n.nodeValue === after) n.nodeValue = before; });
  }
  for (const el of document.querySelectorAll("input,textarea")) {
    if (el.type === "password") continue;
    const before = el.value;
    const after = rewrite(before);
    if (after === before) continue;
    el.value = after;
    undo.push(() => { if (el.value === after) el.value = before; });
  }
  window.__flaxUndoRewrite = () => { for (const u of undo.reverse()) u(); };
})()`;
}
/** Puts back what the last rewriteScript changed. */
export const UNDO_REWRITE = `(() => { const u = window.__flaxUndoRewrite; delete window.__flaxUndoRewrite; if (u) u(); })()`;
/**
 * One scenario of a capture run: the page it is shot in, the scripts run in its documents, and
 * the screenshots its steps ask for through `media.capture`. Clicks and typing are plain.
 */
export class SceneCapture {
    recording = false;
    capturing = true;
    page;
    initScripts = [];
    rewrites = [];
    byId;
    current;
    taken = new Set();
    wanted;
    scenario;
    settings;
    dir;
    attachEntry;
    constructor(options) {
        const { name, uri, line, tags } = options.scenario;
        this.scenario = { name, uri, line };
        this.settings = options.settings;
        this.dir = options.dir;
        this.byId = new Map(options.steps.map((s) => [s.id, s]));
        this.wanted = wantedCaptures(tags, options.settings.tag) ?? {
            all: false,
            names: [],
        };
        this.attachEntry = options.attach;
    }
    /** The browser context the scenario's page is opened in: the capture viewport, scale, color scheme, locale and time zone, with motion reduced. */
    contextOptions() {
        const s = this.settings;
        return {
            viewport: { ...s.viewport },
            deviceScaleFactor: s.scale,
            colorScheme: s.colorScheme,
            reducedMotion: "reduce",
            locale: s.locale,
            ...(s.timezone ? { timezoneId: s.timezone } : {}),
        };
    }
    /**
     * A script for every document of the scenario's page. Before the page opens it is added ahead
     * of the first load; after, it also runs in the document already open. It runs while the
     * scenario checks the page, so it must not change what the steps read; stand-in text belongs in
     * addRewrite.
     */
    async addInitScript(script) {
        this.initScripts.push(script);
        if (!this.page)
            return;
        await this.page.addInitScript(script);
        await this.page.evaluate(script).catch(() => undefined);
    }
    /**
     * Stand-in text for run-specific values: `source` is the source of a page function
     * `(text) => string`, applied to every text node and field of the page just before each capture
     * and undone right after it, so the steps never read the stand-ins.
     */
    addRewrite(source) {
        this.rewrites.push(source);
    }
    async attach(page) {
        this.page = page;
        for (const script of this.initScripts)
            await page.addInitScript(script);
    }
    detach() {
        this.page = undefined;
    }
    stepStarted(id) {
        this.current = this.byId.get(id);
    }
    stepFinished() {
        this.current = undefined;
    }
    /** Whether the scenario's tags ask for this capture. */
    wants(name) {
        return this.wanted.all || this.wanted.names.includes(name);
    }
    async pointAt() { }
    async highlight() { }
    click(target) {
        return target.click();
    }
    type(target, text) {
        return target.fill(text);
    }
    terminal() { }
    /** The text the capture shows: inside the target, the whole page, or the viewport. */
    async visibleText(page, options) {
        const mark = "data-flax-capture";
        const marked = options.target ?? (options.fullPage ? page.locator("body") : undefined);
        if (marked)
            await marked.evaluate((el, a) => el.setAttribute(a, ""), mark);
        try {
            return (await page.evaluate(pageTextScript(marked ? `[${mark}]` : null)));
        }
        finally {
            if (marked)
                await marked
                    .evaluate((el, a) => el.removeAttribute(a), mark)
                    .catch(() => undefined);
        }
    }
    async capture(name, options = {}) {
        if (!CAPTURE_NAME.test(name))
            throw new Error(`capture "${name}": a name is letters, digits, dots, dashes and underscores, starting with a letter or digit`);
        if (!this.wants(name))
            return;
        if (this.taken.has(name))
            throw new Error(`capture ${name} is taken twice in one scenario`);
        const page = this.page;
        if (!page)
            throw new Error(`capture ${name}: the scenario has no page open yet`);
        const kinds = [options.target, options.fullPage, options.clip].filter(Boolean).length;
        if (kinds > 1)
            throw new Error(`capture ${name}: give at most one of target, fullPage and clip`);
        await page
            .waitForLoadState("networkidle", { timeout: 30_000 })
            .catch(() => undefined);
        await page.evaluate("document.fonts.ready");
        if (options.target)
            await options.target.waitFor({ state: "visible", timeout: 15_000 });
        if (!options.keepPointer)
            await page.mouse.move(0, 0);
        const shot = {
            type: "png",
            animations: "disabled",
            caret: "hide",
            scale: "device",
            ...(options.style ? { style: options.style } : {}),
            ...(options.mask ? { mask: options.mask } : {}),
        };
        const file = `${name}.png`;
        if (this.rewrites.length > 0)
            await page.evaluate(rewriteScript(this.rewrites));
        let png;
        let text = null;
        try {
            png = options.target
                ? await options.target.screenshot(shot)
                : await page.screenshot({
                    ...shot,
                    fullPage: options.fullPage ?? false,
                    ...(options.clip ? { clip: options.clip } : {}),
                });
            if (options.text !== false)
                text = await this.visibleText(page, options);
        }
        finally {
            if (this.rewrites.length > 0)
                await page.evaluate(UNDO_REWRITE).catch(() => undefined);
        }
        await writeFile(join(this.dir, file), png);
        const step = this.current;
        const entry = {
            name,
            file,
            text,
            scenario: this.scenario.name,
            feature: this.scenario.uri,
            line: this.scenario.line,
            step: step
                ? { index: step.index, keyword: step.keyword, text: step.text }
                : null,
            url: page.url(),
            target: options.target
                ? "element"
                : options.fullPage
                    ? "page"
                    : options.clip
                        ? "clip"
                        : "viewport",
            ...(options.target ? { locator: String(options.target) } : {}),
            viewport: page.viewportSize() ?? { ...this.settings.viewport },
            deviceScaleFactor: this.settings.scale,
            width: png.readUInt32BE(16),
            height: png.readUInt32BE(20),
            capturedAt: new Date().toISOString(),
        };
        this.taken.add(name);
        await this.attachEntry(JSON.stringify(entry), CAPTURE_MEDIA_TYPE);
    }
}
//# sourceMappingURL=capture.js.map