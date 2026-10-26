/** Calls in flight at once; a gateway key over its parallel limit answers HTTP 429. */
export declare const MODEL_CALLS_AT_ONCE: () => number;
/** Per call; keep within the socket's cap. */
export declare const MAX_TOKENS: () => number;
/** The answer's text and why the model stopped ("max_tokens" when it ran out). */
export interface Answer {
    text: string;
    stopReason?: string;
}
export type Ask = (prompt: string) => Promise<Answer>;
/** POST /v1/messages on the socket; the runner picks the model, so `model` is only passed along. */
export declare function viaSocket(socketPath: string, model: string): Ask;
/** Waits out the gateway's 429 (too many requests on this key) instead of spending an extraction attempt on it. */
export declare function patient(ask: Ask): Ask;
