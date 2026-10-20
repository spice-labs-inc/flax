import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { threadId } from "node:worker_threads";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Whether the process that wrote a lock file is gone, so the lock was left behind by a run that crashed. */
export function holderGone(content: string): boolean {
  const pid = Number.parseInt(content, 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Runs `fn` while holding the lock file at `path`, created with O_EXCL, so
 * parallel workers (threads of one run, or other runs on the machine) never
 * build or install the same thing at once. A lock whose process is gone is
 * taken over.
 */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 60 * 60_000);
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(`${process.pid} ${threadId}\n`);
      } finally {
        await handle.close();
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = await readFile(path, "utf8").catch(() => "");
    if (holder !== "" && holderGone(holder)) {
      if ((await readFile(path, "utf8").catch(() => "")) === holder)
        await rm(path, { force: true });
      continue;
    }
    if (Date.now() > deadline)
      throw new Error(
        `gave up waiting for the lock ${path} (${holder.trim()})`,
      );
    await sleep(options.pollMs ?? 1000);
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}
