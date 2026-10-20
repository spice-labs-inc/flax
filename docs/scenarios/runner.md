# The runner

`flax scenarios run` runs the feature files against one environment, records what each scenario touched, writes a results directory in a published format, and, when asked, pushes its progress into the explorer as it goes. This page covers the environments and hosts, the tag policy, fixtures and parallel workers, the results format, the live push, and how results get back for the coverage map.

## Environments and hosts

A run targets exactly one environment: `flax scenarios run --env test`. The environment ids are the ones `flax.yml` lists; the scenarios section gives each environment its hosts by key (`api`, `web`, `admin`, and whatever a step needs), the tags it never runs, and its fixture policy. Steps reach a host through the world by key, never by a literal, so a feature file reads the same in every environment. A run records at its start what each service answered for its version, so every result says which build it ran against.

Requests to your services carry an identity header and a user agent the workspace names, so the service can count them as synthetic rather than customer use; in a browser only requests to your own hosts get it, since third parties refuse it cross-origin.

## The tag policy

What runs where is one declarative policy per environment in the workspace, not a scattering of conditions:

- `excludeTags`: tags a scheduled run never runs in this environment (an internal admin surface's tag on the reference environment, for instance). The runner skips them, the explorer explains them in the same words, and `tagLabels` gives each tag a phrase.
- `fixtures`: `always` (runs create fixtures here and the page assumes so), `when-asked` (only a run started with `--fixtures`, so the page assumes it only after seeing one) or `never` (the runner refuses `--fixtures`).

Beside the policy, tags on scenarios say what each one needs:

- `@env:<id>`: run only in those environments.
- `@fixture`: creates a fixture organization; runs only with `--fixtures`.
- `@dispatch`: starts a workflow run on the code host; runs only with `--dispatch`, which needs a token that can.
- `@serial`: never at the same time as another serial scenario.
- `@planned`: listed, never run.
- `@local`: runs the product on this machine with no services; a scheduled run never picks it up (see [recorder.md](recorder.md)).

`--dry-run` checks that every step is defined without running anything. `--tags` narrows a run to an expression.

## Fixtures and writes

Writes go only through fixture identities: the API client refuses any write signed by another token. A fixture organization comes from the service's own test-fixture endpoints; one serves every scenario of a run (of a worker, in a parallel run), each scenario undoes its own changes, and the organization is torn down when the run ends. Scenarios that create a fixture are tagged `@fixture`; one that is unreasonable in the reference environment (signing up, deleting an organization) is also limited by `@env:` tags. Signed-in scenarios read a mailbox the workspace names from the environment or a gitignored `.env`.

`--parallel <n>` runs scenarios in `n` worker threads. Each worker makes its own fixture organization and seeded projects, installs its own copy of any CLI under test, and tears its fixtures down at the end; keep `n` small, since every fixture organization costs the service something. Serial and dispatch scenarios never overlap each other.

## The results format

Each run writes `results/<env>/<run id>/`:

- `run.json`: the run (`env`, `runId`, `startedAt`, `finishedAt`, `versions`, `parallel`) and every scenario's result: its id (`<feature file>:<line>`), name, feature, tags, status (`passed`, `failed`, `skipped`, `undefined`, `pending`, `ambiguous`), duration, its touches (item, need, step index), and for a failure the first failing step, its message and its index (-1 for a hook before the steps, -2 for one after).
- `planned.json`: every planned scenario (id, name, feature, tags).
- `messages.ndjson`: the test framework's own message stream, which carries every step's result and timing, attachments (screenshots, logs) and the touches as an attachment with the touches media type.

The run id is `<env>-<ISO time with : and . replaced by ->`, so run directories sort by time and a reader can tell the environment from the name. The types are in the contract package; see [../contracts.md](../contracts.md).

`flax scenarios coverage --results <dir>` writes statuses per environment from the runs in a results directory. The explorer service downloads the scheduled runs' artifacts into that layout itself when `explorer.results` names the workflow; a `flax scenarios` command that does the same for a local checkout is planned, and until then a person downloads an artifact with the code host's own tool.

## The live push

With the explorer's URL and ingest token set in the environment, a run pushes its progress as it goes: `POST /ingest/runs/<run id>/start`, then batches of messages to `/messages`, then `/finish`. The push never fails, slows or changes a run: each request gets three seconds, failures back off from five to sixty seconds and stop after five minutes, the queue holds at most 20,000 envelopes or 16 MB, and the last flush gets at most ten seconds. Without the variables, and in a dry run, it pushes nothing, and the explorer still gets the results from the artifact the scheduled job uploads. Open explorer pages show each scenario start, pass and fail within seconds of it happening, with the hex of a running scenario breathing on the map.

## The scheduled run

The agents package's `scenario-checks` job is the scheduled runner: one cron per environment, the previous run's artifact downloaded for comparison, the run itself as a media stage, the results uploaded under the run artifacts contract, and one alert message when a check starts or stops failing. See [../agents/reference-jobs.md](../agents/reference-jobs.md). A deploy can start a run of its own with a reason, so the results of a fresh build show up on the explorer's timeline with the deploy that caused them.

## Checks on the library itself

`flax scenarios check` type-checks the steps, formats, runs the unit tests and the dataset validation, and in CI a dry run proves every step is defined. The coverage command's gaps file is the honest part: it is regenerated on every run and it names every item nothing proves.

## To confirm against the package

- The environment variable names for the explorer URL and ingest token (the runner's own variables carry the workspace's `envPrefix`).
- `flax scenarios check` as a subcommand: today the package has `run`, `coverage` and `dataset`, and the checks run through the workspace's own scripts.
