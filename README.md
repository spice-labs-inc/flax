# @flax/agents

Scheduled agents that run unattended on cheap models with code guardrails. The package is the job kit: a checker, a workflow generator, a runner that puts the model in a sandbox with no network and reaches it only through the runner's own forwarder, delivery to files, Slack, pull requests, results artifacts and videos, a tools server that gives the model read-only tools, and a reusable GitHub Action that runs one job. Your jobs, tools and configuration live in your own workspace repository; this package contains none of them.

`flax agents <command>` is the command line (`flax-agents <command>` is the same binary). Every command takes `--workspace <dir>` (default: the current directory, or `FLAX_WORKSPACE`).

## Ten minutes

1. Make a workspace: a repository with `flax.yml` at its root. The shared keys name your organization, its GitHub owner and its environments in order; the first environment is the reference one, and one rule holds everywhere in flax: the first environment wins merges. The `agents:` section is this package's; the smallest useful one is

   ```yaml
   org: notes-co
   github: notes-co
   environments: [{ id: live }, { id: test }]
   agents:
     repo: notes-co/agents
     budgetUsdPerMonth: 50
     provider: { name: anthropic, baseUrl: https://api.anthropic.com, keyMode: static }
     displayName: Notes Agent
     commitAuthor: { name: notes-agents, email: notes-agents@users.noreply.github.com }
     kitAction: spice-labs-inc/flax/packages/agents@main
   ```

2. Add the files the kit reads beside it: `models.yml` (the models a job may name, with their prices), `channels.yml`, `repos.yml`, `link-hosts.yml`, `mcp-servers.yml`, `github-log-hosts.yml` and `box.yml`. `demo/agents` in the flax repository is a complete small example; copy it and change the names.
3. `flax agents new-job hello --owner <you> --template hello --set model=anthropic/claude-sonnet-4-5` copies the kit's `hello` template into `jobs/hello/`.
4. `flax agents generate --dist` writes `.github/workflows/job-hello.yml`, `JOBS.md` and `dist/` (the bundled runner the workflow runs). `flax agents check` must then say every check passed.
5. `flax agents run-job hello --stub --out /tmp/hello` runs the job offline with a stand-in model and writes a report. The real run happens in the workflow: it calls the kit action, which pulls the pinned agent image, downloads the pinned sandbox binary, verifies it and starts the job.

Two ways to reach a model, chosen with `agents.provider.keyMode`:

- `static`: the provider's own Messages API behind one key, the secret `MODEL_API_KEY`. Nothing to deploy. There is no per-run key and no spend the runner can read back, so only the per-run worst case (the job's token limit at the model's prices) is enforced. `baseUrl` is required; `gateway.yml` is optional and, when present, pins a CA root and per-key ceilings for a self-hosted endpoint.
- `litellm`: a LiteLLM gateway, `packages/gateway` in this repository, that issues one short-lived key per run, limited to the run's model and worst-case cost, and records what every key spent. `gateway.yml` names it (url, server_name, team, ca, key_max_usd, key_max_minutes) and the one secret is `LLM_GATEWAY_ISSUER_KEY`.

## The flax.yml agents section

| key | what it is |
|---|---|
| `repo` | owner/name of the workspace repository (run links, maintainer notes). Default `<github>/agents`. |
| `budgetUsdPerMonth` | what every job together may spend a month; the budget check sums the jobs' `usd_per_month` against it. |
| `provider` | `{ name, baseUrl, keyMode, plugin }`. `name` is the Pi provider the box uses and the prefix of model ids; `plugin` is the npm package of a Pi provider plugin the agent image installs, when Pi's own provider of that name is not the one. |
| `runsOn` | the runs-on labels of every generated workflow. Default `[ubuntu-24.04]`. |
| `sandbox` | `{ repo, tokenSecret }`: the lbx repository whose releases carry the launcher binary (default `spice-labs-inc/lbx`, public) and, for a private one, the secret holding a token. |
| `packagesTokenSecret` | the secret holding a token that can read the repository the `@flax` packages are installed from, while that repository is private: the generated workflows give it to git before `pnpm install`. Absent for a public one. |
| `packagesTokenApp` | `{ appIdSecret, privateKeySecret, repositories }`, instead of `packagesTokenSecret`: the secrets holding a GitHub App id and private key, and the `owner/name` repositories (all under one owner) the packages are installed from. Before `pnpm install` the generated workflows make the app a contents-read token for those repositories alone and give it to git the same way. |
| `agentImage` | the agent image repository without a tag; `box.yml` pins a digest of it. |
| `displayName`, `commitAuthor` | how the agent is named in check runs and pull request text, and who its commits are by. |
| `kitAction` | the reusable action every model job workflow calls, `owner/repo/path@ref`. |
| `clusters` | Kubernetes clusters tools may read: name to the secret holding its kubeconfig. |
| `openobserve` | where OpenObserve runs (`cluster`, `namespace`, `labelSelector`, `port`, `org`, `hosts`), for the logs, metrics and traces tools. |
| `board`, `epicsRepo` | the organization project and the epics repository the GitHub tools may read; absent disables those tools. |
| `networkJoins` | named step lists a job's media stage may ask for with `network: <name>` (`join` before the stage, `leave` after). |
| `setupSteps` | named step lists a media stage may ask for with `setup: [<name>]`, besides the kit's `packages`, `chromium`, `java` and `ghcr`. |
| `mediaSecrets` | the secret names a job's `media.secrets` may list; the runner hands media.ts only the ones its job lists. |
| `trustedLinkHosts` | hosts (and their subdomains) a pull request body may link to besides the organization's GitHub. |
| `neverEvidenceRepos` | repositories a pull request may never cite as evidence. |
| `video` | `{ channel, footer }` for jobs that publish videos. |
| `docsLint` | `{ repo, sections, componentTags, always, byTrait }`: lint rules the pull request checker applies to one docs repository, all as data. |

