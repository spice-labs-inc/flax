/** Resolves after ms milliseconds. */
export declare const sleep: (ms: number) => Promise<void>;
/** fetch with three tries on network errors (DNS blips, resets), never on HTTP answers. */
export declare function fetchRetry(url: string, init: RequestInit, { fetch: inner, sleep: wait }?: {
    fetch?: typeof fetch | undefined;
    sleep?: typeof sleep | undefined;
}): Promise<Response>;
/**
 * A fetch that repeats a request while the answer is 503, which asks the
 * client to try again, for up to budgetMs. The waits double from 2 s to at
 * most 15 s; the last answer is returned when the next wait would pass the budget.
 */
export declare function patientFetch(budgetMs?: number, sleep?: (ms: number) => Promise<void>, inner?: typeof fetch): typeof fetch;
/**
 * Polls probe every pollMs until it gives a value. Past timeoutMs it throws,
 * naming `what` and the last state the probe reported.
 */
export declare function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<{
    value?: T | undefined;
    state: string;
}>, pollMs?: number): Promise<T>;
