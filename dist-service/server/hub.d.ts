import type { IncomingMessage, ServerResponse } from "node:http";
/** The open pages' event streams: a snapshot on connect, then every event, and a comment every 25 seconds so idle proxies keep the stream. */
export declare class Hub {
    #private;
    constructor(snapshot: () => unknown, heartbeatMs?: number, max?: number);
    get size(): number;
    connect(req: IncomingMessage, res: ServerResponse): void;
    send(event: string, data: unknown): void;
    close(): void;
}
