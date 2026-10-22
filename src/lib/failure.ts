/** What a failure summary names: the failed step as written, or where outside the steps it failed. */
export function failedStep(
  at: number,
  step?: { k: string; t: string },
  named?: string,
): string {
  if (step) return `${step.k.trim()} ${step.t}`;
  if (at === -1) return "Setting up, before the first step";
  if (at === -2) return "Cleaning up, after the last step";
  return named ?? "A step this run could not place";
}

/** The first lines of a failure message that say what went wrong, without call log headings or stack frames. */
export function shortMessage(message: string, lines = 2, max = 240): string {
  const text = message
    .split("\n")
    .map((l) => l.trim().replace(/^- /, ""))
    .filter((l) => l && l !== "Call log:" && !/^at /.test(l))
    .slice(0, lines)
    .join("\n");
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
