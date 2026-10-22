import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Browser, Page } from "playwright";
import { calloutPlacement, type Size } from "./production.ts";
import type { Box, CardContent } from "./recording.ts";

// Pictures the renderer draws with Chromium: HTML cards, callouts and the
// caption band. They take their look from the caller's CSS (font faces and
// the custom properties below); flax ships no fonts or colors of its own.

/**
 * The custom properties painted pictures read, with neutral defaults a
 * caller's `css` overrides on :root.
 */
export const PAINT_DEFAULTS = `:root{--media-font:system-ui,sans-serif;--media-text:#ffffff;
  --media-band:#000000;--media-accent:#ffffff;--media-accent-text:#000000;--media-dim:rgba(0,0,0,.4)}`;

const LAYOUT_SCALE = 2;

/** Text safe inside HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Draws HTML into PNGs with one Chromium for the whole render. */
export class Painter {
  #browser: Promise<Browser> | undefined;

  /** A new page drawing at `size` device pixels, laid out at half that; the caller closes it. */
  async page(size: Size): Promise<Page> {
    this.#browser ??= import("playwright").then((p) => p.chromium.launch());
    const browser = await this.#browser;
    return browser.newPage({
      viewport: {
        width: Math.round(size.width / LAYOUT_SCALE),
        height: Math.round(size.height / LAYOUT_SCALE),
      },
      deviceScaleFactor: LAYOUT_SCALE,
    });
  }

  /** Draws `html` at `size` device pixels into `file`; transparent where the page is. */
  async paint(html: string, size: Size, file: string): Promise<string> {
    const page = await this.page(size);
    try {
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate("document.fonts.ready");
      await mkdir(dirname(file), { recursive: true });
      await page.screenshot({
        path: file,
        type: "png",
        scale: "device",
        omitBackground: true,
      });
    } finally {
      await page.close();
    }
    return file;
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser) await (await browser).close();
  }
}

const page = (css: string, style: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${PAINT_DEFAULTS}${css}
  html,body{margin:0;overflow:hidden;background:transparent}${style}</style></head><body>${body}</body></html>`;

/** One caption cue in the band: centered lines on the band's color. */
export function captionHtml(
  lines: readonly string[],
  band: Size,
  css = "",
): string {
  const w = band.width / LAYOUT_SCALE;
  const h = band.height / LAYOUT_SCALE;
  return page(
    css,
    `body{width:${w}px;height:${h}px;background:var(--media-band)}
    div{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;
      font-family:var(--media-font);font-weight:500;font-size:${Math.round(h * 0.34)}px;line-height:1.2;color:var(--media-text);padding:0 120px}`,
    `<div>${lines.map(escapeHtml).join("<br>")}</div>`,
  );
}

/**
 * A callout over the whole picture: the rest dimmed, the target ringed in the
 * accent color and a label pointing at it. The box is in picture pixels.
 */
export function calloutHtml(
  box: Box,
  text: string,
  picture: Size,
  css = "",
): string {
  const s = 1 / LAYOUT_SCALE;
  const pad = 10;
  const b = {
    x: box.x * s - pad,
    y: box.y * s - pad,
    w: box.width * s + 2 * pad,
    h: box.height * s + 2 * pad,
  };
  const W = picture.width * s;
  const H = picture.height * s;
  const below = calloutPlacement(box, picture) === "below";
  const cx = b.x + b.w / 2;
  const place = below ? `top:${b.y + b.h + 30}px` : `bottom:${H - b.y + 30}px`;
  return page(
    css,
    `body{width:${W}px;height:${H}px;font-family:var(--media-font)}
    .spot{position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border-radius:12px;box-sizing:border-box;
      border:4px solid var(--media-accent);box-shadow:0 0 0 4000px var(--media-dim)}
    .label{position:absolute;${place};left:${cx}px;transform:translateX(-50%);max-width:${Math.round(W * 0.5)}px;width:max-content;
      font-size:30px;font-weight:600;line-height:1.2;text-align:center;color:var(--media-accent-text);background:var(--media-accent);
      padding:14px 24px;border-radius:12px}`,
    `<div class="spot"></div><div class="label" id="label">${escapeHtml(text)}</div>
    <script>
      const el = document.getElementById("label");
      const l = el.getBoundingClientRect();
      if (l.left < 24) el.style.transform = "translateX(calc(-50% + " + (24 - l.left) + "px))";
      if (l.right > ${W - 24}) el.style.transform = "translateX(calc(-50% - " + (l.right - ${W - 24}) + "px))";
    </script>`,
  );
}

/**
 * A plain card for an intro or outro: the heading, the line under it and the
 * items as a numbered list, in the caller's font and colors (--media-band is
 * the background, --media-accent the numbers). A caller that wants its own
 * look passes `assets.cardHtml`.
 */
export function cardHtml(card: CardContent, frame: Size, css = ""): string {
  const w = frame.width / LAYOUT_SCALE;
  const h = frame.height / LAYOUT_SCALE;
  const items = (card.items ?? []).map((i) =>
    typeof i === "string" ? i : i.label,
  );
  return page(
    css,
    `body{width:${w}px;height:${h}px;background:var(--media-band);color:var(--media-text);font-family:var(--media-font)}
    main{position:absolute;left:96px;right:96px;top:50%;transform:translateY(-50%)}
    h1{font-size:${items.length > 0 ? 64 : 76}px;line-height:1.08;margin:0;font-weight:600;text-wrap:balance}
    p{font-size:30px;margin:18px 0 0;opacity:.85}
    ol{list-style:none;margin:44px 0 0;padding:0}
    li{display:flex;align-items:center;gap:20px;font-size:30px;margin:0 0 18px}
    li b{flex:none;width:44px;height:44px;border-radius:50%;background:var(--media-accent);color:var(--media-accent-text);
      display:flex;align-items:center;justify-content:center;font-size:22px}`,
    `<main><h1>${escapeHtml(card.heading)}</h1>${card.sub ? `<p>${escapeHtml(card.sub)}</p>` : ""}${
      items.length > 0
        ? `<ol>${items.map((t, i) => `<li><b>${i + 1}</b>${escapeHtml(t)}</li>`).join("")}</ol>`
        : ""
    }</main>`,
  );
}

/**
 * A plain poster: the screen filling the frame, darkened toward the bottom,
 * with the kicker and the title over it. `screen` is a data: URL.
 */
export function posterHtml(
  o: { screen: string; title: string; kicker?: string },
  frame: Size,
  css = "",
): string {
  const w = frame.width / LAYOUT_SCALE;
  const h = frame.height / LAYOUT_SCALE;
  return page(
    css,
    `body{width:${w}px;height:${h}px;background:var(--media-band);font-family:var(--media-font)}
    img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
    .shade{position:absolute;inset:0;background:linear-gradient(transparent 35%,rgba(0,0,0,.8))}
    main{position:absolute;left:72px;right:72px;bottom:64px;color:var(--media-text)}
    .kicker{display:inline-block;font-size:26px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;
      color:var(--media-accent-text);background:var(--media-accent);padding:8px 16px;border-radius:8px;margin-bottom:18px}
    h1{font-size:84px;line-height:1.05;margin:0;font-weight:700;text-wrap:balance}`,
    `<img src="${o.screen}"><div class="shade"></div><main>${
      o.kicker ? `<div class="kicker">${escapeHtml(o.kicker)}</div>` : ""
    }<h1>${escapeHtml(o.title)}</h1></main>`,
  );
}
