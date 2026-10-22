import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export interface UntrustedReadOptions {
  /**
   * Refuse a file with more than one name. A hard link made by the box
   * could name a file the runner wrote for another purpose.
   */
  singleLink?: boolean;
}

/**
 * Reads a file the run box could have written. The box user can replace it
 * with a link, a pipe or something huge, so links are never followed, only
 * regular files are read, and the size is capped.
 */
export function readUntrusted(
  path: string,
  maxBytes: number,
  options: UntrustedReadOptions = {},
): { text: string } | { error: string } {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { error: "does not exist" };
    if (code === "ELOOP") return { error: "is a symbolic link" };
    return { error: `cannot be opened (${code ?? "unknown error"})` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { error: "is not a regular file" };
    if (options.singleLink === true && stat.nlink !== 1)
      return { error: `has ${stat.nlink} hard links; only one is allowed` };
    if (stat.size > maxBytes)
      return {
        error: `is ${stat.size} bytes, over the ${maxBytes} byte limit`,
      };
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, buffer, read, stat.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return { text: buffer.subarray(0, read).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}
