/** Resolves after ms milliseconds. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** fetch with three tries on network errors (DNS blips, resets), never on HTTP answers. */
export async function fetchRetry(url, init, { fetch: inner = fetch, sleep: wait = sleep } = {}) {
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await inner(url, init);
        }
        catch (e) {
            last = e;
            await wait(1500 * attempt);
        }
    }
    throw last;
}
/**
 * A fetch that repeats a request while the answer is 503, which asks the
 * client to try again, for up to budgetMs. The waits double from 2 s to at
 * most 15 s; the last answer is returned when the next wait would pass the budget.
 */
export function patientFetch(budgetMs = 90_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), inner = fetch) {
    return async (input, init) => {
        const deadline = Date.now() + budgetMs;
        for (let wait = 2_000;; wait = Math.min(wait * 2, 15_000)) {
            const res = await inner(input instanceof Request ? input.clone() : input, init);
            if (res.status !== 503 || Date.now() + wait > deadline)
                return res;
            await res.body?.cancel();
            await sleep(wait);
        }
    };
}
/**
 * Polls probe every pollMs until it gives a value. Past timeoutMs it throws,
 * naming `what` and the last state the probe reported.
 */
export async function waitFor(what, timeoutMs, probe, pollMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const answer = await probe();
        if (answer.value !== undefined)
            return answer.value;
        if (Date.now() + pollMs > deadline)
            throw new Error(`${what} did not happen within ${duration(timeoutMs)} (last seen: ${answer.state})`);
        await sleep(pollMs);
    }
}
function duration(ms) {
    if (ms < 60_000)
        return `${Math.round(ms / 1000)} s`;
    const minutes = Math.round(ms / 60_000);
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
//# sourceMappingURL=http.js.map