import { execFile } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
const run = promisify(execFile);
/** Where fresh clones go; <prefix>_CACHE overrides it so parallel processes do not share one. */
export const CACHE_ROOT = process.env[`${config().envPrefix}_CACHE`] ?? ".cache/repos";
async function git(args, cwd) {
    const { stdout } = await run("git", args, {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
}
export function fullName(repo) {
    return repo.includes("/") ? repo : `${config().repo.owner}/${repo}`;
}
/** The repo's latest GitHub release tag; undefined when the repo has no release. */
export async function latestReleaseTag(repo) {
    try {
        const { stdout } = await run("gh", [
            "release",
            "view",
            "--repo",
            fullName(repo),
            "--json",
            "tagName",
            "--jq",
            ".tagName",
        ]);
        return stdout.trim() || undefined;
    }
    catch (err) {
        const stderr = err !== null && typeof err === "object" && "stderr" in err
            ? String(err.stderr)
            : "";
        if (/release not found/i.test(stderr))
            return undefined;
        throw err;
    }
}
/** A full 40-character commit SHA, which `git clone --branch` cannot take. */
export function isCommitSha(ref) {
    return /^[0-9a-f]{40}$/.test(ref);
}
export async function defaultBranch(repo) {
    const out = await git([
        "ls-remote",
        "--symref",
        `https://github.com/${fullName(repo)}`,
        "HEAD",
    ]);
    const m = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(out);
    if (!m?.[1])
        throw new Error(`cannot resolve default branch of ${repo}`);
    return m[1];
}
async function freshClone(repo, ref, cacheRoot) {
    const dir = join(cacheRoot, `${repo.replace("/", "__")}@${ref.replace(/[^A-Za-z0-9._-]/g, "_")}`);
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(cacheRoot, { recursive: true });
    if (isCommitSha(ref)) {
        await git(["init", "--quiet", tmp]);
        await git(["remote", "add", "origin", `https://github.com/${repo}`], tmp);
        await git(["fetch", "--quiet", "--depth", "1", "origin", ref], tmp);
        await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], tmp);
    }
    else {
        await git([
            "clone",
            "--quiet",
            "--depth",
            "1",
            "--branch",
            ref,
            `https://github.com/${repo}`,
            tmp,
        ]);
    }
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
    const commit = await git(["rev-parse", "HEAD"], dir);
    return { repo, ref, commit, dir };
}
const inFlight = new Map();
/**
 * A fresh shallow clone of the repo at the ref's current tip, under the cache root.
 * Every process clones anew (once per repo and ref), so builders never read a stale or
 * locally edited tree; builders in one process asking for the same repo share the clone.
 */
export async function checkout(req, cacheRoot = CACHE_ROOT) {
    const repo = fullName(req.repo);
    let ref = req.ref ?? (await defaultBranch(repo));
    if (ref === "latest-release") {
        const tag = await latestReleaseTag(repo);
        if (tag === undefined)
            throw new Error(`${repo} has no GitHub release`);
        ref = tag;
    }
    const key = `${cacheRoot}|${repo}@${ref}`;
    let pending = inFlight.get(key);
    if (!pending) {
        pending = freshClone(repo, ref, cacheRoot);
        inFlight.set(key, pending);
        pending.catch(() => inFlight.delete(key));
    }
    return pending;
}
//# sourceMappingURL=repo.js.map