# Getting started

The ten-minute path on a plain Linux host with docker: get the `flax` command, run the demo workspace (the atlas, the scenarios and the explorer) with nothing but Node, then run the agents package offline and with one provider key, and see where lbx and the reference gateway come in. Everything below runs against notes-co, the fictional company in `demo/`, so nothing needs your own repositories yet. Steps marked "planned" are not in the packages yet, as of the lane logs at the time of writing; the rest ran as written.

## What you need

- Linux, with Node 22.13 or newer (the scenario runner strips types with Node itself, so no extra loader is needed) and pnpm (`corepack enable` gives you pnpm).
- docker, for the agents package's sandbox and the explorer's containers; the atlas, the scenarios and the explorer's dev build need none.
- A terminal and a browser.

## 1. The flax command

The packages are published as tags of this repository (section 9); the quickest start is a checkout:

```sh
git clone https://github.com/spice-labs-inc/flax
cd flax
pnpm install
pnpm build
```

`flax <agents|atlas|scenarios|explorer> ...` is one entry point that resolves `@flax/<package>` from the workspace's dependencies and runs it. In the demo workspace it is on the path as `pnpm exec flax`, or `./node_modules/.bin/flax`:

```sh
cd demo
pnpm exec flax atlas --help
```

Every command reads `flax.yml` in the current directory, or takes `--workspace <dir>`, or reads `FLAX_WORKSPACE`. Open `demo/flax.yml` first: the shared keys (`org`, `github`, `environments`) and one section per package are the whole convention (see [workspace.md](workspace.md)).

## 2. The atlas

notes-co's atlas is nine pages under `demo/atlas/repos/`, one flow, and a committed wiring cache, so the whole pipeline runs with no model:

```sh
pnpm exec flax atlas check                       # template, budgets, symmetry, generated content: fail=0
pnpm exec flax atlas generate --reuse-wiring     # the map from the cached wiring: 22 nodes, 40 edges
pnpm exec flax atlas build                       # one HTML file under demo/atlas/viz/dist/
pnpm exec flax atlas serve                       # open it in a browser
```

Read `demo/atlas/repos/notes-api.md` beside [atlas/template.md](atlas/template.md) to see the template filled in; edit a wiring section and run `generate --reextract-changed` with a model configured to see one page re-asked and the rest kept (see [atlas/wiring.md](atlas/wiring.md)).

## 3. The scenarios

notes-co's library is three feature files for two surfaces (the web app and the API), two personas and their journeys:

```sh
pnpm exec flax scenarios run --env test --dry-run   # every step defined, nothing written
pnpm exec flax scenarios dataset                     # the personas and journeys validated, journeys.json written
pnpm exec flax scenarios coverage                    # coverage-map.json and GAPS.md from the surface files
```

A real run (`run --env test`) drives the steps against the hosts `flax.yml` names for `test`; the demo's steps are stubs that pass without a product behind them, except one scenario that fails by design so the explorer has something to show. Results land in `demo/explorer/results/<env>/<run id>/`, in the format [contracts.md](contracts.md) describes. The tag policy in `flax.yml` keeps the `@admin` scenario off `live`.

## 4. The explorer

The explorer draws the surface files, the dataset and the results:

```sh
pnpm exec flax explorer refresh --results explorer/results    # the data files
pnpm exec flax explorer build --single-file --out explorer-site
```

Open `explorer-site/index.html` in a browser: the Now door, two islands, hexes split in two sectors (Live on top, Test below), a failing scenario card and a timeline with the runs in the results directory. Every view is a path after the `#`. For the living map, run the service and push a run into it:

```sh
EXPLORER_INGEST_TOKEN=demo pnpm exec flax explorer serve --state explorer-state --port 8081
EXPLORER_URL=http://127.0.0.1:8081 EXPLORER_INGEST_TOKEN=demo pnpm exec flax scenarios run --env test
```

The run's scenarios appear on the map as they start and finish, and the data rebuilds when it ends. [explorer/deploy.md](explorer/deploy.md) has the two-container compose file for a host.

## 5. The agents package, offline

A job runs offline with a stub in place of the model, which proves everything but the sandbox: the checks, the prompt and input, the schema, the tools server, the report.

```sh
pnpm exec flax agents check                     # every guardrail over the workspace's jobs
pnpm exec flax agents run-job hello --stub      # the fixture answer, validated, with a full report
```

