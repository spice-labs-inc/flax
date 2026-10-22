/**
 * The named files of a zip archive (a workflow artifact), by name. Only stored and deflated entries
 * of the archive's top level are read; anything else, folders and paths with a slash included, is left out.
 */
export declare function unzip(zip: Buffer, wanted: ReadonlySet<string>, maxBytes: number): Map<string, Buffer>;
