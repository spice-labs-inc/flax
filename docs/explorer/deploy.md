# Deploying the explorer

The explorer is two long-running pieces: a static page served by a small web server, and a service that owns the data the page loads, follows runs as they happen, and rebuilds the data when a run finishes. This page describes both, the ingest and event endpoints, the fallback to the code host, the settings, and the compose example that runs them on one host.

## The page and the service

The page is a single-page application built once from the workspace's configuration (titles, islands, kinds, the environment list), with no server code of its own. It asks the same origin for `/data/*`, `/live/*` and `/ingest/*`; every other path falls back to the page, so a deep link reloads correctly.

The service is a small Node program over the platform's HTTP module. It owns a state directory with three folders: `data/` (the versions and the manifest the page loads), `results/` (each run as `<env>/<run id>/`, the layout the fetch command leaves, the newest fifty runs per environment) and `live/` (each run's pushed messages as one newline-delimited file, so a restart loses nothing it acknowledged). On start it builds the data from what it has; when a run finishes it writes it into `results/`, builds every data file in a worker thread into `data/<version>/` and then swaps `data/manifest.json`.

## Ingest

A scenario run with the explorer's URL and ingest token set pushes its progress:

- `POST /ingest/runs/<run id>/start` with the run's metadata (environment, workers, planned count, the scenarios commit, the code host run when there is one);
- `POST /ingest/runs/<run id>/messages` with batches of the runner's messages, each envelope numbered;
- `POST /ingest/runs/<run id>/finish`.

A workspace with the usage view on (`explorer.usage`) also takes its relay's aggregates on `POST /ingest/usage/live` and `POST /ingest/usage/history` with its own token; see [usage.md](usage.md).

The service checks the bearer token in constant time, accepts only run ids in the runner's shape, deduplicates batches by sequence number, and appends to `live/<run id>.ndjson`. A run that goes quiet is marked `incomplete` after a grace period; a batch gap is flagged on the run summary. The push side never slows or fails a run (see [../scenarios/runner.md](../scenarios/runner.md)).

## The event stream

`GET /live/events` is a server-sent events stream: a `snapshot` first, then `run-started`, `scenario-started`, `step-finished`, `scenario-finished`, `run-finished`, `run-incomplete`, `heartbeat`, `data` when a new data version is built, and `usage` when a relay sends a window. `GET /live/state` is the same snapshot as JSON. `GET /healthz` answers for health checks. Behind a reverse proxy, the stream needs buffering off and a long idle timeout; the service sends a comment line first so the headers flush through proxies that wait for a body.

## Fallback to the code host

With `explorer.results` set in `flax.yml` (`repo`, `workflow`, `job`: the workspace repository, the scheduled check workflow and the job whose artifacts carry the results; `extraJobs` lists more jobs whose artifacts carry results under the same naming, such as a slower cadence's own job) and a GitHub App configured (an app id and its private key as PEM or base64), the service downloads new results artifacts under the run artifacts contract every five minutes (an artifact replaces the pushed copy of its run), lists runs in progress every minute (shown as in progress with no live detail when they push nothing), and re-reads the planned-work issues every thirty minutes. Without it, the service relies on ingest alone and the board file is read as committed.

## Settings

| variable | default | what |
|---|---|---|
| `EXPLORER_STATE_DIR` | `/srv` | the state directory: `data/`, `results/`, `live/`, and `usage/` with the usage view on |
| `EXPLORER_PORT` | `8081` | the service's port |
| `EXPLORER_INGEST_TOKEN` | none | the bearer token runs push with; ingest is refused without it |
| `EXPLORER_WORKSPACE` | the current directory | the workspace whose configuration, dataset and features the data build reads |
| `EXPLORER_GH_APP_ID`, `EXPLORER_GH_APP_KEY` | none | the code host app for the fallback, with `explorer.results` in `flax.yml` |
| `EXPLORER_USAGE_TOKEN` (or `EXPLORER_USAGE_TOKEN_FILE`) | none | the bearer token a usage relay posts with, with `explorer.usage` in `flax.yml`; usage calls are refused without it |
| `EXPLORER_COMMIT` | set by the image | shown in the manifest |

On the runner's side, `EXPLORER_URL` and `EXPLORER_INGEST_TOKEN` turn the push on.

## Images

`flax explorer serve` serves the page and the data itself, so a one-process deployment needs no web server in front. The reference deployment under `packages/explorer/deploy/` (a container build, a compose file and a web server configuration) keeps the two-container shape, which separates the read-only site from the service that writes state. Its container build has two targets: `site`, a web server serving the page on 8080 with `/data/*` read from the service's data directory (versions cached for a year, the manifest never), `/live/*` and `/ingest/*` passed to the service, every other path falling back to the page, and `/healthz`; and `service`, the service with the workspace's dataset at that commit. Both run as any non-root user on a read-only filesystem with a writable `/tmp`.

## The compose example

One host, one network, two containers, a state directory on disk:

```yaml
services:
  service:
    image: ghcr.io/notes-co/flax-explorer-service:0.1.0
    user: "1000:1000"
    read_only: true
    tmpfs: [/tmp]
    environment:
      EXPLORER_STATE_DIR: /srv
      EXPLORER_INGEST_TOKEN: ${EXPLORER_INGEST_TOKEN:?}
    volumes:
      - ./explorer-state:/srv
    restart: unless-stopped

  site:
    image: ghcr.io/notes-co/flax-explorer:0.1.0
    user: "1000:1000"
    read_only: true
    tmpfs: [/tmp]
    volumes:
      - ./explorer-state/data:/srv/data:ro
    ports:
      - "127.0.0.1:8620:8080"
    depends_on: [service]
    restart: unless-stopped
```

The ingest token comes from `.env` beside the file. Put the site behind the reverse proxy you already run, with TLS and, if the explorer is internal, your private network. The state directory must be writable by the service's user; the site mounts only the data folder, read only. A workspace builds its own two images from the package's container build with its dataset copied in, publishes them on every push to its default branch, and writes the new tags into its deployment configuration, which is how the reference deployment stays current within minutes of a merge.

## Running it locally

```sh
flax explorer refresh --results <dir>          # the data files from the results on disk
flax explorer build --single-file --out <dir>  # the page; --single-file carries the data inside it
flax explorer serve --state <dir> --port 8081  # the service, from the workspace in the current directory
```

Every command takes `--workspace <dir>` or reads `FLAX_WORKSPACE`. The single-file build (one `index.html` with its data inside and its paths after a `#`) is for sharing a snapshot; the service is for the living map.

## To confirm against the package

- The image names the package's container build produces.
