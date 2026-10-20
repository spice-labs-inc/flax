// LLM runner for the AI stages.
//
// Three backends. `model-socket` posts to a Unix socket speaking the Messages API
// (llm.socketEnv in flax.yml names the variable), whose runner picks the model and
// holds the key. `anthropic-api` uses the SDK when ANTHROPIC_API_KEY is set. Otherwise
// `claude-cli` shells out to the Claude Code CLI with the operator's login.

import { spawn } from 'node:child_process';
import { Cache, sha } from './machine.ts';
import { patient, viaSocket, type Answer } from './model-socket.ts';
import { config } from '../config.ts';

/**
 * The wiring model, part of every cache key so an answer records the model
 * that gave it. llm.modelEnv, else the model the socket serves (llm.socketModelEnv).
 * There is no default: a run that needs a model call and has none fails.
 */
export const MODEL = process.env[config().llm.modelEnv] || process.env[config().llm.socketModelEnv] || '';

/**
 * A second model, asked once for a doc MODEL gave up on (ATLAS_WIRING_FALLBACK_MODEL,
 * which a socket runner may set from its own fallback). Its answers are
 * cached under keys of its own; none when unset or the same as MODEL.
 */
export const FALLBACK_MODEL = (() => {
  const m = process.env[config().llm.fallbackEnv] || '';
  return m === MODEL ? '' : m;
})();

const SOCKET = process.env[config().llm.socketEnv] || '';

export type Backend = 'model-socket' | 'anthropic-api' | 'claude-cli';

export function pickBackend(): Backend {
  if (SOCKET) return 'model-socket';
  return process.env.ANTHROPIC_API_KEY ? 'anthropic-api' : 'claude-cli';
}

export interface AskOptions<T> {
  /** Stable identity for the cache: same key + same prompt hash = cache hit. */
  cacheKey: string;
  prompt: string;
  /**
   * What the answer depends on, hashed into the cache key instead of the whole
   * prompt. The wiring stage passes the doc's own text, so a change elsewhere
   * in the atlas (the global component-id list in every prompt) does not re-key
   * every doc. An answer cached under the whole-prompt key still counts as a hit.
   */
  keyInput?: string;
  /** Throws with a readable message when the model's JSON is not usable. */
  parse: (raw: any) => T;
  /** On a prompt-hash miss, fall back to a previous answer for this key. */
  reuseStale?: boolean;
  /** The exact entry the last emitted graph used, from data/wiring-keys.json. */
  reuseKey?: string;
  /** Called when that fallback is taken, so a run can report how often. */
  onReuse?: () => void;
  /** The cache key this answer actually came from, hit or reuse or fresh. */
  onResolved?: (key: string) => void;
  /** Ask FALLBACK_MODEL once when MODEL gives up after its attempts. */
  fallback?: boolean;
  /** Called with MODEL's error before the fallback model is asked. */
  onFallback?: (why: string) => void;
  /** Called with the model that made a fresh answer. */
  onAnswer?: (model: string) => void;
  /** Records the model in a fresh answer before it is cached. */
  withModel?: (value: T, model: string) => T;
  cache: Cache;
  attempts?: number;
  /** Asked once, right before the first model call; false skips the call and throws. */
  mayCall?: () => boolean;
}

class LlmError extends Error {}

/** No model call was made: this run's model calls are used up. */
export class DeferredError extends LlmError {}

