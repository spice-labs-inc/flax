# Contracts

A contract is a shape two packages agree on without sharing code: a data file one writes and another reads, an event one emits and another consumes, a status line one prints and another parses. flax publishes every one of them as a type file in `packages/contract` (or, for the sandbox, as the parser in the agents package), with one copy of each type where the private tooling had drifted into pairs. This page is the index: for each contract, the file that defines it and a short prose shape. The pages that use a contract explain it in context; this page only says what it is and where it lives.

## Surface files

Defined in [`packages/contract/src/index.ts`](../packages/contract/src/index.ts), written by the scenarios package's builders as `surface/<name>.json`, read by the coverage map and the explorer's data build.

A `SurfaceFile` has `surface`, `builtAt`, `sources` (every sighting the builder made, whether or not it produced items), `items`, `outOfScope` (a label and a reason each) and `notes`. A `SurfaceItem` has `id` (stable, `<surface>:<natural key>`), `label`, `surface`, `area`, optional `parent`, `envs` (the environments a scenario must cover it in), `seen` (sightings: an optional environment, a source that is a URL or a repository file at a commit, and `readAt`) and optional `details`. Environment and surface names are plain strings whose values come from the workspace.

## Run results and touches

Defined in the same file; written by `flax scenarios run` into `results/<env>/<run id>/`, read by the coverage map, the explorer's data build and the scheduled check job.

- `RunResult`: `env`, `runId`, `startedAt`, `finishedAt`, `versions` (what each service answered for its version), optional `parallel`, optional `cadence` (the cadence a `--cadence` run was started for), and `scenarios[]`. `currentRuns(runs, cadenceOf)` picks the runs that speak for one environment now: its newest ordinary run and its newest run of each cadence.
- `ScenarioResult`: `id` (`<feature file>:<line>`), `name`, `feature`, `tags`, `status` (one of `passed`, `failed`, `skipped`, `undefined`, `pending`, `ambiguous`), `durationMs`, `touches[]`, optional `failure` (`step`, `message`, `at`: the step index, -1 a hook before the steps, -2 one after).
- `Touch`: `item`, optional `need` (which coverage need the touch proved, or a refusal proved beyond them), optional `step` (the step index; none for a touch outside the steps). Touches also ride in the runner's message stream as an attachment under the touches media type, `application/vnd.flax.touches+json` by default; a workspace with older results sets its own.
- `PlannedScenario`: `id`, `name`, `feature`, `tags`; written to `planned.json`.
- Conventions: `runIdPattern(envs)` and `makeRunId(env, startedAt)` define a run id as `<env>-<ISO time with : and . as ->`; `isScenarioId` and `surfaceOfScenarioId` define the scenario id shape and the surface it belongs to; `STATUS_CODE` maps each status to its one-character code.

## The explorer data files

Defined in the same file as `DATA_FILES` and one interface per file; written by the explorer's data build into `data/<version>/`, read by the page. `Manifest` (`version`, `builtAt`, optional `commit`), `CoverageFile` (with `envs` naming the order of every status string), `JourneysFile`, `HistoryFile` (snapshots with one character per item per environment), `ScenariosFile` (runs, scenario records, features), `ShotsFile` (screenshot id to image) and `BoardFile` (planned work with its open state). The field-by-field shapes are in [explorer/data.md](explorer/data.md). The usage file is a published shape with no writer in the package: the plug-in point for an organization's own usage aggregates.

## Live events and ingest

Defined in the same file; emitted by the explorer service on `GET /live/events` and consumed by the page; the ingest side is what `flax scenarios run` pushes.

- `LiveEventName`: `snapshot`, `run-started`, `scenario-started`, `scenario-finished`, `step-finished`, `run-finished`, `run-incomplete`, `data`, `heartbeat`.
- `RunSummary` (extends `RunMeta`): the run's environment, id, start, workers, scenarios commit, the code host's run and attempt, planned count; then `state` (`running`, `finished`, `incomplete`), `total`, `passed`, `failed`, `finishedCount`, `gap`, `lastMessageAt`, optional `finishedAt`.
- `LiveScenario` and `LiveScenarioDetail`: a scenario's live status (`running`, `retrying` or a scenario status), attempt, steps done and total, the step codes so far, and for the open scenario its steps with text, status and time, a message and a screenshot.
- Ingest: `POST /ingest/runs/<run id>/start`, `/messages`, `/finish`, bearer token, run ids in the runner's shape, batches numbered by sequence.

## Workspace configuration shapes

Defined in [`packages/contract/src/config.ts`](../packages/contract/src/config.ts): the shapes the scenarios package and the explorer read from the workspace's `scenarios` and `explorer` sections. `EnvConfig` (name, label, hosts by key, `excludeTags`, `fixtures` as `always`, `when-asked` or `never`), `SurfaceConfig` (name, title, `role` as `ui`, `service`, `site` or `other`, the environments it exists in, `singleHome`, `linkHost`, `kinds` naming, `pageKind` and `elementKind`, `islands`), `IslandSplit`, `KindNaming`, `CadenceConfig` (name, tag, the environments a run on that cadence runs in), `DatasetVocabulary` (persona types, stages, station kinds, editions) and the whole `ScenariosConfig`. The shared keys (`org`, `github`, `environments`) are the core package's `Workspace` in `packages/core/src/workspace.ts`.

