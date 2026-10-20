/** One part of a screenshot's visible text: a heading and the lines under it, in page order. */
export interface ShotSection {
  /** Empty for the text above the first heading. */
  heading: string;
  lines: string[];
}

/** Where public-docs keeps each screenshot's text: outside public/ and outside any content collection, so the site never serves it. */
export const SHOT_TEXT_DIR = "src/data/screenshot-text";

export function shotTextPath(id: string): string {
  return `${SHOT_TEXT_DIR}/${id}.txt`;
}

/** The sidecar file: "## heading" lines, and each line of text indented by two spaces. */
export function formatShotText(sections: readonly ShotSection[]): string {
  const out: string[] = [];
  for (const s of sections) {
    if (s.heading !== "" || out.length > 0) out.push(`## ${s.heading}`);
    for (const line of s.lines) out.push(`  ${line}`);
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

/** The sections of a sidecar file. */
export function parseShotText(text: string): ShotSection[] {
  const sections: ShotSection[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("## "))
      sections.push({ heading: line.slice(3), lines: [] });
    else if (line.startsWith("  ")) {
      if (sections.length === 0) sections.push({ heading: "", lines: [] });
      sections.at(-1)!.lines.push(line.slice(2));
    }
  }
  return sections;
}

/**
 * The page script that reads what a capture shows, as ShotSection[]: every
 * visible text inside the crop element (or the viewport), one line per
 * block, a table row's cells joined by " | ", and a new section at each
 * heading. Text that is hidden, clipped to a pixel, or outside the capture
 * is left out.
 */
export function shotTextScript(crop: string | null): string {
  return `(() => {
  const selector = ${JSON.stringify(crop)};
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return [];
  const view = selector ? root.getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const HEAD = "h1,h2,h3,h4,h5,h6,[role=heading]";
  const squash = (s) => s.replace(/\\s+/g, " ").trim();
  const shown = (node) => {
    const parent = node.parentElement;
    if (!parent || parent.closest("script,style,noscript,template")) return false;
    if (parent.checkVisibility && !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    for (let e = parent; e && e !== root.parentElement; e = e.parentElement) {
      const box = e.getBoundingClientRect();
      if ((box.width <= 1 || box.height <= 1) && getComputedStyle(e).overflow !== "visible") return false;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects())
      if (r.width > 1 && r.height > 1 && r.right > view.left && r.left < view.right && r.bottom > view.top && r.top < view.bottom)
        return true;
    return false;
  };
  const unitOf = (el) => {
    let e = el;
    while (e && e !== root) {
      const d = getComputedStyle(e).display;
      if (!d.startsWith("inline") && d !== "contents" && d !== "table-cell") break;
      e = e.parentElement;
    }
    return e || root;
  };
  const sections = [{ heading: "", lines: [] }];
  const headings = new Set();
  let unit = null;
  let cell = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = squash(n.nodeValue || "");
    if (!text || !shown(n)) continue;
    const head = n.parentElement.closest(HEAD);
    if (head) {
      if (!headings.has(head)) {
        headings.add(head);
        sections.push({ heading: squash(head.textContent || ""), lines: [] });
      }
      unit = head;
      continue;
    }
    const u = unitOf(n.parentElement);
    const c = n.parentElement.closest("td,th");
    const lines = sections[sections.length - 1].lines;
    if (u === unit && lines.length > 0)
      lines[lines.length - 1] += (c && c !== cell ? " | " : " ") + text;
    else lines.push(text);
    unit = u;
    cell = c;
  }
  return sections.filter((s) => s.heading !== "" || s.lines.length > 0);
})()`;
}
