import { chromium } from "playwright";

const MAX_WIDTH = 1200;

/**
 * Screenshots re-encoded as WebP no wider than 1200 pixels, by drawing them on a canvas in headless Chromium,
 * the browser the scenarios already use. Without a browser they stay as they were.
 */
export async function shrink<T extends { mediaType: string; base64: string }>(
  shots: T[],
): Promise<{ shots: T[]; shrunk: boolean }> {
  if (shots.length === 0) return { shots, shrunk: false };
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.error(
      `screenshots kept at full size: no headless browser (${(e as Error).message.split("\n")[0]})`,
    );
    return { shots, shrunk: false };
  }
  try {
    const page = await browser.newPage();
    const out: T[] = [];
    for (const s of shots) {
      const src = JSON.stringify(`data:${s.mediaType};base64,${s.base64}`);
      // A string, so the page code needs no DOM types in this Node project.
      const webp: unknown = await page.evaluate(`(async () => {
        const img = new Image();
        img.src = ${src};
        await img.decode();
        const scale = Math.min(1, ${MAX_WIDTH} / img.naturalWidth);
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        const ctx = c.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL("image/webp", 0.82);
      })()`);
      if (typeof webp !== "string") {
        out.push(s);
        continue;
      }
      const base64 = webp.slice(webp.indexOf(",") + 1);
      out.push(
        webp.startsWith("data:image/webp") && base64.length < s.base64.length
          ? { ...s, mediaType: "image/webp", base64 }
          : s,
      );
    }
    return { shots: out, shrunk: true };
  } finally {
    await browser.close();
  }
}
