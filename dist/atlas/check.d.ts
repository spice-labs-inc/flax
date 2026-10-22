import { type AtlasConfig } from "../config.ts";
export interface CheckOptions {
    stale?: boolean;
    log: (s: string) => void;
    /** The gitops repository's file tree, for tests; read from the checkout or `gh api` otherwise. */
    gitopsTree?: Set<string>;
}
/** Every file path in a checkout, relative to it, with the .git directory left out. */
export declare function localTree(dir: string): Set<string>;
/** The gitops repository's tree: the checkout beside the atlas when there is one, else `gh api` (network). */
export declare function gitopsTree(root: string, c: AtlasConfig): Set<string> | undefined;
/**
 * Paths under the configured prefixes that a doc cites in a live sentence: every section but
 * the skipped ones, on lines that name the gitops repo (every line of its own doc), without the
 * history phrases. Per-repo drift checks miss a move inside the gitops repo; this catches it.
 */
export declare function citedGitopsPaths(rel: string, text: string, c: AtlasConfig): string[];
export declare function checkGitopsPaths(root: string, c: AtlasConfig, log: (s: string) => void, tree?: Set<string> | undefined): number;
export declare function cmdCheck(root: string, o: CheckOptions): number;
/** Text of a root page, for callers that want to show it. */
export declare function rootPage(root: string, name: string): string | undefined;
