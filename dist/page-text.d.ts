/** One part of a page's visible text: a heading and the lines under it, in page order. */
export interface PageTextSection {
    /** Empty for the text above the first heading. */
    heading: string;
    lines: string[];
}
/** The text form: "## heading" lines, and each line of text indented by two spaces. */
export declare function formatPageText(sections: readonly PageTextSection[]): string;
/** The sections of a text written by formatPageText. */
export declare function parsePageText(text: string): PageTextSection[];
/**
 * The page script that reads what a capture shows, as PageTextSection[]:
 * every visible text inside the element `selector` names (or the viewport),
 * one line per block, a table row's cells joined by " | ", and a new section
 * at each heading. Text that is hidden, clipped to a pixel, or outside the
 * capture is left out.
 */
export declare function pageTextScript(selector: string | null): string;
