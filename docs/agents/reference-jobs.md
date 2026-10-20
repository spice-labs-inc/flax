# Reference jobs

The agents package ships seven jobs. Two prove the path end to end (`hello`, `tools-proof`); three keep an atlas fresh (`atlas-doc-refresh`, `atlas-map-refresh`, `atlas-wiring-eval`); two keep a scenario library fresh and running (`scenario-checks`, `scenario-watch`). They are generic given a workspace: each needs the repositories, channels and secrets the workspace names and nothing else. This page says what each does, what it needs and what it delivers. The demo workspace carries copies of them pointed at notes-co's repositories.

## hello

Summarizes a short piece of text, to prove the job kit end to end. Manual trigger, a cheap model, a shell, a small turn and token limit, no tools, `output.kind: file`. Its fixture input is a paragraph and its fixture answer a summary. It is the job to copy from, and the one to run first: `flax agents run-job hello --stub` offline, then a real run once the gateway or the static provider is configured. Needs nothing beyond the model path.

## tools-proof

Answers a few questions that only the tools can answer, one per upstream, to prove the tools path end to end: the model must call each listed tool and quote its result. Manual trigger, `output.kind: file`, with `tool_calls` and `tool_seconds` set low. The demo version lists the echo tool and a code host tool; a workspace adds one tool per upstream it runs. Needs the secrets of its tools' upstreams in the workspace repository. A stub run proves the tools server starts with no upstreams; a real run proves each credential, each upstream and the socket.

## atlas-doc-refresh

Finds atlas pages whose repository moved past the commit they describe and proposes minimal, evidence-backed updates for up to three of them a run, for a person to review. Scheduled every other day. `collect.ts` reads, through its own tools server, the commits since each page's `analyzed_commit`, filters the drift that is only automation noise (pin bumps, generated data) and bumps `analyzed_commit` for those mechanically as a stamp, then gives the model the first three drifted pages by name with their section files, the commits in between and the changed files at their commits. The model's file tool reads each repository at the commit the input names (`pin_files: true`), so it never quotes a file as the default branch has it later. The answer is a patch set with a citation for every changed line; `frontmatter_keys` lets the model change a few frontmatter values with evidence, and `stamp_keys` reserves `analyzed_commit` for the job's code. The pull request goes to the atlas repository on `agent/atlas-doc-refresh/<day>` after the citation check, the attribution check and the second check; the job merges it itself only when the change touches repository pages alone, and leaves a change to the index, the architecture page, the glossary or the gaps page open for review. It proposes nothing while its own pull request is open. Needs: the atlas repository in the repositories allowlist, the reader app for files and commits, the writer app for the pull request, and the regeneration workflow in the atlas repository that keeps generated content current on its branches. See [../atlas/method.md](../atlas/method.md).

## atlas-map-refresh

Refreshes the atlas map's data and opens one pull request with the regenerated map. `model: none`: no sandbox, no prompt. Its `media.ts` checks out the atlas repository, clones every documented repository beside it (sparse and shallow) so the deployment and manifest stages see real checkouts, and runs the atlas's refresh script with `--reextract-changed`: new pages and pages whose wiring sections changed since their cached answer ask the model, at most six a run, through the media model socket (`media.model` with a `fallback` model, a dollar a run, `optional: true` so the refresh still runs from the cache when the month is spent); every other page keeps its cached wiring. The script's guards stay: no publish when a curated flow step stops resolving, when any edge layer shrinks by more than a fifth, or when the gitops checkout is missing. The changed data files and new cache answers go in one pull request through `media.pr_paths`, which the job merges itself when every changed path is under the map's data and cache folders (`auto_merge.paths`); the atlas repository's deploy workflow publishes the site on merge. Needs: the atlas repository as a media source and in the repositories allowlist, a read token for the documented repositories, and the writer app. See [../atlas/wiring.md](../atlas/wiring.md).

## atlas-wiring-eval

Re-extracts the wiring of a sample of atlas pages with a candidate model and compares its edges with the cached answers the map uses, page by page. Manual trigger, `model: none`, a media stage with the atlas as a source and a `media.model` naming the candidate, a dollar a run. It reads the cache and never writes it, so nothing in the map changes. The report holds, per page, the edges both agree on, the extra ones only the candidate drew and the missing ones only the cached answer has, with precision and recall over all pages, then every disagreement. Extra edges are the ones to check against the page: one the page does not state is invented. Run it with one model per run before changing the wiring model.

## scenario-checks

Runs the scenario library against one environment, keeps the results as a workflow artifact, and says which checks started or stopped failing. `model: none`, `output.kind: results`, `trigger.envs` with one cron per environment from `flax.yml`, staggered so about one run an hour lands across environments. A deploy may start a run of its own by dispatching the workflow with the environment and a one-line reason. The workflow finds the previous run's artifact for the same job, environment and mode with the workflow's own token, downloads it, installs what the media stage lists in `setup`, checks out the scenarios repository, joins the private network when the environment needs it, and runs `flax scenarios run --env <env> --fixtures --parallel <n>` with the explorer's URL and ingest token so the explorer shows each scenario start, pass and fail within seconds. The media manifest carries the run's `run.json`, `planned.json` and `messages.ndjson` and, in `data`, every scenario as a check with its id, status and the first line of why it failed, plus the builds it ran against. The results output kind writes `index.json` and compares it with the previous run's: a check that passed there and fails now, or the reverse, goes in one message to the `alert` channel (live) or the shadow channel; a first run, a new check, a skipped check and a check already failing never alert. Everything is uploaded on every path under the artifact name the run artifacts contract defines. Needs: the scenarios repository as a media source, the mailbox and ingest secrets the scenarios need, the explorer's URL. See [../scenarios/runner.md](../scenarios/runner.md) and [../contracts.md](../contracts.md).

## scenario-watch

Keeps the scenario text (names, steps, narration where scenarios are recorded) true to the product, as pull requests with the smallest evidence-backed edits, twice a week. A model job with no tools for the model and a long list of `collect_tools`: `collect.ts` reads the merged pull requests, releases, commits and files of the product repositories since the last run and gives the model the scenario files with the evidence of what changed. The answer is a patch set, checked and second-checked like any pull request job's. Needs: the scenarios repository and the product repositories in the allowlist, and the reader and writer apps.

## What every reference job needs from the workspace

- The repositories it reads or writes, in the repositories allowlist, under the workspace's GitHub owner.
- The channels it posts to, in the channels allowlist with their ids once live.
- A model in the models file with prices and levels (or `none`).
- A reader app for files and commits, a writer app for pull requests, the gateway issuer key or a static provider key, and the secrets its media stage names, as repository secrets.
- At least four reviewed shadow runs before `mode: live`.

## To confirm against the package

- The exact schedules, limits and tool lists the public copies carry.
- Which secrets each demo copy names, and the names of the reader and writer apps in a flax workspace.
