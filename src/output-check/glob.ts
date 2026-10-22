function segmentPattern(glob: string): string {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/**
 * Converts a path glob to a regular expression: `**` as a whole segment
 * matches any number of segments, `*` anything inside one segment, `?` one
 * character other than `/`. Nothing else is special.
 */
export function globToRegExp(glob: string): RegExp {
  const parts = glob.split("/");
  let out = "^";
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    if (part === "**") out += last ? ".*" : "(?:[^/]+/)*";
    else out += segmentPattern(part) + (last ? "" : "/");
  }
  return new RegExp(`${out}$`);
}

/** A relative path with no empty, `.` or `..` segment and no backslash. */
export function isPlainRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

export function matchesAnyGlob(
  path: string,
  globs: readonly string[],
): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
