// The pipeline machine: runs an ordered list of stages, each either deterministic
// code or an LLM call, with a content-addressed cache so unchanged inputs are
// never re-asked.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
export function sha(input) {
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
export class Cache {
    dir;
    enabled;
    constructor(dir, enabled) {
        this.dir = dir;
        this.enabled = enabled;
        if (enabled)
            mkdirSync(dir, { recursive: true });
    }
    path(key) {
        return join(this.dir, `${key}.json`);
    }
    get(key) {
        if (!this.enabled)
            return undefined;
        const p = this.path(key);
        if (!existsSync(p))
            return undefined;
        try {
            return JSON.parse(readFileSync(p, 'utf8'));
        }
        catch {
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
    getStale(key) {
        if (!this.enabled)
            return undefined;
        const dir = dirname(this.path(key));
        if (!existsSync(dir))
            return undefined;
        const prefix = `${key.split('/').pop()}.`;
        let newest;
        for (const name of readdirSync(dir)) {
            if (!name.startsWith(prefix) || !name.endsWith('.json'))
                continue;
            const file = join(dir, name);
            const mtime = statSync(file).mtimeMs;
            if (!newest || mtime > newest.mtime)
                newest = { file, mtime };
        }
        if (!newest)
            return undefined;
        try {
            const value = JSON.parse(readFileSync(newest.file, 'utf8'));
            return { key: join(dirname(key), basename(newest.file, '.json')), value };
        }
        catch {
            return undefined;
        }
    }
    set(key, value) {
        if (!this.enabled)
            return;
        const p = this.path(key);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(value, null, 1));
    }
}
export async function runPipeline(stages, ctx) {
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
export async function pmap(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length)
                return;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}
//# sourceMappingURL=machine.js.map