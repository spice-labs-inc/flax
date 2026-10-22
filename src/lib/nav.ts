export { format, parse, type Lens, type Route } from "./location.ts";
import type { Route } from "./location.ts";

/** The path and query a page URL names: its own path, or the part after the # in the single-file page. */
export function locationOf(url: URL): string {
  if (__EXPLORER_SINGLE_FILE__) return url.hash.replace(/^#/, "") || "/";
  return url.pathname + url.search;
}

/** What a link's href says for a location: the path itself, or the path after a # in the single-file page. */
export function hrefOf(location: string): string {
  return __EXPLORER_SINGLE_FILE__ ? `#${location}` : location;
}

/** The full address of a location, for pasting into a deck or a message. */
export function absoluteOf(location: string): string {
  if (__EXPLORER_SINGLE_FILE__)
    return `${window.location.href.split("#")[0]}#${location}`;
  return `${window.location.origin}${location}`;
}

/** A plain click on an in-page link navigates inside the page; modified clicks keep the browser's own behavior. */
export function inPage(e: MouseEvent): boolean {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
    return false;
  e.preventDefault();
  return true;
}

/** Copies text; when the frame forbids the clipboard, the caller shows the text to copy by hand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A place to go: whatever it leaves out (env, timeline point, lens) stays as it is now. */
export type Dest = Partial<Route>;

/** Where a scenario was opened from, so closing it puts focus back: an element by its data-return key, or a search. */
export type Opener =
  { focus: string } | { palette: { query: string; selected: number } };

/** In-page navigation the explorer hands to its panels. */
export interface Nav {
  href(d: Dest): string;
  url(d: Dest): string;
  go(d: Dest, from?: Opener): void;
}
