// The pipeline machine: runs an ordered list of stages, each either deterministic
// code or an LLM call, with a content-addressed cache so unchanged inputs are
// never re-asked.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type StageKind = 'code' | 'ai';

export interface Ctx {
  /** Absolute path of the atlas repo root. */
  atlasRoot: string;
  /** Absolute path of viz/. */
  vizRoot: string;
  /** Accumulated stage outputs, keyed by stage id. */
  out: Record<string, any>;
  /** Only process these repo names (debug aid). */
  only?: string[];
  /** Reuse a previous answer when only the prompt hash changed. */
  reuseStale?: boolean;
  /** With reuseStale: still re-extract a doc whose own wiring sections changed since its answer was made. */
  reextractChanged?: boolean;
  /** At most this many docs may call the model in one run; no limit when not set. */
  maxExtractions?: number;
  /** Ignore the cache and re-run every AI call. */
  noCache?: boolean;
  log: (msg: string) => void;
}

export interface Stage {
  id: string;
  kind: StageKind;
  title: string;
  run: (ctx: Ctx) => Promise<any>;
}

export function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export class Cache {
  dir: string;
  enabled: boolean;

  constructor(dir: string, enabled: boolean) {
    this.dir = dir;
    this.enabled = enabled;
    if (enabled) mkdirSync(dir, { recursive: true });
  }

  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  get<T>(key: string): T | undefined {
    if (!this.enabled) return undefined;
    const p = this.path(key);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  /**
   * The newest cached answer for `key` under any prompt hash.
   *
   * A wiring key hashes the doc's own wiring sections, so an edit to the doc
   * misses the cache. That is correct for a run allowed to call a model and
   * wrong for the daily data refresh, which only needs the advisory dates moved
   * and must never call one.
   */
  getStale<T>(key: string): { key: string; value: T } | undefined {
    if (!this.enabled) return undefined;
    const dir = dirname(this.path(key));
    if (!existsSync(dir)) return undefined;
    const prefix = `${key.split('/').pop()}.`;
    let newest: { file: string; mtime: number } | undefined;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      const file = join(dir, name);
      const mtime = statSync(file).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    }
    if (!newest) return undefined;
    try {
      const value = JSON.parse(readFileSync(newest.file, 'utf8')) as T;
      return { key: join(dirname(key), basename(newest.file, '.json')), value };
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    if (!this.enabled) return;
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(value, null, 1));
  }
}

export async function runPipeline(stages: Stage[], ctx: Ctx): Promise<Ctx> {
  const started = Date.now();
  for (const [i, stage] of stages.entries()) {
    const t0 = Date.now();
    ctx.log(`[${i + 1}/${stages.length}] ${stage.kind === 'ai' ? 'ai  ' : 'code'}  ${stage.title}`);
    ctx.out[stage.id] = await stage.run(ctx);
    ctx.log(`        done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  ctx.log(`pipeline finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return ctx;
}

/** Bounded-concurrency map, so AI stages fan out without flooding the API. */
export async function pmap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
