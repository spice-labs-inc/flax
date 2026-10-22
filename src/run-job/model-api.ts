import type { IncomingMessage } from "node:http";

/** What the model forwarder sends the box's calls to: the model gateway. */
export interface ModelUpstream {
  /** Named in the error the box gets when it cannot be reached. */
  readonly label: string;
  /** A request with exactly the headers given, answered as a stream. */
  open(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    timeoutMs: number,
  ): Promise<IncomingMessage>;
}
