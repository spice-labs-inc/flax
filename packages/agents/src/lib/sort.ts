/** Locale-independent ordering, so generated files are identical on every machine. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
