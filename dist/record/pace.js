export const DEFAULT_PACE = {
    typeMsPerChar: 60,
    afterActionMs: 600,
    readMs: 1200,
};
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
/** The defaults with each key the override sets. */
export function mergePace(defaults, override) {
    return { ...defaults, ...override };
}
/** How long typing `text` takes. */
export function typingMs(text, pace) {
    return [...text].length * pace.typeMsPerChar;
}
/** Cursor travel time: 350 to 800 ms by distance, none for a move under a pixel. */
export function travelMs(from, to) {
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    if (d < 1)
        return 0;
    return Math.round(Math.min(800, Math.max(350, d * 0.9)));
}
export const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
/** The points an eased cursor move passes through, one per frame, ending exactly at `to`. */
export function cursorPath(from, to, frameMs = 16) {
    const ms = travelMs(from, to);
    if (ms === 0)
        return [];
    const n = Math.max(1, Math.ceil(ms / frameMs));
    return Array.from({ length: n }, (_, i) => {
        const k = easeInOut((i + 1) / n);
        return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
    });
}
/**
 * The pause that ends a step: a check (Then) is held for reading, any other step for the
 * after-action pause unless its last media action already paused; a hidden step is never paced.
 */
export function settleMs(step, pace) {
    if (step.hidden)
        return 0;
    if (step.kind === "outcome")
        return pace.readMs;
    return step.actedLast ? 0 : pace.afterActionMs;
}
//# sourceMappingURL=pace.js.map