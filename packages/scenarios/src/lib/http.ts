import type { BrowserContext } from "playwright";
import { config } from "../config.ts";

/** The header a service may count as synthetic (never customer use); the name and value come from the config. */
export function syntheticClient(): Record<string, string> {
  const { syntheticHeader, syntheticValue } = config().http;
  return { [syntheticHeader]: syntheticValue };
}

/** The headers every scenario request to our services carries. */
export function scenarioHeaders(): Record<string, string> {
  return { "user-agent": config().http.userAgent, ...syntheticClient() };
}

/** fetch to one of our services, carrying the scenario headers; the caller's headers win, never over the marker. */
export function scenarioFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(scenarioHeaders());
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  for (const [name, value] of Object.entries(syntheticClient()))
    headers.set(name, value);
  return fetch(url, { ...init, headers });
}

/**
 * The hosts of the origins that are URLs. A hosts table may carry other
 * strings beside its URLs (an environment id, a label); those are not sites.
 */
export function urlHosts(origins: (string | undefined)[]): Set<string> {
  const hosts = new Set<string>();
  for (const o of origins) {
    if (o === undefined || !URL.canParse(o)) continue;
    const url = new URL(o);
    if (url.protocol === "http:" || url.protocol === "https:")
      hosts.add(url.host);
  }
  return hosts;
}

/**
 * Marks a browser context's requests to our own sites synthetic. A route adds
 * the header rather than extraHTTPHeaders, which would also send it
 * cross-origin and fail third-party CORS preflights.
 */
export async function markSynthetic(
  context: BrowserContext,
  origins: (string | undefined)[],
): Promise<void> {
  const ours = urlHosts(origins);
  await context.route(
    (url) => ours.has(url.host),
    (route) =>
      route.fallback({
        headers: { ...route.request().headers(), ...syntheticClient() },
      }),
  );
}

export interface FetchResult {
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  status: number;
  headers: Headers;
  body: string;
}

/** GET with a timeout; never throws on HTTP status, only on network failure. */
export async function fetchText(
  url: string,
  init: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    redirect?: "follow" | "manual" | "error";
  } = {},
): Promise<FetchResult> {
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

export async function fetchJson<T>(
  url: string,
  init: Parameters<typeof fetchText>[1] = {},
): Promise<T> {
  const res = await fetchText(url, {
    ...init,
    headers: { accept: "application/json", ...init.headers },
  });
  if (res.status !== 200) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return JSON.parse(res.body) as T;
}
