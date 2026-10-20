#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BoardFile } from "@flax/contract";

/**
 * `flax explorer refresh [--workspace <dir>] [--results <dir>] [--out <dir>]`: the data files from a workspace
 * and its results on disk, with no GitHub reads. The workspace's flax.yml is the config.
 */
export async function refresh(values: {
  workspace?: string | undefined;
  results?: string | undefined;
  out?: string | undefined;
}): Promise<number> {
  const root = resolve(
    values.workspace ?? process.env["FLAX_WORKSPACE"] ?? process.cwd(),
  );
  process.env["FLAX_WORKSPACE"] = root;
  const { config } = await import("@flax/scenarios/config");
  const { buildData, NoRuns, writeData } = await import("./build.ts");
  const results = resolve(root, values.results ?? config().paths.results);
  const data = resolve(root, values.out ?? "explorer-data");

  const now = new Date().toISOString();
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // not a git checkout
  }

  const boardPath = join(root, config().paths.board);
  const board: BoardFile = existsSync(boardPath)
    ? (JSON.parse(readFileSync(boardPath, "utf8")) as BoardFile)
    : { readAt: now, checkedAt: now, source: "none", items: [], bugs: [] };

  try {
    writeData(
      data,
      await buildData({
        root,
        resultsDir: results,
        commit,
        now,
        board,
        log: (line) => console.error(line),
      }),
    );
    console.error(`data written to ${data}`);
    return 0;
  } catch (e) {
    console.error(
      e instanceof NoRuns
        ? `${e.message}; run some scenarios first`
        : (e as Error).message,
    );
    return 1;
  }
}
