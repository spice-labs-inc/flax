#!/usr/bin/env node
/**
 * `flax explorer refresh [--workspace <dir>] [--results <dir>] [--out <dir>]`: the data files from a workspace
 * and its results on disk, with no GitHub reads. The workspace's flax.yml is the config.
 */
export declare function refresh(values: {
    workspace?: string | undefined;
    results?: string | undefined;
    out?: string | undefined;
}): Promise<number>;