The last line prints where the report is: `status.json`, `summary.md`, `input.json`, `answer.json`, the exact `lbx --run` command a real run would use. `flax agents new-job weekly-digest --owner <your handle>` scaffolds a job of your own; [agents/jobs.md](agents/jobs.md) explains every field. The demo workspace's copies of the reference jobs (`demo/agents/`) are planned; until they land, run the agents package's own fixture workspace.

## 6. The agents package with one provider key

The simplest real run uses the static provider mode: one key, no gateway. This is the default when `flax.yml`'s `agents` section says nothing:

```yaml
agents:
  provider: { name: anthropic, baseUrl: https://api.anthropic.com, keyMode: static }
```

It needs lbx on the host and the agent image:

1. Install lbx: download the release binary from `spice-labs-inc/lbx`, check its checksum, put it on your `PATH` (see [lbx.md](lbx.md)). `lbx --socket-dir / ` without `--run` must answer "only valid with --run".
2. Pull the agent image the workspace's sandbox pin names by digest, or build it from the agents package's image definition (`pnpm exec flax agents box-release` writes the pin for a release).
3. Export `MODEL_API_KEY`, then:

```sh
MODEL_API_KEY=... pnpm exec flax agents run-job hello
```

The run starts the forwarder on a Unix socket, starts the box with `lbx --run --no-network --socket-dir`, and the model's calls go through the forwarder with your key added outside the box; the box never holds it. The report's `forwarder.json` lists every call. What static mode does not give you is a per-run cap at the provider and spend you can trust from outside the job; that is the gateway's job.

## 7. Where lbx and the gateway come in

- **lbx** is the sandbox every model run uses. The runner asks the `lbx` on `PATH` for the two flags it needs, starts the box with no network and a read-only directory of sockets as its only way out, and reads the outcome from lbx's status file. In a workspace it is pinned by release and commit and fetched by the reusable action in the generated workflow, so a runner never needs it installed by hand. See [agents/runtime.md](agents/runtime.md).
- **The gateway** is what makes unattended runs safe to schedule: per-run keys capped in dollars and minutes, blocked when the run ends, with spend read from the gateway. Deploy the reference stack from `packages/gateway` on a host your runners reach, point `flax.yml` at it with `keyMode: litellm`, add `gateway.yml` and the CA root to the workspace, store the issuer key as a repository secret, and the same `run-job hello` runs through it. See [agents/gateway.md](agents/gateway.md).

## 8. Your own workspace

Copy `demo/` to a repository of your own, replace notes-co with your organization in `flax.yml`, point the atlas at your repositories and the scenarios at your hosts, and run `flax agents generate --dist` to write the workflows and the runner bundle. From there the loop is the one [README.md](README.md) describes: the reference jobs keep the atlas and the scenarios fresh, and the scenario runs push into the explorer. Keep the jobs in shadow until four reviewed runs say they are ready.

## 9. Depending on flax from your own workspace

Every GitHub release of this repository (`gh release create vX.Y.Z --generate-notes`) publishes each package, built, on a tag of its own: `core-vX.Y.Z`, `contract-vX.Y.Z`, `agents-vX.Y.Z`, `atlas-vX.Y.Z`, `scenarios-vX.Y.Z`, `explorer-vX.Y.Z` and `cli-vX.Y.Z`. The release notes list the lines to paste. A workspace depends on them as git dependencies, so no registry is involved:

```json
"dependencies": {
  "@flax/cli": "git+https://github.com/spice-labs-inc/flax.git#cli-v0.1.0",
  "@flax/scenarios": "git+https://github.com/spice-labs-inc/flax.git#scenarios-v0.1.0"
}
```

The packages depend on each other the same way, so a pnpm workspace that installs them needs `blockExoticSubdeps: false` in its `pnpm-workspace.yaml`. The lockfile pins the commit each tag resolved to. While the repository is private, give git a token that can read it before installing, locally and in CI:

```sh
git config --global url."https://x-access-token:${TOKEN}@github.com/".insteadOf "https://github.com/"
```

The agents package writes that step into the workflows it generates when `flax.yml` names the secret (`agents.packagesTokenSecret`). The publishing itself is `scripts/publish-packages.sh`, run by the Release workflow when a release is published.

## Planned, as of the lane logs

- Packages on a registry (`npm install -g @flax/cli`); today they are installed from this repository's tags (section 9).
- `demo/agents/`, the demo copies of the reference jobs.
- A `flax scenarios` command that downloads scheduled runs' artifacts into the results layout; today the explorer service does that itself when `explorer.results` is set, and runs reach it by ingest otherwise.
- `flax scenarios local` and the recorder's command line.
