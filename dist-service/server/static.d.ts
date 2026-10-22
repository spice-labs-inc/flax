import type { IncomingMessage, ServerResponse } from "node:http";
/**
 * The same files a Caddy in front of the service would serve: `/data/*` from the data directory
 * (versioned sets immutable, the manifest never cached) and the built page from the site directory,
 * every other path falling back to its index.html. Handled when `serve` runs the service alone.
 */
export declare function serveStatic(dirs: {
    data: string;
    site?: string | undefined;
}, req: IncomingMessage, res: ServerResponse, pathname: string): boolean;
