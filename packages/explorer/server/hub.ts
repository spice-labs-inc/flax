import type { IncomingMessage, ServerResponse } from "node:http";

/** The open pages' event streams: a snapshot on connect, then every event, and a comment every 25 seconds so idle proxies keep the stream. */
export class Hub {
  readonly #clients = new Set<ServerResponse>();
  readonly #snapshot: () => unknown;
  readonly #max: number;
  readonly #heartbeat: ReturnType<typeof setInterval>;

  constructor(snapshot: () => unknown, heartbeatMs = 25_000, max = 500) {
    this.#snapshot = snapshot;
    this.#max = max;
    this.#heartbeat = setInterval(() => {
      for (const c of this.#clients) c.write(": keep-alive\n\n");
    }, heartbeatMs);
    this.#heartbeat.unref();
  }

  get size(): number {
    return this.#clients.size;
  }

  connect(req: IncomingMessage, res: ServerResponse): void {
    if (this.#clients.size >= this.#max) {
      res.writeHead(503, { "retry-after": "30" }).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    res.write("retry: 5000\n\n");
    res.write(frame("snapshot", this.#snapshot()));
    this.#clients.add(res);
    const drop = () => this.#clients.delete(res);
    req.on("close", drop);
    res.on("error", drop);
  }

  send(event: string, data: unknown): void {
    if (this.#clients.size === 0) return;
    const f = frame(event, data);
    for (const c of this.#clients) c.write(f);
  }

  close(): void {
    clearInterval(this.#heartbeat);
    for (const c of this.#clients) c.end();
    this.#clients.clear();
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
