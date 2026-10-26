# @flax/contract

The shapes the flax packages agree on, in one place, with no code that reads or writes a file.

- `@flax/contract`: the scenario side. `SurfaceFile` and `SurfaceItem` (what a surface builder writes and a scenario touches), `Touch`, `RunResult` and `PlannedScenario` (what a run writes), the explorer's data files by name (`DATA_FILES`: `coverage.json`, `journeys.json`, `history.json`, `scenarios.json`, `shots.json`, `board.json`, with `CoverageFile`, `HistoryFile`, `Snapshot`, `BoardFile`, `Persona`, `Manifest`), the live run summary the service shows, run ids (`makeRunId`, `runIdPattern`), the status code table, and `usage.json` (`UsageFile`, aggregates only).
- `@flax/contract/config`: `ScenariosConfig`, what `@flax/scenarios` reads from a workspace's `flax.yml` after defaults, and what the explorer page is built with.
- `@flax/contract/usage`: the usage plug-in (also exported from the root): the classes of use, what a workspace's relay posts (`UsageWindow`, `UsageHistory`), the live stream's `UsageLive`, `UsageFile`, and their checks.
- `@flax/contract/run-artifacts`: what a scheduled run publishes as a workflow artifact and how a reader keeps it (artifact names, the run index, run directory naming), shared by `@flax/agents` and the explorer's GitHub fallback.

Environments and surfaces are plain strings everywhere; their order and names come from `flax.yml`, and the first environment is the reference environment.