export function stripFence(text: string): string {
  const t = text.trim();
  const fenced = t.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  if (fenced) return fenced[1].trim();
  // Fall back to the outermost JSON object/array in the text.
  const first = t.search(/[[{]/);
  if (first === -1) return t;
  const last = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  return last > first ? t.slice(first, last + 1) : t.slice(first);
}

/** The answer's JSON; one the model ran out of tokens in says so instead of the parser's message. */
export function parseAnswer(answer: Answer): unknown {
  try {
    return JSON.parse(stripFence(answer.text));
  } catch (e) {
    if (answer.stopReason === 'max_tokens') throw new LlmError('answer cut off at max_tokens');
    throw e;
  }
}

async function callClaudeCli(prompt: string, model: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--model', model,
        '--output-format', 'json',
        // Keep the sub-invocation lean and hermetic: no MCP servers, no tools.
        '--strict-mcp-config',
        '--mcp-config', '{"mcpServers":{}}',
        '--allowed-tools', '',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new LlmError(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      try {
        const env = JSON.parse(stdout);
        if (env.is_error) return reject(new LlmError(`claude reported error: ${env.subtype ?? ''}`));
        resolve({ text: String(env.result ?? '') });
      } catch (e) {
        reject(new LlmError(`unparseable CLI envelope: ${String(e)}`));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function callAnthropicApi(prompt: string, model: string): Promise<Answer> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const res = await client.messages.create({
    model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    messages: [{ role: 'user', content: prompt }],
  });
  if (res.stop_reason === 'refusal') throw new LlmError('request refused');
  return {
    text: res.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join(''),
    stopReason: res.stop_reason ?? undefined,
  };
}

/** The cache keys of this model's answer, the one it is stored under first. */
function keysFor(opts: Pick<AskOptions<unknown>, 'cacheKey' | 'prompt' | 'keyInput'>, model: string): string[] {
  const promptKey = `${opts.cacheKey}.${sha(`${model}\n${opts.prompt}`)}`;
  if (opts.keyInput === undefined) return [promptKey];
  return [`${opts.cacheKey}.${sha(`${model}\n${opts.keyInput}`)}`, promptKey];
}

function caller(model: string): (prompt: string) => Promise<Answer> {
  const backend = pickBackend();
  if (backend === 'model-socket') return patient(viaSocket(SOCKET, model));
  return backend === 'anthropic-api' ? (p) => callAnthropicApi(p, model) : (p) => callClaudeCli(p, model);
}

/** Asks one model up to `attempts` times; throws when no answer was usable. */
async function extract<T>(opts: AskOptions<T>, model: string, attempts: number): Promise<T> {
  const { cacheKey, prompt, parse, cache } = opts;
  const call = caller(model);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // On a retry, tell the model exactly what was wrong with its last answer.
    const p =
      attempt === 1
        ? prompt
        : `${prompt}\n\nYour previous answer could not be used: ${String(lastErr)}\nReturn only the JSON document, with no prose and no code fence.`;
    try {
      const parsed = parse(parseAnswer(await call(p)));
      const value = opts.withModel ? opts.withModel(parsed, model) : parsed;
      const key = keysFor(opts, model)[0];
      cache.set(key, value);
      opts.onAnswer?.(model);
      opts.onResolved?.(key);
      return value;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (attempt === attempts) break;
    }
  }
  throw new LlmError(`${cacheKey}: ${model} gave up after ${attempts} attempt${attempts === 1 ? '' : 's'} (${String(lastErr)})`);
}

/** The answer a reuse falls back to: the pinned entry, else the newest one for this key. */
export function previousAnswer<T>(
  opts: Pick<AskOptions<T>, 'cacheKey' | 'reuseKey' | 'parse' | 'cache'>,
): { key: string; value: T } | undefined {
  const { cache, cacheKey, parse } = opts;
  const pinned = opts.reuseKey ? cache.get<unknown>(opts.reuseKey) : undefined;
  const found =
    pinned !== undefined ? { key: opts.reuseKey!, value: pinned } : cache.getStale<unknown>(cacheKey);
  if (!found) return undefined;
  try {
    return { key: found.key, value: parse(found.value) };
  } catch {
    // An old answer that no longer validates is not worth reusing.
    return undefined;
  }
}

export async function ask<T>(opts: AskOptions<T>): Promise<T> {
  const { cacheKey, cache } = opts;
  const fallback = opts.fallback === true ? FALLBACK_MODEL : '';

  // The fallback model's answer for the same text counts as an answer too.
  for (const k of [...keysFor(opts, MODEL), ...(fallback ? keysFor(opts, fallback) : [])]) {
    const hit = cache.get<T>(k);
    if (hit !== undefined) {
      opts.onResolved?.(k);
      return hit;
    }
  }

  // The prompt changed but an answer for this document exists. Reusing it
  // keeps a data-only refresh from re-deriving the whole graph through the
  // model; a deliberate re-roll simply does not set this.
  if (opts.reuseStale) {
    const found = previousAnswer(opts);
    if (found) {
      opts.onReuse?.();
      opts.onResolved?.(found.key);
      return found.value;
    }
  }

  if (!MODEL) {
    throw new LlmError(
      `${cacheKey}: no wiring model set (${config().llm.modelEnv})`,
    );
  }
  if (opts.mayCall && !opts.mayCall()) {
    throw new DeferredError(`${cacheKey}: deferred to a later run (this run's model calls are used up)`);
  }
  try {
    return await extract(opts, MODEL, opts.attempts ?? 3);
  } catch (e) {
    if (!fallback) throw e;
    opts.onFallback?.(e instanceof Error ? e.message : String(e));
    return await extract(opts, fallback, 1);
  }
}
