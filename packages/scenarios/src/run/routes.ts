/** A SvelteKit route id (`/app/[project_uuid]/report/[[tab]]`) as a regular expression over URL paths. */
export function routePattern(routeId: string): RegExp {
  const parts = routeId.split("/").filter(Boolean);
  let source = "";
  for (const part of parts) {
    if (/^\[\[[^\]]+\]\]$/.test(part)) source += "(?:/[^/]+)?";
    else if (/^\[\.\.\.[^\]]+\]$/.test(part)) source += "(?:/.*)?";
    else
      source +=
        "/" +
        part
          .split(/(\[[^\]]+\])/)
          .map((p) =>
            p.startsWith("[") ? "[^/]+" : p.replace(/[.*+?^${}()|\\]/g, "\\$&"),
          )
          .join("");
  }
  return new RegExp(`^${source || "/"}/?$`);
}

function specificity(routeId: string): number[] {
  const parts = routeId.split("/").filter(Boolean);
  return [
    parts.filter((p) => !p.includes("[")).length,
    parts.filter((p) => p.includes("[") && !/^\[[^\]]*\]+$/.test(p)).length,
    -parts.filter((p) => p.startsWith("[...")).length,
    parts.length,
  ];
}

/** The route id a URL path lands on: the most specific route whose pattern matches. */
export function matchRoute(
  routeIds: readonly string[],
  path: string,
): string | undefined {
  const hits = routeIds.filter((id) => routePattern(id).test(path));
  hits.sort((a, b) => {
    const x = specificity(a);
    const y = specificity(b);
    for (let i = 0; i < x.length; i++)
      if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0);
    return a.localeCompare(b);
  });
  return hits[0];
}
