/**
 * Screenshots re-encoded as WebP no wider than 1200 pixels, by drawing them on a canvas in headless Chromium,
 * the browser the scenarios already use. Without a browser they stay as they were.
 */
export declare function shrink<T extends {
    mediaType: string;
    base64: string;
}>(shots: T[]): Promise<{
    shots: T[];
    shrunk: boolean;
}>;
