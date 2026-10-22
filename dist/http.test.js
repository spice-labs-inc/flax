import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchRetry, patientFetch, waitFor } from "./http.js";
function answers(...outcomes) {
    const calls = [];
    const fake = (async (input, init) => {
        calls.push({ input, init });
        const next = outcomes.shift();
        if (next === undefined)
            throw new Error("no more answers");
        if (next instanceof Error)
            throw next;
        return new Response(`status ${next}`, { status: next });
    });
    return { fake, calls };
}
function recordedSleep() {
    const waits = [];
    return { waits, sleep: async (ms) => void waits.push(ms) };
}
test("fetchRetry retries network errors up to three tries, waiting longer each time", async () => {
    const { fake, calls } = answers(new TypeError("reset"), new TypeError("dns"), 200);
    const { waits, sleep } = recordedSleep();
    const res = await fetchRetry("https://example.com/a", { method: "POST" }, { fetch: fake, sleep });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2], {
        input: "https://example.com/a",
        init: { method: "POST" },
    });
    assert.deepEqual(waits, [1500, 3000]);
});
test("fetchRetry throws the last network error after three tries", async () => {
    const { fake, calls } = answers(new TypeError("one"), new TypeError("two"), new TypeError("three"), 200);
    const { sleep } = recordedSleep();
    await assert.rejects(fetchRetry("https://example.com/", {}, { fetch: fake, sleep }), /three/);
    assert.equal(calls.length, 3);
});
test("fetchRetry returns an HTTP error answer without retrying", async () => {
    const { fake, calls } = answers(503, 200);
    const { waits, sleep } = recordedSleep();
    const res = await fetchRetry("https://example.com/", {}, { fetch: fake, sleep });
    assert.equal(res.status, 503);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
});
test("patientFetch returns any answer but 503 at once", async () => {
    const { fake, calls } = answers(500, 200);
    const { waits, sleep } = recordedSleep();
    const res = await patientFetch(90_000, sleep, fake)("https://example.com/");
    assert.equal(res.status, 500);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
});
test("patientFetch repeats a 503 with doubling waits until it is answered", async () => {
    const { fake, calls } = answers(503, 503, 503, 200);
    const { waits, sleep } = recordedSleep();
    const res = await patientFetch(90_000, sleep, fake)("https://example.com/", { headers: { "user-agent": "checks" } });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 4);
    assert.deepEqual(waits, [2_000, 4_000, 8_000]);
    assert.deepEqual(calls[3].init, { headers: { "user-agent": "checks" } });
});
test("patientFetch gives back the 503 once the next wait would pass its budget", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const { fake, calls } = answers(503, 503, 503, 503, 200);
    const waits = [];
    const sleep = async (ms) => {
        waits.push(ms);
        t.mock.timers.tick(ms);
    };
    const res = await patientFetch(10_000, sleep, fake)("https://example.com/");
    assert.equal(res.status, 503);
    assert.equal(calls.length, 3);
    assert.deepEqual(waits, [2_000, 4_000]);
});
test("patientFetch sends a fresh copy of a Request each time", async () => {
    const bodies = [];
    let n = 0;
    const fake = (async (input) => {
        bodies.push(await input.text());
        return new Response(null, { status: n++ === 0 ? 503 : 200 });
    });
    const res = await patientFetch(90_000, async () => { }, fake)(new Request("https://example.com/", { method: "POST", body: "payload" }));
    assert.equal(res.status, 200);
    assert.deepEqual(bodies, ["payload", "payload"]);
});
test("waitFor returns the first value the probe gives", async () => {
    let n = 0;
    const value = await waitFor("the count", 1_000, async () => ++n < 3 ? { state: `count ${n}` } : { value: n, state: "done" }, 1);
    assert.equal(value, 3);
});
test("waitFor names what it waited for and the last state when time runs out", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    let n = 0;
    const probe = async () => {
        t.mock.timers.tick(60_000);
        return { state: `state ${++n}` };
    };
    await assert.rejects(waitFor("the report finishing", 3 * 60_000, probe, 1), {
        message: "the report finishing did not happen within 3 minutes (last seen: state 3)",
    });
    assert.equal(n, 3);
});
test("waitFor gives a timeout under a minute in seconds", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const probe = async () => {
        t.mock.timers.tick(30_000);
        return { state: "blank" };
    };
    await assert.rejects(waitFor("the page", 30_000, probe, 1), {
        message: "the page did not happen within 30 s (last seen: blank)",
    });
});
//# sourceMappingURL=http.test.js.map