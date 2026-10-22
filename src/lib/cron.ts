interface Field {
  name: string;
  min: number;
  max: number;
  /** Names accepted in place of numbers, starting at `min`. */
  names?: readonly string[];
}

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// The fields and ranges GitHub Actions accepts for on.schedule.
export const CRON_FIELDS: readonly Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS },
  { name: "day of week", min: 0, max: 6, names: DAYS },
];

const ITEM = /^(?:(\*)|([0-9A-Za-z]+)(?:-([0-9A-Za-z]+))?)(?:\/(\d+))?$/;

function value(token: string, field: Field): number | undefined {
  if (/^\d+$/.test(token)) return Number(token);
  const index = field.names?.indexOf(token.toUpperCase()) ?? -1;
  if (index < 0) return undefined;
  return field.min + index;
}

function itemProblem(item: string, field: Field): string | undefined {
  const match = ITEM.exec(item);
  if (!match)
    return `${field.name} "${item}" is not a value, range, list or step`;
  const [, star, from, to, step] = match;
  if (step !== undefined) {
    const n = Number(step);
    if (n < 1 || n > field.max)
      return `${field.name} step ${step} must be between 1 and ${field.max}`;
  }
  if (star !== undefined) return undefined;
  const bounds = [from, to].filter((t): t is string => t !== undefined);
  const values: number[] = [];
  for (const token of bounds) {
    const v = value(token, field);
    if (v === undefined)
      return `${field.name} "${token}" is not a number or name`;
    if (v < field.min || v > field.max)
      return `${field.name} ${token} is out of range ${field.min}-${field.max}`;
    values.push(v);
  }
  const [low, high] = values;
  if (high !== undefined && low !== undefined && low > high)
    return `${field.name} range ${from}-${to} runs backwards`;
  return undefined;
}

/** Why a schedule is not a valid five-field cron expression, or undefined when it is. */
export function cronProblem(expression: string): string | undefined {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== CRON_FIELDS.length)
    return `has ${parts.length} fields; cron needs exactly ${CRON_FIELDS.length}`;
  for (const [i, part] of parts.entries()) {
    const field = CRON_FIELDS[i]!;
    for (const item of part.split(",")) {
      const reason = itemProblem(item, field);
      if (reason !== undefined) return reason;
    }
  }
  return undefined;
}

export function isValidCron(expression: string): boolean {
  return cronProblem(expression) === undefined;
}
