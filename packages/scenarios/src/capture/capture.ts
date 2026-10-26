import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import type { CaptureConfig } from "@flax/contract/config";
import { pageTextScript, type PageTextSection } from "@flax/core/page-text";
import type { Media } from "../record/media.ts";
import type { StepInfo } from "../record/steps.ts";

/** The media type of the attachment each capture adds to its scenario; the runner builds the manifest from them. */
export const CAPTURE_MEDIA_TYPE = "application/vnd.flax.capture+json";

/** A capture's name: its file is `<name>.png`. */
export const CAPTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** What `media.capture` takes, beside the name. */
export interface CaptureOptions {
  /** The element to capture, at its own size; the viewport by default. */
  target?: Locator;
  /** The whole scrollable page instead of the viewport. */
  fullPage?: boolean;
  /** A region of the page in CSS pixels instead of the viewport. */
  clip?: { x: number; y: number; width: number; height: number };
  /** A stylesheet applied while the screenshot is taken, to hide something that changes from run to run, say. */
  style?: string;
  /** Elements painted over with a box. */
  mask?: Locator[];
  /** Leaves the mouse where it is; by default it moves to the top left corner so no hover state shows. */
  keepPointer?: boolean;
  /** False leaves the entry's `text` null. */
  text?: boolean;
}

/** One capture as the manifest lists it. */
export interface CaptureEntry {
  name: string;
  /** `<name>.png`, beside the manifest. */
  file: string;
  /** The text the capture shows, by heading (`@flax/core/page-text` formats it); null with `text: false`. */
  text: PageTextSection[] | null;
  scenario: string;
  /** The feature file, as the run reports it. */
  feature: string;
  /** The scenario's line, or its example row's. */
  line: number;
  /** The step that took it: its number among the scenario's own steps (0 in a Background), keyword as written and text. */
  step: { index: number; keyword: string; text: string } | null;
  /** The page's address when it was taken. */
  url: string;
  target: "viewport" | "element" | "page" | "clip";
  /** The element's locator, as Playwright describes it. */
  locator?: string;
  /** In CSS pixels. */
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  /** The PNG's size in pixels. */
  width: number;
  height: number;
  capturedAt: string;
}

/** The captures a scenario's tags ask for: every one (`all`), or only the names in `<tag>:<name>` tags; undefined when the tags select it for none. */
export function wantedCaptures(
  tags: readonly string[],
  tag: string,
): { all: boolean; names: string[] } | undefined {
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
export function rewriteScript(sources: readonly string[]): string {
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
export class SceneCapture implements Media {
  readonly recording = false;
  readonly capturing = true;
  private page: Page | undefined;
  private readonly initScripts: string[] = [];
  private readonly rewrites: string[] = [];
  private readonly byId: Map<string, StepInfo>;
  private current: StepInfo | undefined;
  private readonly taken = new Set<string>();
  private readonly wanted: { all: boolean; names: string[] };

  readonly scenario: { name: string; uri: string; line: number };
  readonly settings: CaptureConfig;
  readonly dir: string;
  private readonly attachEntry: (body: string, mediaType: string) => unknown;

  constructor(options: {
    scenario: { name: string; uri: string; line: number; tags: string[] };
    settings: CaptureConfig;
    dir: string;
    steps: readonly StepInfo[];
    attach: (body: string, mediaType: string) => unknown;
  }) {
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
  contextOptions(): BrowserContextOptions {
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
  async addInitScript(script: string): Promise<void> {
    this.initScripts.push(script);
    if (!this.page) return;
    await this.page.addInitScript(script);
    await this.page.evaluate(script).catch(() => undefined);
  }

  /**
   * Stand-in text for run-specific values: `source` is the source of a page function
   * `(text) => string`, applied to every text node and field of the page just before each capture
   * and undone right after it, so the steps never read the stand-ins.
   */
  addRewrite(source: string): void {
    this.rewrites.push(source);
  }

  async attach(page: Page): Promise<void> {
    this.page = page;
    for (const script of this.initScripts) await page.addInitScript(script);
  }

  detach(): void {
    this.page = undefined;
  }

  stepStarted(id: string): void {
    this.current = this.byId.get(id);
  }

  stepFinished(): void {
    this.current = undefined;
  }

  /** Whether the scenario's tags ask for this capture. */
  wants(name: string): boolean {
    return this.wanted.all || this.wanted.names.includes(name);
  }

  async pointAt(): Promise<void> {}
  async highlight(): Promise<void> {}
  click(target: Locator): Promise<void> {
    return target.click();
  }
  type(target: Locator, text: string): Promise<void> {
    return target.fill(text);
  }
  terminal(): void {}

  /** The text the capture shows: inside the target, the whole page, or the viewport. */
  private async visibleText(
    page: Page,
    options: CaptureOptions,
  ): Promise<PageTextSection[]> {
    const mark = "data-flax-capture";
    const marked =
      options.target ?? (options.fullPage ? page.locator("body") : undefined);
    if (marked) await marked.evaluate((el, a) => el.setAttribute(a, ""), mark);
    try {
      return (await page.evaluate(
        pageTextScript(marked ? `[${mark}]` : null),
      )) as PageTextSection[];
    } finally {
      if (marked)
        await marked
          .evaluate((el, a) => el.removeAttribute(a), mark)
          .catch(() => undefined);
    }
  }

  async capture(name: string, options: CaptureOptions = {}): Promise<void> {
    if (!CAPTURE_NAME.test(name))
      throw new Error(
        `capture "${name}": a name is letters, digits, dots, dashes and underscores, starting with a letter or digit`,
      );
    if (!this.wants(name)) return;
    if (this.taken.has(name))
      throw new Error(`capture ${name} is taken twice in one scenario`);
    const page = this.page;
    if (!page)
      throw new Error(`capture ${name}: the scenario has no page open yet`);
    const kinds = [options.target, options.fullPage, options.clip].filter(
      Boolean,
    ).length;
    if (kinds > 1)
      throw new Error(
        `capture ${name}: give at most one of target, fullPage and clip`,
      );

    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => undefined);
    await page.evaluate("document.fonts.ready");
    if (options.target)
      await options.target.waitFor({ state: "visible", timeout: 15_000 });
    if (!options.keepPointer) await page.mouse.move(0, 0);
    const shot = {
      type: "png",
      animations: "disabled",
      caret: "hide",
      scale: "device",
      ...(options.style ? { style: options.style } : {}),
      ...(options.mask ? { mask: options.mask } : {}),
    } as const;
    const file = `${name}.png`;
    if (this.rewrites.length > 0)
      await page.evaluate(rewriteScript(this.rewrites));
    let png: Buffer;
    let text: PageTextSection[] | null = null;
    try {
      png = options.target
        ? await options.target.screenshot(shot)
        : await page.screenshot({
            ...shot,
            fullPage: options.fullPage ?? false,
            ...(options.clip ? { clip: options.clip } : {}),
          });
      if (options.text !== false) text = await this.visibleText(page, options);
    } finally {
      if (this.rewrites.length > 0)
        await page.evaluate(UNDO_REWRITE).catch(() => undefined);
    }
    await writeFile(join(this.dir, file), png);

    const step = this.current;
    const entry: CaptureEntry = {
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
