/** A SvelteKit route id (`/app/[project_uuid]/report/[[tab]]`) as a regular expression over URL paths. */
export declare function routePattern(routeId: string): RegExp;
/** The route id a URL path lands on: the most specific route whose pattern matches. */
export declare function matchRoute(routeIds: readonly string[], path: string): string | undefined;
