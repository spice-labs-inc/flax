/** Whether the process that wrote a lock file is gone, so the lock was left behind by a run that crashed. */
export declare function holderGone(content: string): boolean;
/**
 * Runs `fn` while holding the lock file at `path`, created with O_EXCL, so
 * parallel workers (threads of one run, or other runs on the machine) never
 * build or install the same thing at once. A lock whose process is gone is
 * taken over.
 */
export declare function withFileLock<T>(path: string, fn: () => Promise<T>, options?: {
    timeoutMs?: number;
    pollMs?: number;
}): Promise<T>;
