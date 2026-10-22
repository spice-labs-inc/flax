/**
 * The single-file page: the hash-router build with every data file inside it, as dist/index.html, and the same page
 * as a fragment (title, head tags, body) for publishing as an Artifact, as dist/artifact.html.
 */
export declare function writeSingleFile(options: {
    built: string;
    dataDir: string;
    outDir: string;
    builtAt: string;
}): {
    page: number;
    fragment: number;
};
