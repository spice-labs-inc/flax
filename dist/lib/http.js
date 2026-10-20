import { config } from "../config.js";
/** The header a service may count as synthetic (never customer use); the name and value come from the config. */
export function syntheticClient() {
    const { syntheticHeader, syntheticValue } = config().http;
    return { [syntheticHeader]: syntheticValue };
}
/** The headers every scenario request to our services carries. */
export function scenarioHeaders() {
    return { "user-agent": config().http.userAgent, ...syntheticClient() };
}
/** fetch to one of our services, carrying the scenario headers; the caller's headers win, never over the marker. */
export function scenarioFetch(url, init = {}) {
    const headers = new Headers(scenarioHeaders());
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    for (const [name, value] of Object.entries(syntheticClient()))
        headers.set(name, value);
    return fetch(url, { ...init, headers });
}
/**
 * Marks a browser context's requests to our own sites synthetic. A route adds
 * the header rather than extraHTTPHeaders, which would also send it
 * cross-origin and fail third-party CORS preflights.
 */
export async function markSynthetic(context, origins) {
    const ours = new Set(origins.filter((o) => o !== undefined).map((o) => new URL(o).host));
    await context.route((url) => ours.has(url.host), (route) => route.fallback({
        headers: { ...route.request().headers(), ...syntheticClient() },
    }));
}
/** GET with a timeout; never throws on HTTP status, only on network failure. */
export async function fetchText(url, init = {}) {
    const res = await fetch(url, {
        headers: { ...scenarioHeaders(), ...init.headers },
        redirect: init.redirect ?? "follow",
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
    return {
        url,
        finalUrl: res.url || url,
        status: res.status,
        headers: res.headers,
        body: await res.text(),
    };
}
export async function fetchJson(url, init = {}) {
    const res = await fetchText(url, {
        ...init,
        headers: { accept: "application/json", ...init.headers },
    });
    if (res.status !== 200)
        throw new Error(`GET ${url}: HTTP ${res.status}`);
    return JSON.parse(res.body);
}
//# sourceMappingURL=http.js.map