## Run artifacts

Defined in [`packages/contract/src/run-artifacts.ts`](../packages/contract/src/run-artifacts.ts); written by the agents package's check job (`output.kind: results`), read by the explorer's code host fallback, a poller, or a person with the code host's download command.

- `resultsArtifactName(job, mode, env)`: `<job>-<env>` for a live run, `<job>-shadow-<env>` for a shadow run; `parseResultsArtifactName` recovers mode and environment given the job and the known environment ids.
- `RUN_RESULT_FILES` (`run.json`, `planned.json`, `messages.ndjson`), `MEDIA_MANIFEST` (`media.json`), `RESULTS_INDEX` (`index.json`); `RUN_ARTIFACT_FILES` is the whole list a reader keeps.
- `resultsRunId(workflowRunId, attempt)`: `<workflow run id>-<attempt>` on the code host, `local` elsewhere; `runDirectory(env, runId)`: `<env>/<run id>` under a reader's results directory, with `RUN_DIR_NAME` bounding both parts.
- `ResultsIndex`: `version: 1`, `job`, `env`, `shadow`, `run` (`id`, `at`, optional `workflowRun`, `reason`, `failure`), optional `checksFrom`, `builds`, `counts` per check status (`passed`, `failed`, `skipped`), `checks` (name to `CheckResult`: `name`, `status`, optional `detail`, `step`, `screenshots`). `isResultsIndex` and `readResultsIndex` tell a file this contract wrote from any other.

## The job and tool schemas

Defined in `packages/agents/schema/*.json`: `job.schema.json` (every `job.yml` field; see [agents/jobs.md](agents/jobs.md)), `tool.schema.json` (a tool's description, bounded argument schema, upstream and operations, result cap, source), `patch-set.schema.json` and `patch-set-tool-quotes.schema.json` (a pull request job's answer: per page, no change or a unified diff with evidence for every changed line), `media.schema.json` (the media manifest: `version`, `files` with path, size and sha256, `data`), `box.schema.json` (the sandbox pin), `gateway.schema.json` (the gateway settings), `mcp-servers.schema.json`, `link-hosts.schema.json` and `github-log-hosts.schema.json` (the allowlists). Unknown keys fail at every level.

## The gateway contract

Not a type file but five calls and a catalog shape the agents package depends on and the gateway package serves: `POST /key/generate`, `POST /key/block`, `GET /key/info`, `GET /team/info`, `GET /v1/models/info`, with the catalog fields `model_name`, `litellm_params.model` and `model_info` prices, token limits and thinking levels; and the one forwarded path, `POST /v1/messages`. See [agents/gateway.md](agents/gateway.md).

## The sandbox status grammar and probe lines

Defined by lbx and parsed in the agents package (`packages/agents/src/run-job/launcher.ts`). The agents package depends on exactly these:

- The status file `$LBX_STATE_DIR/runs/<name>/status` holds one line, `status=<setup-failed|timeout|signal|exited> code=<n>[ cleanup=incomplete]`, written on the host in a directory never mounted into a box, and it is authoritative; the last line on standard error, `lbx-run: status=... code=...`, is informational, and a refusal prints `lbx-run: status=refused code=125` and writes no file. The runner matches `^status=(setup-failed|timeout|signal|exited|refused) code=(\d{1,3})( cleanup=incomplete)?$`.
- Exit codes: a refusal or setup failure 125, a timeout 124, a signal 129, 130 or 143, otherwise the command's own code; `cleanup=incomplete` turns a 0 into 125.
- The probe: given `--socket-dir <dir>` or `--no-network` without `--run`, an lbx that has the flag answers `ERROR: --<flag> is only valid with --run.` and exits 1; an older one answers `ERROR: Unknown option: --<flag>`. The runner asks before creating anything and refuses to start on the wrong answer.
- The run box's contract: `--run --runtime docker --no-network --data <dir> --timeout <seconds> --socket-dir <dir> <name> -- <command>`, the data directory mounted at `/data`, the socket directory read-only at `/run/agent`, the command run as the box user in `/data`, standard output passed through unchanged, every lbx line on standard error.

See [lbx.md](lbx.md).

## Keeping contracts honest

A contract changes only with both sides in the same change and a note in the package's changelog. The data files carry a `version` where a reader needs to tell generations apart (`index.json`, the manifest), and every status string names its environment order in the same file, so a reader never assumes a count. History files built for another environment order are permuted on read (a missing environment reads as no scenario), so an older workspace keeps its timeline.

## To confirm against the package

- Whether `config.ts` stays in the contract package or moves beside the packages that read it.
