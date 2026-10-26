import type { PageTextSection } from "@flax/core/page-text";

export {
  formatPageText as formatShotText,
  pageTextScript as shotTextScript,
  parsePageText as parseShotText,
} from "@flax/core/page-text";

/** One part of a screenshot's visible text: a heading and the lines under it, in page order. */
export type ShotSection = PageTextSection;

/** Where public-docs keeps each screenshot's text: outside public/ and outside any content collection, so the site never serves it. */
export const SHOT_TEXT_DIR = "src/data/screenshot-text";

export function shotTextPath(id: string): string {
  return `${SHOT_TEXT_DIR}/${id}.txt`;
}
