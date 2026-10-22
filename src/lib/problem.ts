export interface Problem {
  /** Path relative to the repository root. */
  file: string;
  /** Dotted path of the offending field inside the file, when there is one. */
  field?: string;
  message: string;
  /** A warning is reported but does not fail flax agents check. */
  severity?: "warning";
}

export function problem(
  file: string,
  message: string,
  field?: string,
): Problem {
  return field === undefined ? { file, message } : { file, field, message };
}

export function warning(
  file: string,
  message: string,
  field?: string,
): Problem {
  return { ...problem(file, message, field), severity: "warning" };
}

export function isError(p: Problem): boolean {
  return p.severity !== "warning";
}

export function formatProblem(p: Problem): string {
  const text =
    p.field === undefined
      ? `${p.file}: ${p.message}`
      : `${p.file}: ${p.field}: ${p.message}`;
  return p.severity === "warning" ? `warning: ${text}` : text;
}

/** The first line of a parser error, without the source excerpt some parsers append. */
export function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split("\n")[0] ?? message).replace(/:$/, "");
}
