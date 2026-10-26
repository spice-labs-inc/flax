export interface Checkout {
    repo: string;
    /** Branch, tag or commit SHA that was checked out. */
    ref: string;
    commit: string;
    dir: string;
}
export interface CheckoutRequest {
    /** `owner/name`; bare names are repos of the configured owner. */
    repo: string;
    /** Branch, tag or full commit SHA; `latest-release` resolves the repo's latest GitHub release tag. Default: the default branch. */
    ref?: string;
}
/** Where fresh clones go; <prefix>_CACHE overrides it so parallel processes do not share one. */
export declare const CACHE_ROOT: string;
export declare function fullName(repo: string): string;
/** The repo's latest GitHub release tag; undefined when the repo has no release. */
export declare function latestReleaseTag(repo: string): Promise<string | undefined>;
/** A full 40-character commit SHA, which `git clone --branch` cannot take. */
export declare function isCommitSha(ref: string): boolean;
export declare function defaultBranch(repo: string): Promise<string>;
/**
 * A fresh shallow clone of the repo at the ref's current tip, under the cache root.
 * Every process clones anew (once per repo and ref), so builders never read a stale or
 * locally edited tree; builders in one process asking for the same repo share the clone.
 */
export declare function checkout(req: CheckoutRequest, cacheRoot?: string): Promise<Checkout>;
