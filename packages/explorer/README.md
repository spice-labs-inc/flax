# @flax/explorer

The living map of what a scenario library proves: every surface of the product drawn as islands of hexes, one hex per item, each showing its state in every environment; the features in the product's own words; the personas and their journeys; what is failing right now; and what is planned. A page built from a workspace's scenarios and results, and a service that follows scheduled runs live.

## Commands

Run in the workspace directory (the one holding `flax.yml`), or pass `--workspace <dir>`:

| command | does |
|---|---|
| `flax explorer build [--site <dir>] [--out <dir>] [--single-file] [--page-only]` | builds the page for this workspace into `explorer-site/` and the data files into `explorer-data/` |
| `flax explorer serve [--port <n>] [--results <dir>] [--state <dir>]` | the service: the page, the data and the live layer on one port (8081 by default, or `explorer.port`) |
| `flax explorer refresh [--results <dir>] [--out <dir>]` | the data files only, from the results on disk |

The page is built per workspace: the environments, surfaces and titles of `flax.yml` are part of the build, which is why `build` runs vite inside this package with the workspace's configuration. `--single-file` makes one self-contained HTML file with the data inside it, for sharing.

## The service

`serve` reads the workspace (`EXPLORER_DATASET_DIR`), keeps its state under `explorer-state/` (`EXPLORER_STATE_DIR`: `data/<version>/` with a `manifest.json` naming the live version, `results/`, `live/`, `usage/`), builds the data on start and after every finished run, and answers:

- `GET /healthz`
- `POST /ingest/runs/<run id>/start|messages|finish` with `Authorization: Bearer <EXPLORER_INGEST_TOKEN>`: what `flax scenarios run` pushes while it runs (`EXPLORER_URL`, `EXPLORER_INGEST_TOKEN` on the runner's side)
- `POST /ingest/usage/live|history` with `Authorization: Bearer <EXPLORER_USAGE_TOKEN>`: a workspace relay's usage aggregates, when `explorer.usage` turns the usage view on (`docs/explorer/usage.md`)
- `GET /live/state`, `GET /live/events` (server-sent events), `GET /live/runs/<run id>/scenarios/<id>`
- `GET /data/*` and the page itself, when no proxy serves them

### Results from GitHub

When scheduled runs keep their results as workflow artifacts (the `@flax/agents` results output, or anything that uploads `run.json`, `planned.json`, `messages.ndjson` and an `index.json` under the names `@flax/contract/run-artifacts` describes), the service downloads them as a fallback for runs that never pushed. Name the source in `flax.yml`:

```yaml
explorer:
  title: Notes Scenarios
  description: What the Notes product verifies for its users.
  results:
    repo: notes-co/notes-scenarios     # owner/name; a bare name takes the workspace's github owner
    workflow: scenario-checks.yml      # for the runs in progress
    job: scenario-checks               # artifacts are <job>-<env> and <job>-shadow-<env>
```

and give the service a GitHub App installed on that repository with read access to actions: `EXPLORER_GH_APP_ID` and `EXPLORER_GH_APP_KEY` (the PEM, or base64 of it). Without them the service says so once and serves pushed runs only.

## The reference deployment

`deploy/` holds a Dockerfile with two targets, `site` (Caddy and the built page) and `service` (Node and the service), a `compose.yml` that runs them side by side, and the Caddyfile that serves the page and the data and proxies `/ingest/*` and `/live/*` to the service. Both images install the packages from the registry and copy only the dataset: `flax.yml`, `surface/`, `features/`, `personas/`, `journeys/` and the board file. Build from the workspace directory:

```
docker build -f deploy/Dockerfile --target site .
docker build -f deploy/Dockerfile --target service .
```

## The data files

`@flax/contract` names them: `coverage.json`, `journeys.json`, `history.json`, `scenarios.json`, `shots.json` (failure screenshots, 2 MB budget) and `board.json` (open issues for planned work; an empty board is fine). `history.json` carries its environment order in `envs`; a file built for another order is permuted on read, so older data and other workspaces' files still show. `usage.json` (how much each item is used, aggregates only) is null unless `explorer.usage` is on and a history has arrived.

## Development

`pnpm dev` serves the page from vite with `/data/*` from `EXPLORER_DATA_DIR` and the live layer proxied to `EXPLORER_SERVICE`; `pnpm check` runs svelte-check against the test fixture workspace; `pnpm test` runs the page and service tests. This package pins TypeScript 6 because svelte-check does not run on 7 yet.
