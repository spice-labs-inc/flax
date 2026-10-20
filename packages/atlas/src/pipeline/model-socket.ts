// Model calls through a Unix socket speaking the Messages API (a runner's
// forwarder onto a model gateway), shared by the wiring stage and the wiring evaluation.

import { request } from 'node:http';
import { config } from '../config.ts';

/** Calls in flight at once; a gateway key over its parallel limit answers HTTP 429. */
export const MODEL_CALLS_AT_ONCE = () => config().llm.concurrency;

/** Per call; keep within the socket's cap. */
export const MAX_TOKENS = () => config().llm.maxTokens;

/** The answer's text and why the model stopped ("max_tokens" when it ran out). */
export interface Answer {
  text: string;
  stopReason?: string;
}

export type Ask = (prompt: string) => Promise<Answer>;

/** POST /v1/messages on the socket; the runner picks the model, so `model` is only passed along. */
export function viaSocket(socketPath: string, model: string): Ask {
  return (prompt) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({ model, max_tokens: MAX_TOKENS(), messages: [{ role: 'user', content: prompt }] });
      const req = request(
        {
          socketPath,
          path: '/v1/messages',
          method: 'POST',
          timeout: 600_000,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'anthropic-version': '2023-06-01',
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            if (res.statusCode !== 200) return reject(new Error(`model call HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
            try {
              const reply = JSON.parse(text);
              resolve({
                text: (reply.content ?? [])
                  .filter((b: any) => b.type === 'text')
                  .map((b: any) => b.text)
                  .join(''),
                stopReason: typeof reply.stop_reason === 'string' ? reply.stop_reason : undefined,
              });
            } catch {
              reject(new Error('unreadable model reply'));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('model call timed out')));
      req.on('error', reject);
      req.end(body);
    });
}

/** Waits out the gateway's 429 (too many requests on this key) instead of spending an extraction attempt on it. */
export function patient(ask: Ask): Ask {
  return async (prompt) => {
    for (let wait = 5_000; ; wait *= 2) {
      try {
        return await ask(prompt);
      } catch (e) {
        if (!(e instanceof Error && e.message.startsWith('model call HTTP 429')) || wait > 320_000) throw e;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };
}
