# @flax/core

Shared pieces of flax that every package uses: the workspace file (`flax.yml`) and its loading, at `@flax/core` and `@flax/core/workspace`, and the HTTP helpers below.

## HTTP

`@flax/core/http` has the small helpers a check or a recorder needs against a service that is sometimes briefly away. None of them adds a header; callers pass their own user agent and headers in `init`.

- `sleep(ms)`: resolves after `ms` milliseconds.
- `fetchRetry(url, init)`: `fetch` with three tries on network errors (DNS blips, resets), waiting 1.5 s and then 3 s between them, and never on HTTP answers: a 500 comes back as it is. A third argument, `{ fetch, sleep }`, replaces either for a test.
- `patientFetch(budgetMs = 90_000, sleep?, inner = fetch)`: a `fetch` that repeats a request while the answer is 503, waiting 2 s, then twice as long each time up to 15 s, and returns the last answer once the next wait would pass the budget. Pass it wherever a client takes a `fetch`.
- `waitFor(what, timeoutMs, probe, pollMs = 5_000)`: calls `probe` until it returns `{ value }`, and past the timeout throws `<what> did not happen within <time> (last seen: <state>)` with the last `state` the probe reported.

```ts
import { patientFetch, waitFor } from "@flax/core/http";

const api = patientFetch();
const reportId = await waitFor("the report finishing", 10 * 60_000, async () => {
  const res = await api(`${base}/reports/latest`, { headers: { "user-agent": "notes-co checks" } });
  const report = (await res.json()) as { id: string; state: string };
  return { value: report.state === "done" ? report.id : undefined, state: report.state };
});
```
