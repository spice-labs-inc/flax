# How runs work

Where a Notes Agent run executes, what it may spend, and how the box,
the model gateway and the pinned image fit together. The README has the
short version.

## Where jobs run

`flax agents generate` turns each `job.yml` into a GitHub Actions workflow,
`.github/workflows/job-<name>.yml`. The workflow runs on the `agents`
pool-a pool (Firecracker runner VMs), with read-only access to this
repository and its packages, a timeout derived from the job's turn limit,
and one run at a time per job. A job starts on its cron schedule, after
another job succeeds, or by hand; every job can also be started by hand from
the Actions tab.

A run checks the job, pulls the pinned agent image, and starts Pi (the
coding agent) inside the box with `lbx --run`: no terminal, no network at
all (the model and the tools only through the runner's sockets, see
[Socket transport](#socket-transport)), and a fresh data directory holding
the prompt, the input and the schema. The answer is validated against
`output.json`. The answer and a report (the input, the answer, every tool
call and model call, Pi's transcript, timings, the maintainer notes) are
kept as the run's artifact, `job-<name>-report`, for 90 days, and the
maintainer notes alone as `job-<name>-maintainer-notes` (see
[Maintainer notes](#maintainer-notes)).

A job with `model: none` (output kind youtube, output kind pr with
`media.pr_paths`, or output kind file, which delivers nothing) runs no model: its workflow pulls no image, checks out no
box and gets the gateway issuer key only when `media.model` asks for a media
key, and the runner builds the answer itself and delivers it (see
[YouTube delivery](media.md#youtube-delivery)). It has no turn limit, and no budget
but its media key's; its workflow times out after 30 minutes plus its media
stage's time.

The workflow installs nothing. It sets up Node and runs the runner bundle
committed in `dist/`: `node dist/run-job.mjs <name> --preflight`, then
`node dist/run-job.mjs <name>` in the one step that gets the secrets. No
`pnpm install` and no tsx run anywhere in the job.

- `dist/run-job.mjs` is the runner in one ES module: run-job, the tools
  server, every `tools/<name>/map.ts` and the runtime dependencies (the MCP
  SDK, the Kubernetes and Slack clients, ajv, yaml, Prettier's YAML and
  Markdown printers). It imports only Node's own modules.
- `dist/jobs/<name>/media.mjs`, `collect.mjs`, `render.mjs` and
  `publish.mjs` are each job's `media.ts`, `collect.ts`, `render.ts` and
  `publish.ts`, bundled the same way. The runner runs them
  with plain `node`, still as their own processes without any credential.
- `dist/manifest.json` has the sha256 of each bundle and of every file they
  were built from, `pnpm-lock.yaml` included.

`flax agents generate --dist` rebuilds `dist/`, and the same sources and lockfile
give the same bytes on every machine. Pull requests never change `dist/`:
the Check workflow fails one that does, so two pull requests never conflict
there. After each push to main the Rebuild dist workflow
(`.github/workflows/rebuild-dist.yml`) installs, runs `flax agents generate --dist`
and, when `dist/` changed, pushes it to main as its own commit,
`Rebuild dist for <commit>`. Two merges in a row rebuild one after the
other, the second from the newer main. `flax agents check` only checks that the
bundles build, and the tests build their own.

Before every run the bundled runner checks the manifest against the tree it
runs in and refuses to start when something changed since the build. So in
the minute or two between a merge that changes the runner, a tool mapping
or a job script and the rebuild landing, a run of an affected job stops at
its preflight with "dist/ is rebuilt on main after each merge"; run it
again once the Rebuild dist run is done. A merge that changes only
`job.yml`, prompts or docs leaves the bundles valid. `dist/` is committed
rather than published as a release asset so that a run executes the code of
the commit it checks out, with nothing to download or pin by hand. To run a
branch whose bundled code differs from main, commit the output of
`flax agents generate --dist` on it for the trial and drop it before the pull
request is ready (`git checkout origin/main -- dist`). Locally,
`flax agents run-job` still runs from source with tsx.

## Budget

`limits.usd_per_month` in `job.yml` is a whole number of dollars, and
`flax agents check` holds all jobs together to at most $175 a month. Before each
run, `flax agents run-job` checks the job's month-to-date spend plus the run's worst
case (every token of `limits.tokens_per_run` at the model's higher price
from `models.yml`) against the job's limit. Month-to-date spend is read
from the model gateway, and the worst case is a hard cap on the run (see
[Model gateway](#model-gateway)). Stub runs and `--preflight` reach no
gateway, so they check only the worst case.

## Thinking level

Every `job.yml` sets `thinking`, and every run passes it to Pi as
`--thinking`, so no run depends on Pi's default. Pi takes `off`,
`minimal`, `low`, `medium`, `high`, `xhigh` and `max`. The Acme provider
plugin maps each to an effort level the model lists in its
`/v1/models/info` entry (Pi `xhigh` sends effort `max`) and marks the rest
unsupported, and Pi then quietly moves an unsupported level to the next
supported one up (down when there is none higher). That is how Pi's default,
`medium`, became `high` on the Acme models, none of which lists
`medium`. So `thinking` in `models.yml` lists the levels each model honors,
and `flax agents check` and `flax agents run-job` refuse any other; a model without the
list takes any level Pi takes.

A run started by hand can pick another level in the Run workflow form (the
levels any usable model takes, the job's own by default), or locally with
`flax agents run-job <name> --thinking <level>`. The level is recorded in the
report's `status.json` and `summary.md`. The forwarder passes Pi's `thinking` and `output_config` fields on unchanged,
and the plugin reads each model's levels from the gateway's catalog, so the
catalog must list the same levels as `models.yml`.

## Maintainer notes

Every run can also tell the people who maintain the job what got in its
way, without any job asking for it. The runner adds an optional
`maintainer_notes` property to the schema it gives Pi (the job's
`output.json` itself is unchanged), and the preamble explains it: at most 5
items, each a `kind` (`missing_data`, `missing_tool`, `unclear_prompt` or
`limit_hit`) and a `text` of at most 300 characters.

When the answer comes back, the runner takes `maintainer_notes` off it
before anything else reads it: the job's output check, `answer.json`,
`render.ts` and the quote check all see the answer without the notes. The
notes go into the report as `maintainer-notes.json` and a list in
`summary.md` (which also shows on the run's page), and, alone, into a
second artifact, `job-<name>-maintainer-notes`, kept 90 days. They are
kept when the answer fails its check too, and never posted anywhere. Notes
that do not match their schema are dropped with a warning in the log,
`status.json` and `summary.md`; they never fail a run. They are model text:
capped by the schema, scrubbed like every report file, and escaped when
written into `summary.md`.

The `maintainer-notes-summary` job reads the last week of notes of every
job, each Monday, through the `gh-maintainer-notes` tool, and suggests a
short, ranked list of changes per job, each citing the runs it came from.
It changes nothing itself.

## Reading the answer

The answer is the model's final message, read as one JSON value. A code
fence around it, prose with one `json` code block, or prose followed by JSON
that runs to the end is accepted too. When the message starts with a
complete JSON object or array and goes on with text that holds no second
one, such as the broken tail of an earlier draft, the runner keeps the
first value and ignores the rest, with a warning in the log, `status.json`
(`answerWarning`) and `summary.md` saying how many characters were ignored
and how they start. A second complete value after the first, or prose
before the JSON with more text after it, is refused: which one is the
answer would be a guess. The kept value goes through every check, as any
other answer. See
[the guardrail](guardrails.md#the-final-answer-is-one-json-value).

## Repair turn

An answer that is not JSON, or does not match the job's `output.json`,
gets one more turn before the run fails. Pi continues the run's own
session in a new box on the same data directory, sockets, tools and
gateway key, so it still has everything it read, and gets only the exact
problems (with the size of each value over a length or count limit) and
the request for the complete corrected answer. The turn has what the
writer left of the run's time limit, at most 10 minutes, and spends from
the same per-run budget. It gets no time of its own because the run key
already lives as long as the gateway allows for the longest job. Its
answer goes through every check the first one would have, the PR checker
and second check included. If it still does not match, the run fails as
before, the failure saying the repair turn did not fix it. The report
keeps the first answer as `answer.txt` and the turn under `repair/`
(`prompt.md`, `argv.json`, `answer.txt`, `transcript/`); `status.json`
and `summary.md` say what was wrong and whether the turn fixed it. See
[the guardrail](guardrails.md#an-answer-that-fails-its-schema-gets-one-repair-turn).

## Socket transport

Every run gives the box no network at all: lbx runs it with `--no-network`
(only a loopback interface) and mounts one directory the runner owns,
read-only, at `/run/agent` (`--socket-dir`). The runner serves two Unix
sockets there, and they are the box's only way out:

- `model.sock`: the model forwarder (`src/run-job/forwarder.ts`). It sends
  the box's calls to the model gateway with the run's own key (see
  [Model gateway](#model-gateway)): the runner holds the key and adds it
  outside the box, forces the run's model, caps `max_tokens`, passes only
  `POST /v1/messages` and the model's catalog entry, and records every
  call in `forwarder.json`.
- `tools.sock`: the model's tools server, an MCP server speaking one
  JSON-RPC message per line (requests up to 64 KB, replies up to 256 KB, at
  most `3 x tool_calls + 50` messages over the run, one connection per
  box; the repair turn's box gets a new session on the same socket, with
  the same calls, limits and record). Every
  message goes into the report under `socket/in/` and `socket/out/`. A job
  without tools gets no `tools.sock`. The tools of `collect.ts` stay on
  their own mailbox in the run directory: `collect.ts` runs on the runner,
  never in the box, so a socket would change nothing about what the box
  can reach.

In the box, the Pi plugin (`images/agent/pi-mcp-mailbox/`) does both ends.
The Acme provider calls the model with `fetch()` on `ACME_BASE_URL`, and
`fetch()` cannot dial a Unix socket, so the plugin runs a small shim on
`127.0.0.1:18080` that passes each connection byte for byte to
`/run/agent/model.sock`; Pi is started with
`ACME_BASE_URL=http://127.0.0.1:18080` and a placeholder
`ACME_API_KEY=held-by-the-runner` (Pi refuses to call a provider with no
key; the forwarder drops whatever the box sends). The plugin is loaded
before the Acme provider, so the shim listens before the provider's first
call. It connects to `/run/agent/tools.sock` for the tools when it is
there.

The socket directory is created fresh for each run, mode 0700, in
`$XDG_RUNTIME_DIR` when it is set, else in `/dev/shm` (the agents pool's
runner has no login session and so no runtime directory), else in the run
directory; the runner checks lbx's rules itself before lbx starts (owned by
the runner user, not group or other writable, not a link, outside the
home, data, state and configuration directories, not containing the user
runtime directory, only the runner's own sockets inside, no `,` `"` or
newline, and a socket path short enough for Linux). It is removed when the
run ends, on every path, including an exit or a signal outside the box's
own run.

**The pinned lbx.** The lbx at `box_commit` must have `--socket-dir` and
`--no-network`. Before anything is created, a real run asks the lbx on
`PATH` whether it has both flags (given one without `--run`, an lbx that
has it answers "only valid with --run", an older one "Unknown option") and
refuses to start if it does not. `--apparmor-profile` is never passed: the
agents pool's kernel does not mediate Unix sockets, where lbx refuses it.

## Model gateway

The model gateway is LiteLLM on hosta, deployed from app-gitops
(`apps/hetzner/hosta/llm-gateway/`, whose README covers the stack itself).
It holds the real model keys (Acme, and Anthropic for the Claude models),
and hands each run its own short-lived key. Every run reaches its model
through it, and a real run goes like this:

1. The run step holds `LLM_GATEWAY_ISSUER_KEY` and no model provider key.
   The issuer key reaches the runner process alone, never lbx, the box,
   `collect.ts` or `render.ts`.
2. The runner reads the month's spend from the gateway (below) and refuses
   the run when the job's spend plus the run's worst case passes
   `usd_per_month`, or when all jobs together would pass the gateway team's
   monthly budget (set in app-gitops apps/hetzner/hosta/llm-gateway).
3. Right before the box starts, it asks the gateway for a key for this run
   alone: only the run's model, a budget of the run's worst case (the
   gateway refuses any call once the key has spent it, so at most one call
   over), valid for the box's timeout plus 10 minutes, at most 2 calls at a
   time and 60 a minute, and the alias `agents/<job>/<YYYY-MM>/<run name>`.
4. The box holds no key at all. Pi reaches the model through the runner's
   forwarder (`src/run-job/forwarder.ts`), an HTTP server on the model
   socket ([Socket transport](#socket-transport)): it passes on only
   `POST /v1/messages` (and the catalog entry of the run's model), forces
   the run's model, caps `max_tokens` at `tokens_per_run`, drops every
   header the box sends (its own credentials included) and adds the run's
   key. Every request and reply goes into the report as `forwarder.json`.
5. When the box ends, on every path, the runner stops the forwarder,
   blocks the key and, after the gateway's 10-second spend write, reads what
   the key spent. The report and the step summary show the key's alias, id
   (its sha256), budget, spend and whether it was blocked, never the key.

Only the runner talks to the gateway, at the internal address in
`gateway.yml` (`url`); the gateway has no public name and no port open to
the internet. The runner trusts only the gateway's private CA root,
committed as `gateway-ca.pem`, and checks the certificate against
`server_name`. `flax agents check` fails unless the CA file holds a valid,
unexpired CA certificate and nothing else.

**Month-to-date spend.** The issuer key may issue, block and read single
keys, and read its team, but may not list keys (`/key/list` needs a key tied
to a user). `/team/info` returns the team's spend and budget and every key
of the team with its alias and spend, and blocked or expired keys keep
their spend. So a job's month is the sum of `spend` over the keys whose
alias starts with `agents/<job>/<YYYY-MM>/`, read in one call before each
run; the kit keeps no ledger of its own. Keys are never deleted by the
kit (the issuer key cannot), so `/team/info` grows by one key per run; old
months' keys can be deleted on the gateway's admin site when it gets large.
Spend is LiteLLM's estimate from token counts and the prices in its
configuration; the provider's own balance remains the true limit.

**Models.** Pi reaches every model in `models.yml`, the Acme and the
Claude ones alike, through the Acme provider plugin as `acme/<name>`,
and the gateway routes by name (the part after the slash in `models.yml`).
The gateway's model list and its `/v1/models/info` catalog must list each
name, with the same prices and thinking levels as `models.yml`. A model
marked `confirmed: false` (a placeholder whose id or prices are not
confirmed) cannot be used at all.

| What happens                                         | What the run says                                                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| gateway unreachable                                  | fails before anything starts: "the model gateway at `<url>` is unreachable (`<cause>`)", "the job did not start"             |
| wrong CA or certificate not for `server_name`        | fails before anything starts: "presented a certificate the pinned CA root does not vouch for"                                |
| issuer key refused                                   | fails before anything starts, naming `LLM_GATEWAY_ISSUER_KEY`                                                                |
| issuing the key fails (for example team over budget) | fails before the box starts, with the gateway's message                                                                      |
| job or team over its monthly budget                  | refused before any key is issued, with the spend and the limit                                                               |
| worst case over the gateway's key ceiling            | refused before any key is issued (`key_max_usd`, `key_max_minutes` in `gateway.yml`, which mirror the gateway's own ceiling) |
| per-run budget reached                               | the gateway refuses the next call and Pi fails; the run fails                                                                |
| blocking the key fails                               | the run is marked incomplete and fails, the answer kept; the key still expires on its own                                    |
| reading the key's spend fails                        | noted in the report; the run is not failed                                                                                   |

### Gateway settings

The gateway side is in app-gitops `apps/hetzner/hosta/llm-gateway/README.md`.
What this repository holds must match it:

1. Address: `url` in `gateway.yml` is the internal address runner VMs
   reach the gateway at, and `server_name` the name its certificate is
   issued for (both in the stack README's Network section). Check from any
   pool-a job:
   `curl -sf --cacert gateway-ca.pem --connect-to <server_name>:<port>:<address>:<port> https://<server_name>:<port>/health/liveliness`.
2. CA root: `gateway-ca.pem` is the root the stack README's "The CA root
   for agents" section exports; replace it only if the stack's CA is
   ever created anew.
3. Ceilings: `key_max_usd` matches `max_budget` in the stack's
   `upperbound_key_generate_params`; `key_max_minutes` is this
   repository's own limit on each run key (the stack's `duration` ceiling
   is 90 days, the issuer key's lifetime). The stack lists every model in
   `models.yml` a job may use through it, with the same prices.
4. Issuer key: `bootstrap.sh --issue-runner-key` on hosta (stack README),
   stored as the repository secret `LLM_GATEWAY_ISSUER_KEY`. It lasts 90
   days; issue a new one before it expires.

## Network refusal check

The manual workflow "Network refusal check" (Actions tab, `flax agents net-check`)
proves the box cannot reach the systems behind the tools, by trying rather
than by trusting the model. It starts the pinned box with `lbx --run` as a
job run does (the same data directory rules, lbx configuration and command
line builder, `--no-network` after asking the lbx on `PATH` whether it has
the flag), but runs a probe in it instead of Pi, and without a socket
directory (the sockets lead to the runner's own servers, not to the
network). For each target the probe tries a DNS lookup, a direct DNS
query, a direct connection to each address the runner resolved for the
host, and a direct connection by name. The targets are each cluster's
Kubernetes API (host and port read from the kubeconfig secrets on the
runner; the box gets host names and addresses only), `api.github.com`,
`slack.com`, the OpenObserve query, ingest and UI hosts, and
`example.com`.

Every attempt must fail, and every connection to an address must fail
with no route (`ENETUNREACH` or `EHOSTUNREACH`; a timeout or a refused
connection means a route exists). The box must have no address besides
loopback and no proxy variables. A control proves the probe can tell
reached from blocked: it must reach a listener on loopback inside the box.
The check prints PASS or FAIL per target, with every attempt, and fails
otherwise. Run it after changing `box.yml`.

## The pinned box

Jobs run in the agent image: Pi, the kit's Pi plugin (`pi-mcp-mailbox`:
the model shim and the tools over the tools socket) and, when the
workspace names one, a Pi provider plugin, on Ubuntu 24.04 with Node, and
nothing else. Every job runs on a fresh runner VM that pulls the image, so
a small one saves minutes on every run. The image is built from
[`images/agent/Dockerfile`](../images/agent/Dockerfile) on the sandbox
(lbx) release's `entrypoint.sh` and behaves like lbx's full developer image
under `lbx --run`: the same in-box user, home layout and `/data`
directory. Jobs never run in the full image, and `box.yml` accepts only an
agent image.

Two kinds of agent image exist:

- **The kit's image**, `ghcr.io/<owner>/flax-agent`, published by this
  repository's "Publish image" workflow (`workflows/publish-image.yml`). It
  carries no provider plugin: it is for a workspace whose `agents.provider`
  has no `plugin` and uses Pi's own provider of that name.
- **A workspace's own image**, for a workspace whose
  `agents.provider.plugin` names a Pi provider plugin (the Acme workspace:
  `pi-provider-acme`). The workspace builds it from the kit's Dockerfile
  (`node_modules/@flax/agents/images/agent/Dockerfile`) with the build
  arguments `PI_PROVIDER_PACKAGE` and `PI_PROVIDER_VERSION`, which install
  the plugin under `/opt/pi-extensions`, the directory the job runner names
  with `--extension`, and check the installed version. Its publish workflow
  is a copy of the kit's with those two arguments, pushing to the
  repository `agents.agentImage` names.

The kit action refuses a run when the pinned image's
`io.flax.agent-image.provider-plugin` label is not the plugin `flax.yml`
names, before the sandbox starts, so a workspace cannot pin the kit's image
by mistake and have every model call fail inside the box.

"Publish image" takes a sandbox (lbx) release tag `vX.Y.Z` (`box_release`)
and is started by hand. On a hosted runner it:

1. refuses a `box_release` that is not `vX.Y.Z`;
2. reads the release notes block lbx's release workflow wrote
   (`flax agents box-release resolve`, `src/box-release/release.ts`): the
   commit must be the one the tag names, and the launcher's `.sha256` asset
   gives `lbx_sha256`;
3. downloads the launcher and verifies it, and takes `entrypoint.sh` from
   the release's tagged source;
4. bundles the Pi plugin with `flax agents bundle-pi-plugin`, builds the
   agent image with it and the entrypoint, and pushes it as
   `<image>:<release>` and `<image>:<release>-<kit commit>` (the commit
   shortened to 12 characters);
5. starts the pushed image with the release's `lbx --run` (no network, a
   fresh data directory) and runs `pi --version`, which must print the
   pinned version. No model is called;
6. prints the four values a workspace pins in `box.yml` (`box_release`,
   `box_commit`, `lbx_sha256`, `image`) as the job summary. A workspace
   writes them with `flax agents box-release pin --release <tag> --commit
<sha> --sha256 <hex> --image <ref>`, runs `flax agents generate` and
   opens a pull request; a workspace's own publish workflow may do that
   itself.

`box.yml` pins every job to one box: the lbx release (`box_release`), the
commit it names (`box_commit`), the launcher's checksum (`lbx_sha256`) and
the agent image (`image`), by digest. Jobs move to a new box only when a
person merges that pull request. The kit action downloads the release's
launcher before every run and refuses the job unless its checksum is
`lbx_sha256`. Until the first publish, `box.yml` holds placeholders with
`pinned: false`: `flax agents check` warns and real runs are refused.

### Updating Pi, the plugins or Node

The agent image installs exact versions, set as build arguments at the top
of `images/agent/Dockerfile`: `PI_VERSION`, `PI_MCP_MAILBOX_VERSION`,
`NODE_VERSION` and the Node tarball checksums `NODE_SHA256_AMD64` and
`NODE_SHA256_ARM64` (from
`https://nodejs.org/dist/v<version>/SHASUMS256.txt`); `PI_PROVIDER_PACKAGE`
and `PI_PROVIDER_VERSION` are empty here and set by a workspace's own
build. `flax agents check` refuses a tag such as `latest` or a range. To
update:

1. On a branch, change the version. The newest Pi is shown by
   `npm view @earendil-works/pi-coding-agent version`. The Pi plugin is
   built from this repository: change its code, then its version in
   `images/agent/pi-mcp-mailbox/package.json`, `CLIENT_VERSION` in its
   `src/extension.ts` and `PI_MCP_MAILBOX_VERSION`, all to the same value
   (`pnpm test` checks they agree).
2. Run "Publish image" on that branch ("Use workflow from"), with the
   `box_release` the workspaces pin. The build fails if Pi or a plugin is
   not the pinned version or not owned by root, if the Pi plugin is not the
   bundle the workflow made or does not load, or if `pi --help` no longer
   lists a flag the job runner passes (`src/run-job/argv.ts`); the smoke
   run fails if the image no longer starts under `lbx --run`.
3. Each workspace pins the printed values and merges its pull request; a
   workspace with its own image rebuilds that from the new kit release
   first.

A new lbx release (a changed `entrypoint.sh` or launcher) is taken the same
way: run "Publish image" with the new tag and pin the values it prints. An
lbx commit without a release cannot be pinned.

## Test lbx on the agents pool

Actions → "Test lbx" → Run workflow, with a lbx branch,
tag or commit. The job runs on the `agents` pool-a pool, prepares the
runner with `tests/setup-run-test-host.sh`, and runs the suites. By default
that is the box's own `tests/run-all-suites.sh`, the same runner
lbx CI uses (it builds the images and runs the user and root
passes); named suites are run once each. Logs are kept as the `test-box-logs`
artifact for 14 days.

The images come from lbx's image cache
(`ghcr.io/notes-co/lbx-ci-cache`, filled by its main
branch) when the box ref's image inputs match a cached build, and are
built otherwise; `build.log` says "pulled" or "built" per image. Check
`fresh_images` to build them regardless. Box refs from before the cache
always build.

Needs the `BOX_REPO_TOKEN` secret: a fine-grained token with read-only
access to the contents of lbx. Reading the cache needs this
repository to have read access to the `lbx-ci-cache` package
(package settings, "Manage Actions access"); without it the images are
built.