## What ships in the package

- `jobs/`: reference job templates (`hello`, `tools-proof`, `atlas-doc-refresh`, `atlas-map-refresh`, `atlas-wiring-eval`, `scenario-checks`, `scenario-watch`), each with a `template.yml` naming its fields. `flax agents new-job --templates` lists them; `--template <name> --set field=value` fills the `{{placeholders}}` from the flag and from flax.yml (`{{github}}`, `{{repo}}`, `{{environments}}` and so on).
- `tools/`: reference read-only tools for GitHub, Kubernetes, OpenObserve and Slack, served by the tools server; a workspace copies the ones it wants into its own `tools/`.
- `schema/`: the JSON schemas of `job.yml`, `tool.yml`, `box.yml`, `gateway.yml` and the other root files.
- `images/agent/Dockerfile`: the agent image (Pi, the kit's Pi plugin, an optional provider plugin) on the lbx entrypoint, pinned by digest in each workspace's `box.yml`. This repository's publish workflow builds it without a provider plugin; a workspace whose `provider.plugin` names one builds its own image from the same Dockerfile with the `PI_PROVIDER_PACKAGE` and `PI_PROVIDER_VERSION` build arguments, and the action refuses a pinned image that does not carry that plugin.
- `action.yml`: the composite action a model job workflow calls. It checks the job, pulls the image, downloads the lbx release binary the workspace pins (`box_release`), refuses it unless its sha256 is `lbx_sha256`, and runs the workspace's `dist/run-job.mjs`.
- `workflows/`: the kit's own CI (check, rebuild-dist, publish-image, net-refusal, box-test, tools-smoke), run in this repository against the fixture workspace in `test/fixtures/workspace`.
- `src/media/`: the media kit a job's `media.ts` imports as `@flax/agents/media/<name>`: text to speech with word timing, captions, the media manifest, and `renderRecording`, which turns a scenario record run into a narrated video with captions, chapters, a poster, terminal scenes, intro and outro cards, cards inside the video, a recap and fades, and optional music, zoom and callouts, plus the stand-ins mechanism. See docs/agents/media.md in the flax repository.
- `test/fake-*.ts`, `test/helpers.ts`: the fakes a workspace's own job tests import as `@flax/agents/test/<name>`.

## box.yml

```yaml
pinned: true
box_release: "v0.1.0"
box_commit: "<the commit the release names>"
lbx_sha256: "<sha256 of lbx-x86_64-unknown-linux-musl>"
image: ghcr.io/<owner>/flax-agent@sha256:<digest>
```

The publish-image workflow prints these for an lbx release; `flax agents box-release resolve --release v0.1.0` reads the commit, the binary name and its sha256 from the release, and `flax agents box-release pin --release ... --commit ... --sha256 ... --image ...` writes the file. While `pinned` is false, job runs are refused and `check` warns.

## Commands

`check`, `generate [--dist]`, `new-job`, `run-job <job> [--stub] [--preflight] [--out <dir>] ...`, `check-output`, `net-check`, `tools-smoke`, `fetch-servers`, `fetch-github-hosts`, `box-release`, `bundle-pi-plugin`. Each prints its usage with no arguments.

## Development

`pnpm check` (typecheck and tests), `pnpm test`. The tests run against `test/fixtures/workspace`, a workspace for the fictional notes-co.
