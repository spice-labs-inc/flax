# The usage view

The usage view shows how much each item on the map is really used in one environment, next to what the scenarios prove about it. It is a plug-in: flax ships the contract, the service routes, the storage and the page, and a workspace brings its own relay, a small program that reads the product's telemetry, decides who made each request and posts aggregates. Nothing in flax reads telemetry or knows a product's people. The shapes are in [`packages/contract/src/usage.ts`](../../packages/contract/src/usage.ts); this page explains them.

## Turning it on

The view is off unless `flax.yml` turns it on under `explorer.usage`:

```yaml
explorer:
  usage:
    env: live                     # where the use comes from; the reference environment when left out
    labels:                       # the words people see for each class of use
      outside: "outside notes-co" # after a count: "2 organizations outside notes-co"
      internal: "the notes-co team"
      runs: "our scenario runs"
    org: { one: organization, many: organizations }
    requestSurfaces: [cli]        # surfaces whose counts are requests rather than uses
    history: explorer/usage-history.json  # optional: a history for builds without a service
```

`usage: true` takes every default: the reference environment, the labels "from outside", "our team" and "our runs", and "organization". The service then accepts usage calls with `Authorization: Bearer <EXPLORER_USAGE_TOKEN>` (the value, or a file named by `EXPLORER_USAGE_TOKEN_FILE`); without the token it refuses every call and says so once at start. Without `explorer.usage` the routes answer 404 and the page never mentions use.

## Classes of use

Every request falls into one class, decided by the relay:

- `outside`: anyone not marked as the organization's own, which is the use that matters most;
- `internal`: the organization's own people, kept apart so they never pass for outside use;
- `runs`: the organization's own scenario runs, which reach items without proving anything about them.

The labels only change the words. "Used by 2 organizations outside notes-co, the notes-co team and our scenario runs."

## What the relay sends

Only aggregates. An organization travels as an opaque salted hash in hex (8 to 64 characters, such as the first 12 characters of a SHA-256 of a secret salt and the id), so the service can count distinct organizations without ever holding one; the page shows only counts. No user ids, addresses, request paths beyond the item id, or user agents.

`POST /ingest/usage/live`, about every minute, one short window of requests:

```json
{ "env": "live", "from": "2026-10-15T18:00:00Z", "to": "2026-10-15T18:05:00Z",
  "rows": [ { "item": "api:GET /api/notes", "cls": "outside", "org": "3f9a1c2b7d4e", "n": 7, "last": "2026-10-15T18:04:12Z" } ] }
```

`POST /ingest/usage/history`, about every hour, the last 30 days by day in the workspace's `scenarios.timezone`:

```json
{ "env": "live", "generatedAt": "2026-10-15T18:07:00Z",
  "days": [ { "day": "2026-10-15", "item": "api:GET /api/notes", "cls": "outside", "org": "3f9a1c2b7d4e", "n": 30 } ] }
```

`item` is the map's item id. A key the map has no item for is still counted under its own key and named in the data build's log, never dropped. `org` is null for requests without one. `env` must be one of the workspace's environments. A body is at most 2 MB and 100,000 rows; anything else is refused with a 400 that says why.

Windows may overlap: the service replaces a window sent again with the same end, counts every request once across overlapping windows, and keeps 24 hours of them. A new history replaces the one before and rebuilds the data.

## Where it is kept and shown

The service keeps `usage/live-<env>.json` and `usage/history-<env>.json` under its state directory, so a restart keeps both. It streams the last 24 hours per item and class (`orgs`, `n24h`, `last`) as the `usage` event and in the snapshot, and the data build turns the history into `usage.json` (per item and class: `orgs`, `n`, `today`, `lastDay`), or null before the first history.

On the page:

- the map rings a hex used in the last ten minutes in its class's color, with a legend line per class;
- an item's panel and a feature's page carry one line of use: "Use on Live: 2 organizations outside notes-co, last 3 minutes ago; the notes-co team 14 times in the last 24 hours";
- the Now door lists the items used from outside or by the organization's own people that are not verified in that environment, most organizations first, and apart from them the items its own runs reach without verifying.

A missing file or a quiet stream never shows as zero use; the lines simply do not appear.

## Without a service

`flax explorer build` and `refresh` have no service to receive a history, so the data build reads the file `explorer.usage.history` names when no history was delivered. The demo workspace uses this with fictional numbers.
