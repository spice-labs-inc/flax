import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cursorPath, settleMs } from "./pace.js";
import { buildTimeline, terminalCast, } from "./timeline.js";
/** The media of a scenario that is not being recorded. */
export const plainMedia = {
    recording: false,
    pointAt: async () => undefined,
    highlight: async () => undefined,
    click: (target) => target.click(),
    type: (target, text) => target.fill(text),
    terminal: () => undefined,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
/** The recording's clock: wall-clock milliseconds, as the browser stamps its frames, read from a monotonic source. */
const now = () => performance.timeOrigin + performance.now();
const firstLine = (s) => s.split("\n")[0] ?? s;
/**
 * Runs in every document of a recorded page: a cursor that follows the mouse events the
 * recording sends (a screencast shows none) and a ripple on each press.
 */
export const cursorScript = (color) => `(() => {
  if (window.top !== window) return;
  const make = () => {
    const root = document.body || document.documentElement;
    if (!root || document.getElementById('__flax_cursor')) return;
    const c = document.createElement('div');
    c.id = '__flax_cursor';
    c.innerHTML = '<svg width="26" height="34" viewBox="0 0 28 36"><path d="M2 2 L2 27 L8.5 21 L13 32 L18 30 L13.5 19.5 L22 19 Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-9999px,-9999px)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.45))' });
    root.appendChild(c);
    const r = document.createElement('div');
    r.id = '__flax_ripple';
    Object.assign(r.style, { position: 'fixed', left: '0', top: '0', width: '36px', height: '36px', borderRadius: '50%', border: '3px solid ${color}', pointerEvents: 'none', zIndex: '2147483646', opacity: '0', transform: 'translate(-9999px,-9999px)' });
    root.appendChild(r);
    if (window.__flaxCursorAt) c.style.transform = 'translate(' + window.__flaxCursorAt.x + 'px,' + window.__flaxCursorAt.y + 'px)';
  };
  window.addEventListener('mousemove', (e) => {
    make();
    window.__flaxCursorAt = { x: e.clientX, y: e.clientY };
    const c = document.getElementById('__flax_cursor');
    if (c) c.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
  }, true);
  window.addEventListener('mousedown', (e) => {
    make();
    const r = document.getElementById('__flax_ripple');
    if (!r) return;
    r.style.transition = 'none';
    r.style.opacity = '0.9';
    r.style.transform = 'translate(' + (e.clientX - 18) + 'px,' + (e.clientY - 18) + 'px) scale(0.3)';
    requestAnimationFrame(() => {
      r.style.transition = 'transform .4s ease-out, opacity .4s ease-out';
      r.style.opacity = '0';
      r.style.transform = 'translate(' + (e.clientX - 18) + 'px,' + (e.clientY - 18) + 'px) scale(1.4)';
    });
  }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', make); else make();
})();`;
const highlightScript = (box, color) => `(() => {
  const h = document.createElement('div');
  h.setAttribute('data-flax-highlight', '');
  Object.assign(h.style, { position: 'fixed', left: '${box.x - 6}px', top: '${box.y - 6}px', width: '${box.width + 12}px', height: '${box.height + 12}px', border: '3px solid ${color}', borderRadius: '8px', boxSizing: 'border-box', pointerEvents: 'none', zIndex: '2147483645', opacity: '0', transition: 'opacity .25s ease' });
  document.body.appendChild(h);
  requestAnimationFrame(() => { h.style.opacity = '1'; });
})()`;
/**
 * One scenario being recorded: the page's screencast (the raw video), the cursor, the pacing,
 * and the events the timeline is built from. The base World and hooks drive it; steps reach it
 * as `world.media`.
 */
export class SceneRecording {
    recording = true;
    out;
    hidden;
    highlighted;
    byId;
    events = [];
    initScripts = [];
    startedAt = now();
    page;
    cdp;
    firstFrameAt;
    filming = false;
    attached = false;
    videoSaved = false;
    cursor;
    current;
    actedLast = false;
    drawn = false;
    failed = false;
    planned;
    options;
    steps;
    log;
    constructor(planned, options, steps, dir, log = (l) => console.error(l)) {
        this.planned = planned;
        this.options = options;
        this.steps = steps;
        this.log = log;
        this.out = join(dir, planned.sidecar.id);
        this.hidden = new Set(planned.sidecar.hide);
        this.highlighted = new Set(planned.sidecar.highlight);
        this.byId = new Map(steps.map((s) => [s.id, s]));
        this.cursor = {
            x: planned.sidecar.viewport.width / 2,
            y: planned.sidecar.viewport.height / 2,
        };
    }
    get viewport() {
        const { width, height } = this.planned.sidecar.viewport;
        return { width, height };
    }
    /** Video pixels per CSS pixel: the sidecar's device scale factor, else the recorder's. */
    get scale() {
        return this.planned.sidecar.viewport.deviceScaleFactor;
    }
    /**
     * A script for every document of the filmed page, added before the page's first load: what a
     * caller changes on screen for the film (stand-in text for run-specific values, say).
     */
    addInitScript(script) {
        this.initScripts.push(script);
    }
    /** Clears what an earlier recording of this id left. */
    async prepare() {
        await rm(this.out, { recursive: true, force: true });
        await mkdir(join(this.out, "screens"), { recursive: true });
    }
    /** Films `page`: the cursor in every document, the screencast into video.webm, navigations as goto actions. */
    async attach(page) {
        if (this.attached) {
            this.log(`${this.planned.sidecar.id}: a second page in one recorded scenario is not filmed; the recording keeps the first`);
            return;
        }
        this.attached = true;
        this.page = page;
        for (const script of [
            ...this.initScripts,
            cursorScript(this.options.highlightColor),
        ]) {
            await page.addInitScript(script);
            await page.evaluate(script).catch(() => undefined);
        }
        const scale = this.scale;
        const size = {
            width: Math.round(this.viewport.width * scale) & ~1,
            height: Math.round(this.viewport.height * scale) & ~1,
        };
        await page.screencast.start({
            path: join(this.out, "video.webm"),
            size,
            onFrame: ({ timestamp }) => {
                this.firstFrameAt ??= timestamp;
            },
        });
        this.filming = true;
        page.on("framenavigated", (frame) => {
            if (frame === page.mainFrame())
                this.action("goto");
        });
        // A new document has no cursor until the mouse moves; move it to where it was.
        page.on("load", () => {
            void page.mouse.move(this.cursor.x, this.cursor.y).catch(() => undefined);
        });
        await page.mouse.move(this.cursor.x, this.cursor.y);
    }
    /** Ends the screencast, which writes video.webm; called before the page's context closes. */
    async detach() {
        const page = this.page;
        if (!page || !this.filming)
            return;
        this.filming = false;
        try {
            await page.screencast.stop();
            this.videoSaved = true;
        }
        catch (e) {
            this.log(`${this.planned.sidecar.id}: the video could not be saved: ${firstLine(e.message)}`);
        }
        await this.cdp?.detach().catch(() => undefined);
        this.cdp = undefined;
        this.page = undefined;
    }
    stepStarted(id) {
        this.current = this.byId.get(id);
        this.actedLast = false;
        this.drawn = false;
        this.events.push({ type: "step-start", step: id, at: now() });
    }
    /** The step's settling pause, its end, and its screen. */
    async stepFinished(id, result) {
        const step = this.byId.get(id);
        const status = stepStatus(result?.status);
        if (status === "failed")
            this.failed = true;
        if (step && this.page && status === "passed")
            await sleep(settleMs({
                kind: step.kind,
                hidden: this.isHidden(step),
                actedLast: this.actedLast,
            }, this.planned.sidecar.pace));
        this.events.push({
            type: "step-end",
            step: id,
            at: now(),
            status,
            ...(status === "failed" && result?.message
                ? { error: firstLine(result.message) }
                : {}),
        });
        const page = this.page;
        if (page && step && !step.background) {
            const file = `screens/${step.index}.png`;
            try {
                await writeFile(join(this.out, file), await this.capture(page));
                this.events.push({ type: "screen", step: id, file });
            }
            catch (e) {
                this.log(`${this.planned.sidecar.id}: no screen for step ${step.index}: ${firstLine(e.message)}`);
            }
        }
        if (page && this.drawn)
            await page
                .evaluate(`document.querySelectorAll('[data-flax-highlight]').forEach((h) => h.remove())`)
                .catch(() => undefined);
        this.current = undefined;
    }
    /** Writes timeline.json, the terminal transcripts and the sidecar copies; returns the timeline. */
    async finish(status) {
        await this.detach();
        const failed = this.failed || stepStatus(status) !== "passed";
        const origin = this.firstFrameAt ?? this.startedAt;
        const { timeline, terminals } = buildTimeline({
            id: this.planned.sidecar.id,
            scenario: this.planned.sidecar.scenario,
            feature: this.planned.uri,
            status: failed ? "failed" : "passed",
            video: this.videoSaved && this.firstFrameAt !== undefined
                ? "video.webm"
                : null,
            viewport: this.viewport,
            scale: this.scale,
            steps: this.steps,
            hidden: this.hidden,
            highlighted: this.highlighted,
            terminal: this.planned.sidecar.terminal,
            events: this.events,
            origin,
            originWallMs: origin,
        });
        if (terminals.length > 0)
            await mkdir(join(this.out, "terminal"), { recursive: true });
        for (const t of terminals) {
            await writeFile(join(this.out, "terminal", `${t.index}.json`), `${JSON.stringify(t, null, 2)}\n`);
            await writeFile(join(this.out, "terminal", `${t.index}.cast`), terminalCast(t, this.planned.sidecar.pace));
        }
        for (const o of this.planned.sidecar.terminal)
            if (!terminals.some((t) => t.index === o.at))
                this.log(`${this.planned.sidecar.id}: the sidecar's terminal override at step ${o.at} has no command; the step reported none through media.terminal`);
        await writeFile(join(this.out, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);
        await writeFile(join(this.out, `${this.planned.sidecar.id}.video.yml`), this.planned.source);
        await writeFile(join(this.out, "sidecar.json"), `${JSON.stringify(this.planned.sidecar, null, 2)}\n`);
        return timeline;
    }
    /** The viewport at the video's pixels: Playwright's own screenshot would be at CSS pixels, the scale being the browser's. */
    async capture(page) {
        this.cdp ??= await page.context().newCDPSession(page);
        const { data } = await this.cdp.send("Page.captureScreenshot", {
            format: "png",
        });
        return Buffer.from(data, "base64");
    }
    isHidden(step) {
        return !step || step.background || this.hidden.has(step.index);
    }
    action(kind, box) {
        if (!this.current)
            return;
        this.events.push({
            type: "action",
            step: this.current.id,
            kind,
            at: now(),
            ...(box ? { box } : {}),
        });
    }
    /** The element's box in CSS pixels, scrolled into view first when it is outside the viewport. */
    async cssBox(target) {
        await target.waitFor({ state: "visible" });
        const inView = await target.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const d = el.ownerDocument.documentElement;
            return r.top >= 0 && r.bottom <= d.clientHeight;
        });
        if (!inView) {
            await target.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
            await sleep(700);
        }
        const b = await target.boundingBox();
        if (!b)
            throw new Error("the element has no box on the page");
        return b;
    }
    async travel(to) {
        const page = this.page;
        if (!page)
            return;
        const path = cursorPath(this.cursor, to);
        const started = performance.now();
        for (const [i, p] of path.entries()) {
            await page.mouse.move(p.x, p.y);
            await sleep(started + (i + 1) * 16 - performance.now());
        }
        this.cursor = to;
    }
    async moveTo(target) {
        const b = await this.cssBox(target);
        await this.travel({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
        return b;
    }
    async pointAt(target) {
        if (this.isHidden(this.current))
            return;
        const b = await this.moveTo(target);
        this.action("point", rounded(b));
        this.actedLast = false;
    }
    async highlight(target) {
        const step = this.current;
        if (!step || this.isHidden(step) || !this.highlighted.has(step.index))
            return;
        const b = await this.moveTo(target);
        await this.page?.evaluate(highlightScript(b, this.options.highlightColor));
        this.drawn = true;
        this.action("highlight", rounded(b));
        this.actedLast = false;
    }
    async click(target) {
        if (this.isHidden(this.current)) {
            this.action("click");
            return target.click();
        }
        const b = await this.moveTo(target);
        await sleep(150);
        this.action("click", rounded(b));
        await target.click();
        this.cursor = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        await sleep(this.planned.sidecar.pace.afterActionMs);
        this.actedLast = true;
    }
    async type(target, text) {
        if (this.isHidden(this.current)) {
            this.action("type");
            return target.fill(text);
        }
        const b = await this.moveTo(target);
        await sleep(150);
        this.action("type", rounded(b));
        await target.click();
        await target.fill("");
        await target.pressSequentially(text, {
            delay: this.planned.sidecar.pace.typeMsPerChar,
        });
        await sleep(this.planned.sidecar.pace.afterActionMs);
        this.actedLast = true;
    }
    terminal(entry) {
        if (!this.current)
            return;
        const end = now();
        const start = end - (entry.durationMs ?? 0);
        this.events.push({
            type: "terminal",
            step: this.current.id,
            command: entry.command,
            ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
            exitCode: entry.exitCode ?? null,
            start,
            end,
            chunks: typeof entry.output === "string"
                ? entry.output === ""
                    ? []
                    : [{ at: end, text: entry.output }]
                : entry.output.map((c) => ({ at: start + c.afterMs, text: c.text })),
        });
    }
}
const rounded = (b) => ({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
});
/** A cucumber status (PASSED, FAILED...) as the timeline writes it. */
export function stepStatus(status) {
    const s = (status ?? "").toLowerCase();
    return s === "passed" ||
        s === "failed" ||
        s === "skipped" ||
        s === "pending" ||
        s === "undefined" ||
        s === "ambiguous"
        ? s
        : "unknown";
}
//# sourceMappingURL=media.js.map