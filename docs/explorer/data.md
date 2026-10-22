# The explorer's data

The explorer page loads its data at run time from `/data/manifest.json` and the data version it names. Every file has a published type in the contract package, shared by the code that writes it (the scenarios package's data build, run by the explorer service) and the page that reads it, so the two cannot drift. This page lists every data file and its shape, the usage file as the plug-in point, and the run artifacts contract the service reads when it falls back to the code host. The type file is `packages/contract/src/index.ts`; the index of every contract is [../contracts.md](../contracts.md).

## The manifest and versions

`data/manifest.json` names the current data version (`version`, `builtAt`, and `commit` of the scenarios checkout when the service built it). The files live under `data/<version>/`, so a version is immutable and cacheable for a year while the manifest is never cached; the page reads the manifest, then the files of that version, and on a `data` event from the service reloads in place.

## The data files

`coverage.json`: the items and the surfaces.
- `builtAt`; `envs`, the environment ids in the order every status string is written (the page used to assume three; it reads this now).
- `surfaces[]`: `island`, `surface`, `title`, `areas`, `features`, `items` (a count), `notes`, `outOfScope`.
- `items[]`: `id`, `label`, `surface`, `area`, `envs`, `status` (a partial record of environment to `uncovered | planned | failing | passing`), `kind`, optional `page` and `component` (the sub-map parent and its part), `parent`, `usedBy` (persona ids), `needs`, `documents` (documentation source ids), `links` (an optional environment and a URL), `edition`, `laterFailed` and `unchecked` per environment.
- `documentation[]`: `id`, `kind` (`readme` or `internal-doc`), `title`, `url`, `documents` (item ids).

`journeys.json`: the persona dataset after the join.
- `commit`, `coverageMapBuiltAt`; `personas[]` with every persona field (extra fields kept as read); `stations[]` as `key`, `name`, `stage`, `kind`, `items` (the resolved ids); `journeys[]` as `persona` and `stations`; `orphans` (items on no journey); `broken` (a station whose matchers matched nothing) and `deadMatchers`.

`history.json`: the timeline.
- `builtAt`, `scenariosCommit`, `envs`, `itemCount`; `scenarios[]` (id, name, feature, `stepped` when step detail exists); `itemScenarios` (item id to scenario indexes); `itemSteps` and `itemNeeds` (item id to, per scenario, the step indexes and needs that touched it); `planned[]` (id, name, feature, surface, envs, `waitingOn`).
- `snapshots[]`: one per run: `at`, `env`, `runId`, `ran` (scenarios, passed, failed), `runs` (a count per environment so far), and three strings with one character per item in `envs` order: `status`, `scen` and `planned`.

`scenarios.json`: the catalog and every run's record of every scenario.
- `runs[]`: `env`, `id`, `startedAt`, `finishedAt`, `versions[]` (`service`, `release`, `builtAt`), `scenariosCommit`, `workflowRun`, and `cadence` for a run started for one.
- `scenarios[]`: `id`, `name`, `feature`, `tags`, `description`, `steps[]` (keyword, text, background flag, doc string, table), `applies` (the environments a scheduled run runs it in), `records` per environment: `run` (an index into `runs`), `status` (one character: `p` passed, `f` failed, `s` skipped, `u` undefined, `n` pending, `a` ambiguous), `ms`, `codes` (one character per step), `stepMs`, `failure` (`at`, `message`, `step`), `steps`, `logs` (keyed by step index as a string), `shot`.
- `features[]`: `file`, `surface`, `name`, `description`, `tags`, `scenarios[]` (id, name, tags, line).

`shots.json`: a record of screenshot id to its data URL or path.

`board.json`: planned work from the issue tracker.
- `readAt`, `checkedAt` (when the open state was last re-read), `source`; `items[]` (`id`, `label`, `surface`, `area`, `status`, `personas`, `url`, `state` as `open | closed | unknown`); `bugs[]` (the same five base fields). The workspace's `board.json` lists the issues; each data build re-reads whether they are still open. The file is optional: without it the planned door shows only written-but-waiting scenarios.

Every one of these is listed in `DATA_FILES` in the contract, and a data build writes all of them or none.

## The usage file: the plug-in point

`usage.json` is not built by the package; it is the plug-in point for an organization that has real usage aggregates. Its contract: per API item and per area, requests since a cutover date and over the whole window, distinct organization counts, caller-kind counts and requests on legacy paths; the organization's own synthetic traffic, crawlers and browser tests already left out; staff use kept apart under its own counts so the view can add it back. Only aggregate counts, never an organization id or name. Given to the data build with `--usage <path>` (or an environment variable), it lights the usage view; absent, the view is hidden. A file without staff counts still works, without the staff choice.

## The live stream and ingest

The service's `GET /live/state` and the `snapshot` event carry one `RunSummary` per run: the run's `env`, `runId`, `startedAt`, `workers`, `scenariosCommit`, the code host's run id and attempt when there is one, `planned`, then `state` (`running | finished | incomplete`), `total`, `passed`, `failed`, `finishedCount`, `gap` (messages were lost), `lastMessageAt`, `finishedAt`. Scenario detail carries `id`, `name`, `status` (`running`, `retrying` or a scenario status), `attempt`, `done`, `steps`, `codes`, `startedAt`, `durationMs`, `failure`, and for the open scenario its step list with each step's text, status and time, a message and a screenshot.

The event names: `snapshot`, `run-started`, `scenario-started`, `scenario-finished`, `step-finished`, `run-finished`, `run-incomplete`, `data`, `heartbeat`.

Ingest takes a run id in the runner's shape (`<env>-<ISO time with : and . as ->`, which the contract's `runIdPattern(envs)` and `makeRunId` define) and the runner's message stream, deduplicated by sequence number.

## The run artifacts contract

When the service falls back to the code host, or a person downloads a run by hand, the files come from the artifact the scheduled job uploaded. That contract is `packages/contract/src/run-artifacts.ts`:

- The artifact name: `<job>-<env>` for a live run, `<job>-shadow-<env>` for a shadow run, so the two never mix; `parseResultsArtifactName` recovers the mode and environment given the job and the known environment ids.
- The files: the run's own `run.json`, `planned.json` and `messages.ndjson` unchanged, the media manifest `media.json` (the files, their hashes, and `data` with every check's result), and the run index `index.json`. A reader keeps these and ignores the rest.
- The run id: `<workflow run id>-<attempt>` on the code host, `local` anywhere else; a reader keeps a downloaded run under `<results dir>/<env>/<run id>/`.
- `index.json`: `version: 1`, `job`, `env`, `shadow`, `run` (`id`, `at`, `workflowRun`, `reason` for a run started by hand, `failure` for a run with no results of its own), `checksFrom` (the run whose checks these are when not this one), `builds` (service to version, flat strings), `counts` (passed, failed, skipped), `checks` (name to `name`, `status`, `detail`, `step`, `screenshots`). `readResultsIndex` parses one and returns nothing for anything else.

## Where the files come from

The scenarios package's data build reads `surface/*.json`, the dataset, the feature files and the results directories, and writes every data file into `data/<version>/`. The explorer service runs that build in a worker thread when a run finishes, then swaps the manifest. `flax explorer build` runs the same build locally and bundles the single-file page from it; `--no-fetch` uses the results already on disk.

## To confirm against the package

- The exact file names of the data build's output and whether `shots.json` keeps data URLs or paths in the first version.
- The usage file's field names, which the first version publishes as a type without a writer.
