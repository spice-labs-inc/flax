import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "@flax/contract";
import type { Log } from "./log.ts";

export interface Manifest {
  version: string;
  builtAt: string;
  commit: string;
}

export function readManifest(dataDir: string): Manifest | undefined {
  const path = join(dataDir, "manifest.json");
  if (!existsSync(path)) return undefined;
  try {
    const m: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(m) &&
      typeof m["version"] === "string" &&
      typeof m["builtAt"] === "string" &&
      typeof m["commit"] === "string"
      ? { version: m["version"], builtAt: m["builtAt"], commit: m["commit"] }
      : undefined;
  } catch {
    return undefined;
  }
}

const VERSION = /^v\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/**
 * Builds the data files into `<data>/<version>/`, then swaps `<data>/manifest.json` to name it, so a page never reads
 * a half-written set. One build at a time; requests while one runs fold into one more build after it.
 */
export class Rebuilder {
  readonly #dataDir: string;
  readonly #build: (outDir: string, now: string) => Promise<void>;
  readonly #commit: string;
  readonly #log: Log;
  readonly #onData: (m: Manifest) => void;
  readonly #keep: number;
  #running: Promise<void> | undefined;
  #again = false;

  constructor(options: {
    dataDir: string;
    commit: string;
    build: (outDir: string, now: string) => Promise<void>;
    log: Log;
    onData: (m: Manifest) => void;
    keep?: number;
  }) {
    this.#dataDir = options.dataDir;
    this.#commit = options.commit;
    this.#build = options.build;
    this.#log = options.log;
    this.#onData = options.onData;
    this.#keep = options.keep ?? 3;
  }

  /** Resolves once a build that started after this call has finished. */
  request(why: string): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running.then(() => this.#running ?? Promise.resolve());
    }
    this.#running = this.#loop(why).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #loop(why: string): Promise<void> {
    let reason = why;
    do {
      this.#again = false;
      await this.#once(reason);
      reason = "changes during the last build";
    } while (this.#again);
  }

  async #once(why: string): Promise<void> {
    const at = new Date();
    const version = `v${at.toISOString().replace(/[:.]/g, "-")}`;
    const out = join(this.#dataDir, version);
    const t0 = Date.now();
    try {
      mkdirSync(out, { recursive: true });
      await this.#build(out, at.toISOString());
      const manifest: Manifest = {
        version,
        builtAt: at.toISOString(),
        commit: this.#commit,
      };
      const tmp = join(this.#dataDir, ".manifest.json.tmp");
      writeFileSync(tmp, JSON.stringify(manifest));
      renameSync(tmp, join(this.#dataDir, "manifest.json"));
      this.#log(
        "info",
        `data ${version} built in ${((Date.now() - t0) / 1000).toFixed(1)} s (${why})`,
      );
      this.#prune(version);
      this.#onData(manifest);
    } catch (e) {
      rmSync(out, { recursive: true, force: true });
      this.#log(
        "warn",
        `data build failed (${why}): ${(e as Error).message.split("\n")[0]}`,
      );
    }
  }

  #prune(current: string): void {
    const versions = readdirSync(this.#dataDir)
      .filter((d) => VERSION.test(d) && d !== current)
      .sort()
      .reverse();
    for (const old of versions.slice(this.#keep - 1))
      rmSync(join(this.#dataDir, old), { recursive: true, force: true });
  }
}
