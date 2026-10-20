import type { JobConfig } from "../lib/job.ts";

/** The longest value a collect input takes. */
export const MAX_COLLECT_INPUT_CHARS = 200;
const PRINTABLE = /^[ -~]*$/;
const NAME = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The values a run's --collect-input <name>=<value> flags give, by name.
 * The value is everything after the first =, and may be empty (a scheduled
 * run's, or an input left blank). A flag without =, a bad name or a name
 * given twice is refused.
 */
export function collectInputFlags(
  flags: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const flag of flags) {
    const eq = flag.indexOf("=");
    const name = eq < 0 ? "" : flag.slice(0, eq);
    if (!NAME.test(name))
      throw new Error(`--collect-input takes <name>=<value>, not "${flag}"`);
    if (name in out)
      throw new Error(`--collect-input ${name} is given more than once`);
    out[name] = flag.slice(eq + 1);
  }
  return out;
}

/**
 * The collect inputs of this run that reach collect.ts: each one job.yml
 * declares in collect_inputs, filled in (an empty value is left out), at
 * most MAX_COLLECT_INPUT_CHARS printable ASCII characters, and matching its
 * pattern.
 */
export function checkCollectInputs(
  config: Pick<JobConfig, "name" | "collect_inputs">,
  given: Readonly<Record<string, string>>,
): { values: Record<string, string> } | { error: string } {
  const declared = config.collect_inputs ?? [];
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(given)) {
    const input = declared.find((i) => i.name === name);
    if (input === undefined)
      return {
        error: `${name} is not a collect input of ${config.name} (collect_inputs in its job.yml)`,
      };
    if (value === "") continue;
    if (value.length > MAX_COLLECT_INPUT_CHARS || !PRINTABLE.test(value))
      return {
        error: `the collect input ${name} must be at most ${MAX_COLLECT_INPUT_CHARS} printable ASCII characters`,
      };
    let pattern: RegExp;
    try {
      pattern = new RegExp(input.pattern);
    } catch {
      return {
        error: `the pattern of the collect input ${name} is not a regular expression`,
      };
    }
    if (!pattern.test(value))
      return {
        error: `the collect input ${name} does not match its pattern ${input.pattern}`,
      };
    values[name] = value;
  }
  return { values };
}
