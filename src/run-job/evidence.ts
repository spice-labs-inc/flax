/**
 * A quote of a tool result in the answer: any object with a string `tool`
 * and a string `quote`, wherever it sits in the answer.
 */
export interface Citation {
  /** Where in the answer, such as answers.pods. */
  path: string;
  tool: string;
  quote: string;
  found: boolean;
  /** Why it was not found. */
  reason?: string;
}

export type CitationCheck =
  | { status: "skipped"; reason: string }
  | { status: "checked"; citations: Citation[] };

export interface ToolResultText {
  tool: string;
  text: string;
}

/** Shorter quotes would match almost any result, so they prove nothing. */
export const MIN_QUOTE_CHARS = 6;
const MAX_DEPTH = 20;

/** Every citation in the answer, in document order. */
export function findCitations(
  value: unknown,
  path = "",
  depth = 0,
): Omit<Citation, "found" | "reason">[] {
  if (depth > MAX_DEPTH || typeof value !== "object" || value === null)
    return [];
  if (Array.isArray(value))
    return value.flatMap((item, i) =>
      findCitations(item, `${path}[${i}]`, depth + 1),
    );
  const record = value as Record<string, unknown>;
  if (typeof record.tool === "string" && typeof record.quote === "string")
    return [
      { path: path || "(answer)", tool: record.tool, quote: record.quote },
    ];
  return Object.entries(record).flatMap(([key, item]) =>
    findCitations(item, path === "" ? key : `${path}.${key}`, depth + 1),
  );
}

function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) stringLeaves(item, out);
  return out;
}

/**
 * A result as the model could quote it: as it is, and for a JSON result
 * also its string values unescaped, since a quote of a message or a log
 * line inside JSON rarely keeps the escapes.
 */
function readings(text: string): string[] {
  const out = [squash(text)];
  try {
    out.push(squash(stringLeaves(JSON.parse(text)).join("\n")));
  } catch {
    // Not JSON; the text as it is is the only reading.
  }
  return out;
}

/**
 * Checks each citation against the text the tools server gave the model:
 * the tool must be one the job lists, and the quote, ignoring whitespace,
 * must appear in a result that tool returned in this run.
 */
export function checkCitations(
  answer: unknown,
  results: readonly ToolResultText[],
  jobTools: readonly string[],
): Citation[] {
  const byTool = readingsByTool(results);
  return findCitations(answer).map((c) => {
    const reason = quoteMiss(c.tool, c.quote, jobTools, byTool);
    return reason === undefined
      ? { ...c, found: true }
      : { ...c, found: false, reason };
  });
}

function readingsByTool(
  results: readonly ToolResultText[],
): Map<string, string[]> {
  const byTool = new Map<string, string[]>();
  for (const r of results)
    byTool.set(r.tool, [...(byTool.get(r.tool) ?? []), ...readings(r.text)]);
  return byTool;
}

function quoteMiss(
  tool: string,
  text: string,
  jobTools: readonly string[],
  byTool: ReadonlyMap<string, string[]> | undefined,
): string | undefined {
  if (!jobTools.includes(tool)) return `${tool} is not one of the job's tools`;
  const quote = squash(text);
  if (quote.length < MIN_QUOTE_CHARS)
    return `the quote is shorter than ${MIN_QUOTE_CHARS} characters besides spaces`;
  if (byTool === undefined) return undefined;
  const texts = byTool.get(tool);
  if (texts === undefined)
    return `no call to ${tool} returned a result in this run`;
  if (!texts.some((t) => t.includes(quote)))
    return `the quote is not in any result ${tool} returned`;
  return undefined;
}

/**
 * Why one quote of a tool result is not in what that tool returned, by the
 * same rules as checkCitations; undefined when it is. Without results
 * (a stub run) only the tool and the quote's length are checked.
 */
export function quoteProblem(
  tool: string,
  quote: string,
  jobTools: readonly string[],
  results: readonly ToolResultText[] | undefined,
): string | undefined {
  return quoteMiss(
    tool,
    quote,
    jobTools,
    results === undefined ? undefined : readingsByTool(results),
  );
}
