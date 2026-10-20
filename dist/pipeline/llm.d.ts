import { Cache } from './machine.ts';
import { type Answer } from './model-socket.ts';
/**
 * The wiring model, part of every cache key so an answer records the model
 * that gave it. llm.modelEnv, else the model the socket serves (llm.socketModelEnv).
 * There is no default: a run that needs a model call and has none fails.
 */
export declare const MODEL: string;
/**
 * A second model, asked once for a doc MODEL gave up on (ATLAS_WIRING_FALLBACK_MODEL,
 * which a socket runner may set from its own fallback). Its answers are
 * cached under keys of its own; none when unset or the same as MODEL.
 */
export declare const FALLBACK_MODEL: string;
export type Backend = 'model-socket' | 'anthropic-api' | 'claude-cli';
export declare function pickBackend(): Backend;
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
declare class LlmError extends Error {
}
/** No model call was made: this run's model calls are used up. */
export declare class DeferredError extends LlmError {
}
export declare function stripFence(text: string): string;
/** The answer's JSON; one the model ran out of tokens in says so instead of the parser's message. */
export declare function parseAnswer(answer: Answer): unknown;
/** The answer a reuse falls back to: the pinned entry, else the newest one for this key. */
export declare function previousAnswer<T>(opts: Pick<AskOptions<T>, 'cacheKey' | 'reuseKey' | 'parse' | 'cache'>): {
    key: string;
    value: T;
} | undefined;
export declare function ask<T>(opts: AskOptions<T>): Promise<T>;
export {};
