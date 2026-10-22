import type { BrowserContext } from "playwright";
/** The header a service may count as synthetic (never customer use); the name and value come from the config. */
export declare function syntheticClient(): Record<string, string>;
/** The headers every scenario request to our services carries. */
export declare function scenarioHeaders(): Record<string, string>;
/** fetch to one of our services, carrying the scenario headers; the caller's headers win, never over the marker. */
export declare function scenarioFetch(url: string, init?: RequestInit): Promise<Response>;
/**
 * Marks a browser context's requests to our own sites synthetic. A route adds
 * the header rather than extraHTTPHeaders, which would also send it
 * cross-origin and fail third-party CORS preflights.
 */
export declare function markSynthetic(context: BrowserContext, origins: (string | undefined)[]): Promise<void>;
export interface FetchResult {
    url: string;
    /** URL after redirects. */
    finalUrl: string;
    status: number;
    headers: Headers;
    body: string;
}
/** GET with a timeout; never throws on HTTP status, only on network failure. */
export declare function fetchText(url: string, init?: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    redirect?: "follow" | "manual" | "error";
}): Promise<FetchResult>;
export declare function fetchJson<T>(url: string, init?: Parameters<typeof fetchText>[1]): Promise<T>;
