# Credentials

Every credential the agents platform holds: what it grants, who holds it
while a job runs, where it is stored, who owns it, when it was last
rotated and how to revoke it. Names, scopes and places only: no value of
any credential ever goes in this file, in an issue or in a pull request.

Keep it current. A pull request that adds a credential, moves one or
widens what one grants updates this file in the same pull request, and
the code owner reviews the entry with it. A credential that is retired
leaves the table in the pull request that stops using it.

**Owners.** The owner is the person who rotates the credential and
answers for it. `CODEOWNERS` names `@octocat` as a placeholder until the
owning team is set, so most owners below are `@octocat` marked
"(confirm)". Replace the mark once the owner has agreed.

**Rotation.** No credential here has a rotation schedule yet. "Last set"
is the date the stored copy last changed (GitHub shows it for secrets, the
file date for files on hosta), which is the latest possible rotation, not
proof of one.

## The register

| Credential                                                                                                           | Held while a job runs by                                                                                                                                   | Stored in                                                                                            | Owner                                                | Rotation                                             |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| [`ACME_API_KEY` (org secret)](#acme_api_key-org-secret)                                                            | nobody: retired                                                                                                                                            | deleted 2026-09-30 (was a GitHub org secret)                                                         | @octocat (confirm)                                  | retired 2026-09-30; key revoked at Acme             |
| [`LLM_GATEWAY_ISSUER_KEY`](#llm_gateway_issuer_key)                                                                  | the runner only                                                                                                                                            | agents repository secret                                                                       | @octocat (confirm)                                  | every 90 days; set 2026-10-01, expires 2026-12-30    |
| [`AGENTS_READER_APP_ID`, `AGENTS_READER_PRIVATE_KEY`](#agents_reader_app_id-agents_reader_private_key)               | the runner only                                                                                                                                            | agents repository secrets                                                                      | @octocat (confirm)                                  | not set; last set 2026-09-28                         |
| [`AGENTS_WRITER_APP_ID`, `AGENTS_WRITER_PRIVATE_KEY`](#agents_writer_app_id-agents_writer_private_key)               | the runner only, in live runs of pull request jobs, and the scenario-checks dispatch token step                                                            | agents repository secrets                                                                      | @octocat (confirm)                                  | not set; last set 2026-09-30                         |
| [`KUBECONFIG_DEV`, `_STAGING`, `_PROD`, `_SHARED_SERVICES`](#kubeconfig_cluster)                                | the runner, and each cluster's kubernetes-mcp-server child                                                                                                 | agents repository secrets                                                                      | @octocat (confirm)                                  | not set; last set 2026-09-28                         |
| [`KUBECONFIG_DEV_VAULT`, `_STAGING_VAULT`, `_PROD_VAULT`](#kubeconfig_cluster_vault)                            | nobody (no workflow passes them)                                                                                                                           | agents repository secrets                                                                      | @octocat (confirm)                                  | not set; last set 2026-09-28                         |
| [`OPENOBSERVE_CI_AUTH`](#openobserve_ci_auth)                                                                        | the runner only                                                                                                                                            | GitHub org secret, visible to all repositories                                                       | @octocat (confirm)                                  | not set; last set 2026-08-04                         |
| [`SLACK_AGENTS_BOT_TOKEN`](#slack_agents_bot_token)                                                                  | the runner only                                                                                                                                            | agents repository secret                                                                       | @octocat (confirm)                                  | not set; last set 2026-09-28                         |
| [`SLACK_AGENTS_POST_TOKEN`](#slack_agents_post_token)                                                                | the runner only, in the delivery step of slack jobs, live and shadow                                                                                       | agents repository secret                                                                       | @octocat (confirm)                                  | not set; last set 2026-10-01                         |
| [`ELEVENLABS_API_KEY`](#elevenlabs_api_key)                                                                          | `media.ts` of a job whose `media.secrets` lists it, and the runner                                                                                         | agents repository secret                                                                       | @octocat (confirm)                                  | not set; last set 2026-10-05                         |
| [`LIVETESTS_MAILBOX_USER`, `LIVETESTS_MAILBOX_APP_PASSWORD`](#livetests_mailbox_user-livetests_mailbox_app_password) | `media.ts` of a job whose `media.secrets` lists them, and the runner                                                                                       | agents repository secrets                                                                      | @octocat (confirm)                                  | not set; last set 2026-10-05                         |
| [`EXPLORER_INGEST_TOKEN`](#explorer_ingest_token)                                                                    | `media.ts` of a job whose `media.secrets` lists it, and the runner                                                                                         | agents repository secret, and the explorer stack's `.env` on hostc                      | @octocat (confirm)                                  | not set yet                                          |
| [`YOUTUBE_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN`, `_CHANNEL_ID`](#the-youtube-grant)                         | the runner only, in live runs of youtube jobs                                                                                                              | agents repository secrets                                                                      | @octocat (confirm)                                  | not set; last set 2026-10-05                         |
| [`BOX_REPO_TOKEN`](#box_repo_token)                                                                                  | the checkout step on the runner                                                                                                                            | agents repository secret                                                                       | unknown (confirm)                                    | not set; last set 2026-09-24                         |
| [`GH_TOKEN`](#gh_token)                                                                                              | the Publish box image workflow on the runner                                                                                                               | GitHub org secret, visible to all repositories                                                       | the SpicyGrzl account's holder (confirm)             | not set; last set 2025-12-03                         |
| [`GITHUB_TOKEN`](#github_token)                                                                                      | the workflow steps on the runner                                                                                                                           | made by GitHub for each workflow run                                                                 | GitHub (automatic)                                   | per workflow run                                     |
| [GitHub installation token, per run](#github-installation-token-per-run)                                             | the runner and the github-mcp-server child                                                                                                                 | memory only, made for the run                                                                        | made by the runner                                   | per run; revoked when the run ends                   |
| [GitHub writer token, per delivery](#github-writer-token-per-delivery)                                               | the runner only                                                                                                                                            | memory only, made for the delivery                                                                   | made by the runner                                   | per delivery; revoked when delivery ends             |
| [YouTube access token, per delivery](#youtube-access-token-per-delivery)                                             | the runner only                                                                                                                                            | memory only, made for the delivery                                                                   | made by the runner                                   | per delivery; forgotten when delivery ends           |
| [Gateway run key, per run](#gateway-run-key-per-run)                                                                 | the runner's model forwarder only                                                                                                                          | memory only, made for the run                                                                        | made by the runner                                   | per run; blocked when the run ends                   |
| [Gateway media key, per run](#gateway-media-key-per-run)                                                             | the runner's media model socket only                                                                                                                       | memory only, made for the run                                                                        | made by the runner                                   | per run; blocked when `media.ts` ends                |
| [Gateway `ACME_API_KEY`](#gateway-acme_api_key)                                                                    | the gateway (LiteLLM)                                                                                                                                      | hosta `~runtime/stacks/llm-gateway/.env`, recovery copy in Scaleway Secret Manager `llm_gateway_env` | @octocat (confirm)                                  | not set; last set 2026-09-29                         |
| [Gateway `ANTHROPIC_API_KEY`](#gateway-anthropic_api_key)                                                            | the gateway (LiteLLM)                                                                                                                                      | same `.env` and recovery copy                                                                        | @octocat (confirm)                                  | not set; last set 2026-09-29                         |
| [`LITELLM_MASTER_KEY`](#litellm_master_key)                                                                          | the gateway (LiteLLM); used by hand for admin                                                                                                              | same `.env` and recovery copy                                                                        | @octocat (confirm)                                  | not set; last set 2026-09-29                         |
| [`LITELLM_SALT_KEY`](#litellm_salt_key)                                                                              | the gateway (LiteLLM)                                                                                                                                      | same `.env` and recovery copy                                                                        | @octocat (confirm)                                  | never (by design)                                    |
| [`POSTGRES_PASSWORD`](#postgres_password)                                                                            | the gateway's LiteLLM and Postgres                                                                                                                         | same `.env` and recovery copy                                                                        | @octocat (confirm)                                  | not set; last set 2026-09-29                         |
| [Gateway CA keys](#gateway-ca-keys)                                                                                  | the gateway (Caddy)                                                                                                                                        | hosta `~runtime/stacks/llm-gateway/caddy-data/`, nightly archives in `backups/`                      | @octocat (confirm)                                  | root valid to 2036-08-07; intermediate renews itself |
| [hosta `runtime` ghcr.io login](#hosta-runtime-ghcrio-login)                                                         | docker on hosta, to pull the gateway's egress relay image                                                                                                  | hosta `~runtime/.docker/config.json`, source Scaleway secret `ghcr_reg_cred`                         | @octocat (confirm)                                  | not set                                              |
| [`notes-labs-ci` GitHub App private key](#notes-labs-ci-github-app-private-key)                                      | pool-a on hosta and on hostb, never a runner VM                                                                                                      | hosta `/etc/pool-a/config.yaml` (and its backups there); hostb's own pool-a config        | @octocat (confirm) for hosta, @aredridel for hostb | rotated 2026-09-29                                   |
| [`NOTES_LABS_PROD_API_TOKEN`](#notes_labs_prod_api_token)                                                            | the atlas-map-refresh Notes Agent; atlas's old map refresh workflow, which no longer publishes                                                       | GitHub org secret, selected repositories: atlas, agents                                  | @octocat (confirm)                                  | not set; last set 2026-09-30                         |
| [`TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`](#ts_oauth_client_id-ts_oauth_secret)                                       | atlas map refresh (GitHub-hosted runners); the tailnet join step of an agents job with `media.network: tailnet` (atlas-map-refresh, scenario-checks) | GitHub org secrets, selected repositories: backend, agents, atlas                         | @octocat (confirm)                                  | not set; last set 2026-09-30                         |

"The runner" is the `node dist/run-job.mjs` process in the one workflow
step that gets secrets. "The box" is lbx and Pi inside it. `collect.ts`
and `render.ts` never hold any credential (see
[guardrails.md](guardrails.md#secrets-never-reach-argv-or-reports)), and
`media.ts` holds only the media secrets its job lists in `media.secrets`;
with `media.model` it also reaches a model through a socket the runner
serves, never holding that key.

## How workflows pass secrets

GitHub Actions secrets the workflows use. None of their values is ever
written to a file, a command line or a report; the report writer replaces
any that shows up with `[redacted]` and fails the run.

| Secret                                                                                       | Scope        | Used by                                                             | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_TOKEN`                                                                               | per run      | job workflows, Publish box image                                    | The workflow's own token: pulls the pinned image from ghcr.io (and pushes the agent image, in Publish box image).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `BOX_REPO_TOKEN`                                                                             | repository   | job workflows, Publish box image, Test lbx                | A fine-grained token with read-only access to the contents of lbx, for checking out `lbx` at the pinned commit and, in Publish box image, reading the release notes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GH_TOKEN`                                                                                   | organization | Publish box image                                                   | Pushes the `box-release/<tag>` branch and opens the `box.yml` pull request. A pull request opened with `GITHUB_TOKEN` would not start `check.yml`. It must be allowed to push workflow files (a classic token with the `workflow` scope, or a GitHub App with workflows write), because the job workflows embed the pin.                                                                                                                                                                                                                                                                                                                         |
| `LLM_GATEWAY_ISSUER_KEY`                                                                     | repository   | every job workflow                                                  | The LiteLLM team service account key for team `agents` (`bootstrap.sh --issue-runner-key` in the gateway stack). It can issue, block and read keys of its team only, within the gateway's key ceiling. The runner uses it to issue each run's own key and read spend; it never reaches lbx, the box, `collect.ts` or `render.ts`.                                                                                                                                                                                                                                                                                                                |
| `KUBECONFIG_DEV`, `KUBECONFIG_STAGING`, `KUBECONFIG_PROD`, `KUBECONFIG_SHARED_SERVICES` | repository   | jobs with Kubernetes tools, Tools smoke test, Network refusal check | One kubeconfig per cluster for the `agents-reader` ServiceAccount (infra-gitops `platform/components/agents-reader`), bound to the built-in view-only `view` role. `KUBECONFIG_SHARED_SERVICES` is also used by jobs with OpenObserve tools: in shared-services the account may port-forward to the OpenObserve pod (infra-gitops `use-cases/admin/base/openobserve/agents-portforward.yml`).                                                                                                                                                                                                                                              |
| `KUBECONFIG_DEV_VAULT`, `KUBECONFIG_STAGING_VAULT`, `KUBECONFIG_PROD_VAULT`             | repository   | nothing yet                                                         | The same reader account's kubeconfigs for the Vault clusters, which get the account from the same component. No tool reads them yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `AGENTS_READER_APP_ID`, `AGENTS_READER_PRIVATE_KEY`                                          | repository   | jobs with GitHub tools, Tools smoke test                            | The GitHub App "agents-reader" (read-only contents, pull requests, actions, metadata, issues, organization projects and organization members). The runner makes a short-lived installation token from them for each run, narrowed to contents, pull requests, actions and metadata read, plus issues or organization projects read only when the job has a tool that reads them, and revokes it when the run ends; the private key never leaves the runner process.                                                                                                                                                                        |
| `OPENOBSERVE_CI_AUTH`                                                                        | organization | jobs with OpenObserve tools, Tools smoke test                       | The existing `ci-traces` OpenObserve service account, as an HTTP Basic value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `AGENTS_WRITER_APP_ID`, `AGENTS_WRITER_PRIVATE_KEY`                                          | repository   | live jobs with output kind pr                                       | The GitHub App "agents-writer" (repository contents write, pull requests write, check runs write, metadata read, organization members read, actions write for the scenario-checks dispatch token; no workflows or administration), installed on the repositories in `repos.yml` and on scenarios (scenario-checks dispatch) only. The runner makes an installation token from it only to deliver, narrowed to the job's target repositories, and revokes it when delivery ends; the key never leaves the runner process. Created 2026-09-30 (app id 5142542); installed on atlas, internal-docs, public-docs and agents. |
| `SLACK_AGENTS_BOT_TOKEN`                                                                     | repository   | jobs with the Slack tool, Tools smoke test                          | The bot token of the internal Slack app "Notes Co Agents" (`channels:history`, `channels:read`, `users:read`; no write scope). The bot must be invited to each channel in the `read` list of `channels.yml`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SLACK_AGENTS_POST_TOKEN`                                                                    | repository   | jobs with output kind slack, live or shadow                         | The bot token of a separate internal Slack app that only posts, with `chat:write` and nothing else; the runner refuses a token with any other scope. Its bot must be invited to each channel a job posts to and to the shadow channel. The app is "Notes Co Agent Reports", created 2026-10-01 and invited to #system-health, #product and #agents-shadow. Youtube jobs with `notify` (live, or shadow posting one line to the shadow channel), pull request jobs with `notify` and check jobs post with it too.                                                                                                                               |
| `ELEVENLABS_API_KEY`                                                                         | repository   | jobs whose `media.ts` narrates                                      | An ElevenLabs API key for text to speech. Only `media.ts` gets it, and only when its job lists it in `media.secrets`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `LIVETESTS_MAILBOX_USER`, `LIVETESTS_MAILBOX_APP_PASSWORD`                                   | repository   | jobs whose `media.ts` signs in to the dashboard                     | The livetests mailbox address and its app password, to read the magic sign-in link the dashboard sends. Only `media.ts` gets them, and only when its job lists them in `media.secrets`.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `EXPLORER_INGEST_TOKEN`                                                                      | repository   | scenario-checks                                                     | The bearer token the scenarios run sends with its live updates to the explorer's `/ingest/*`. Only `media.ts` gets it, and only when its job lists it in `media.secrets`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`                                                      | organization | jobs with `media.network: tailnet`                                  | The Tailscale OAuth client that joins the runner to the tailnet as an ephemeral `tag:ci` node. Only the step that joins the tailnet gets them. The org secrets must list agents among their repositories.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `YOUTUBE_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN`, `_CHANNEL_ID`                       | repository   | live jobs with output kind youtube                                  | The YouTube grant for the "Notes Co" channel: the OAuth client "Notes Co Publishing" (Google Cloud project `notes-labs-youtube`) and a refresh token with `youtube.upload` and `youtube.force-ssl` only. The runner refuses a grant with any other scope or for any other channel than `YOUTUBE_CHANNEL_ID`, which is public, not secret.                                                                                                                                                                                                                                                                                                    |

A generated job workflow passes a tool secret only when one of the job's
tools needs it, the writer app's secrets only to a live job with output
kind pr or youtube, the posting token only to a job with output kind slack
(live, or shadow posting to the shadow channel), a youtube job with
`notify` (live, or shadow posting to the shadow channel), a pull request job with `notify` (live, or shadow posting to the
shadow channel) or a check job with an `alert`, the reader app's to every youtube job (it reads the map file),
the YouTube grant only to a live youtube job and a media secret only to a
job whose `media.secrets` lists it, and only to the step that runs the job.
There they reach the runner process alone: the runner removes every tool
secret, the gateway issuer key, the writer app's secrets, the posting
token, the YouTube grant and every media secret from the environment of
lbx, the box, `collect.ts` and `render.ts`, and gives `media.ts` only the
media secrets its job lists. A job with `model: none` gets no gateway
issuer key at all. The tailnet's OAuth client, `TS_OAUTH_CLIENT_ID` and
`TS_OAUTH_SECRET`, goes only to the step that joins the tailnet, in the
workflow of a job with `media.network: tailnet`.

Every credential behind these secrets, and those the model gateway and the
runners hold, has its own entry below: its owner, where it is stored,
when it was rotated and how to revoke it. Add a credential here in the
same pull request that starts using it.

## GitHub secrets the agents workflows use

### `ACME_API_KEY` (org secret)

- **Status:** retired. The owner deleted the org secret and revoked its
  key in the Acme console on 2026-09-30.
- **Granted:** calls to the Acme model API (`api.code.acme.ai`), billed
  to the org's Acme account.
- **Held by:** no one. Every run reaches its model through the model
  gateway, which keeps a separate Acme key of its own (Gateway
  `ACME_API_KEY`, below), unchanged.

### `LLM_GATEWAY_ISSUER_KEY`

- **Grants:** the LiteLLM team service account key for team `agents`. It
  may issue and update (block) keys of that team within the gateway's key
  ceiling ($25 a key, 90 days; the runner gives each run key at most 2
  hours), and read `/key/info` and `/team/info`. It cannot create teams,
  delete keys or list keys. It expires 90 days after it was issued.
- **Used by:** every job workflow that runs a model, and a job with
  `model: none` only when its `media.model` asks for a media key.
- **Held by:** the runner only; it is removed from the environment of lbx,
  the box, `collect.ts` and `render.ts`, and never given to `media.ts`.
- **Stored in:** a agents repository secret, set 2026-10-01 02:06 UTC (expires 2026-12-30). It was created with
  `bootstrap.sh --issue-runner-key` on hosta, piped straight into
  `gh secret set LLM_GATEWAY_ISSUER_KEY --repo notes-co/agents`.
- **Revoke:** on the gateway's admin site
  (`ssh -L 4000:127.0.0.1:4000 root@hosta.notes-labs.dev`, then
  `http://localhost:4000/ui`), delete the `agents-runner-*` service account
  key; then issue a new one with `bootstrap.sh --issue-runner-key` and set the secret
  again. Each `--issue-runner-key` issues a new key, so delete any extra one.

### `AGENTS_READER_APP_ID`, `AGENTS_READER_PRIVATE_KEY`

- **Grants:** the org-owned GitHub App `agents-reader` (app id
  5112792), installed on all org repositories with read-only `actions`,
  `contents`, `issues`, `members`, `metadata`, `organization_projects` and
  `pull_requests`. The private key can make installation tokens with any
  of those read permissions. The revision poller asks for `members` so a
  reviewer whose org membership is private still counts as a member.
- **Used by:** jobs with GitHub tools or GitHub `collect_tools`, the Tools
  smoke test, and every run of a youtube job, which reads its map file in
  `docs_repo` with a token for that repository only (contents, metadata
  and pull requests read). The workflow of a job with `media.sources` also
  makes a token for those repositories alone, contents read, to check them
  out; the checkouts keep no credentials and only the token step holds the
  key. The workflow of a job with `media.read_repos` makes one more such
  token, contents read for those repositories alone (scenario-checks:
  sample-apps), just before the run step; the runner gives it to
  `media.ts` as `GH_TOKEN` and scrubs it from every report, and it
  expires within the hour.
- **Held by:** the runner, and the media sources and media read token
  steps of a job with `media.sources` or `media.read_repos`. Apart from that step the private key never leaves the
  runner process; it makes one narrowed token per run (below). The
  scenarios explorer service on hostc holds a second key of
  the same app (`EXPLORER_GH_APP_ID`, `EXPLORER_GH_APP_KEY` in
  `~runtime/stacks/explorer/.env`) to read the scenario-checks artifacts and
  the Engineering Board issues.
- **Stored in:** agents repository secrets; the explorer's key in the
  explorer stack's `.env` on hostc.
- **Revoke:** org Settings, Developer settings, GitHub Apps,
  `agents-reader`
  (https://github.com/organizations/notes-co/settings/apps/agents-reader),
  Private keys: generate a new key, set `AGENTS_READER_PRIVATE_KEY`, run
  the Tools smoke test, then delete the old key. The explorer's key is
  separate: generate a new one, replace `EXPLORER_GH_APP_KEY` on
  hostc, then delete the old one. To cut all access at once,
  suspend or uninstall the app under the org's Installed GitHub Apps.

### `AGENTS_WRITER_APP_ID`, `AGENTS_WRITER_PRIVATE_KEY`

- **Grants:** the org-owned GitHub App `agents-writer` (app id
  5142542), created 2026-09-30. The private key can make installation
  tokens that write contents, pull requests and check runs and read
  organization members (GitHub refuses an app's team review request
  without it) in the repositories the app is installed on. The app needs
  **Checks: Read and write** and **Members: Read-only** accepted on the
  installation; until it has them, delivery goes on without check runs and
  team review requests. For a job with `media.dispatch_repos` it also
  needs **Actions: Read and write** accepted on the installation and must
  be installed on those repositories (scenario-checks: scenarios).
  It must be installed on every repository in
  `repos.yml`: atlas (atlas-doc-refresh), internal-docs
  (internal-docs-watch), public-docs (public-docs-watch, docs-screenshots
  and the demo-videos map pull request) and agents (scenario-watch).
  Installed on all four as of 2026-10-06; a new repository in
  `repos.yml` is added in the GitHub App settings (org Settings, GitHub
  Apps, `agents-writer`, Configure, Repository access) before the
  job that writes there goes live. Delivery asks for a token on the job's own
  repositories only, so a job never writes to another's.
- **Also used by:** the Revision poller workflow, only to queue the
  `Notes Agent / <job>` check of a revision it starts, with a token that
  may write checks and read contents on that one repository.
  And by the workflow of a job with `media.dispatch_repos`, which makes
  a token that may write actions on those repositories alone just before
  the run step (scenario-checks: scenarios, so the GitHub Action
  scenarios can start the action-check workflow and read its runs and
  artifacts); the runner gives it to `media.ts` as
  `FLAX_AGENTS_DISPATCH_TOKEN`, scrubs it from every report, and it
  expires within the hour.
- **Used by:** live runs of jobs with `output.kind: pr` (internal-docs-watch,
  public-docs-watch, scenario-watch, docs-screenshots and
  atlas-doc-refresh) and
  `output.kind: youtube` (the map pull request on `docs_repo`, so the app
  must be installed on it, such as public-docs); the generated workflow
  passes the secrets only to those. Shadow and stub runs never use them.
- **Held by:** the runner, the media sources token step of a job with
  `media.sources`, and the media dispatch token step of a job with
  `media.dispatch_repos`. The private key never leaves the runner
  process; it makes one narrowed token per delivery (below).
- **Stored in:** agents repository secrets.
- **Branch protection:** atlas `main` is intentionally not
  protected (owner decision), and internal-docs and public-docs `main`
  have no branch protection either. The kit's writer refusing any branch
  but `agent/<job>/<YYYY-MM-DD>`, having no approve call, and merging only
  an open pull request from an agent branch of the same repository at the
  head delivery just wrote (only for a job's `output.auto_merge` paths, which
  `flax agents check` keeps to generated data), is the only guard against a write
  to `main` in any of them.
- **Revoke:** org Settings, Developer settings, GitHub Apps,
  `agents-writer`
  (https://github.com/organizations/notes-co/settings/apps/agents-writer),
  Private keys: generate a new key, set `AGENTS_WRITER_PRIVATE_KEY`, then
  delete the old key. To cut all access at once, suspend or uninstall the
  app under the org's Installed GitHub Apps.

### `KUBECONFIG_<CLUSTER>`

`KUBECONFIG_DEV`, `KUBECONFIG_STAGING`, `KUBECONFIG_PROD`,
`KUBECONFIG_SHARED_SERVICES`.

- **Grants:** the `agents-reader` ServiceAccount (namespace
  `agents`) on that cluster, bound to the built-in `view`
  ClusterRole: read most resources, no Secrets, no exec. On
  shared-services it may also port-forward to the OpenObserve pod
  (`pods` get and list, `pods/portforward` get and create in namespace
  `openobserve`). Defined in infra-gitops
  `platform/components/agents-reader` and
  `use-cases/admin/base/openobserve/agents-portforward.yml`.
- **Used by:** jobs with Kubernetes tools, jobs with OpenObserve tools
  (shared-services only, for the port-forward), the Tools smoke test, the
  Network refusal check.
- **Held by:** the runner, and each cluster's kubernetes-mcp-server child
  (written to a mode 0600 file outside the data directory, removed when the
  run ends).
- **Stored in:** agents repository secrets. The token inside each is
  the long-lived `agents-reader-token` Secret on that cluster.
- **Revoke:** on the cluster,
  `kubectl -n agents delete secret agents-reader-token`: the
  old token stops working at once, and Flux recreates the Secret with a
  new token. Build a new kubeconfig from it and set the repository secret.
  To remove the account's access entirely, remove the component from the
  cluster's overlay in infra-gitops.

### `KUBECONFIG_<CLUSTER>_VAULT`

`KUBECONFIG_DEV_VAULT`, `KUBECONFIG_STAGING_VAULT`,
`KUBECONFIG_PROD_VAULT`.

- **Grants:** the same reader account on the three Vault clusters.
- **Used by:** nothing yet; no workflow passes them.
- **Stored in:** agents repository secrets.
- **Revoke:** as above, on the Vault cluster.
- **Status:** unused. Delete them
  (`gh secret delete <name> --repo notes-co/agents`) unless a
  tool that reads the Vault clusters is planned.

### `OPENOBSERVE_CI_AUTH`

- **Grants:** the OpenObserve service account `ci-traces@notes-co.example`, as
  an HTTP Basic value. It was made to send CI traces, but the OpenObserve
  OSS build does not enforce roles, so it can do whatever the account's
  API allows; the tools server's allowlist of read operations is what keeps
  agent runs to reading.
- **Used by:** jobs with OpenObserve tools, the Tools smoke test. Also CI
  trace export in widget, servicea, engine, marjoram, notes-cli and
  survey-build.
- **Held by:** the runner only.
- **Stored in:** org secret, visible to all repositories.
- **Revoke:** in the OpenObserve UI
  (openobserve.shared-services.svc.notes-co.example, tailnet only), IAM,
  Service Accounts, `ci-traces@notes-co.example`: refresh its token, then set
  the org secret to the new Basic value. Every repository that ships CI
  traces uses the same secret, so all of them move at once.

### `SLACK_AGENTS_BOT_TOKEN`

- **Grants:** the bot token of the internal Slack app "Notes Co Agents":
  `channels:history`, `channels:read`, `users:read`, no write scope. It
  reads only channels the bot was invited to. Never add a write scope to
  this app: posting has its own app and token
  (`SLACK_AGENTS_POST_TOKEN`).
- **Used by:** jobs with the Slack tool, the Tools smoke test.
- **Held by:** the runner only.
- **Stored in:** agents repository secret.
- **Revoke:** https://api.slack.com/apps, "Notes Co Agents", OAuth and
  Permissions, Revoke All OAuth Tokens; then Reinstall to Workspace for a
  new token and set the secret.

### `SLACK_AGENTS_POST_TOKEN`

- **Grants:** the bot token of a second internal Slack app that only posts
  ("Notes Co Agent Reports"): `chat:write` and nothing
  else, so it can post as that app's bot in channels the bot was invited
  to, and cannot read, join channels, change its name or icon, or look up
  anyone. The runner calls `auth.test` first and refuses the token if
  Slack reports any other scope or a token that is not a bot's.
- **Why a second app:** a Slack app has one bot token carrying all of the
  app's scopes, so adding `chat:write` to "Notes Co Agents" would give
  the reader token (`SLACK_AGENTS_BOT_TOKEN`) write access too. Two apps
  keep a leak of either token to one kind of access, can be revoked one at
  a time, are invited to different channels (the reader to the alert
  channels it reads, the poster only to the channels jobs post to), and
  show readers which messages an agent job posted.
- **Used by:** jobs with `output.kind: slack`, live (posting to the
  job's channel) and shadow (posting to the shadow channel,
  #agents-shadow), youtube jobs with `notify` (the review notice live, one line to the shadow channel in shadow), pull request jobs with `notify` (the notice of each opened pull request, live and shadow), and check jobs with an `alert` (live and shadow);
  the generated workflow passes it to no other job and to no step but "Run
  the job".
- **Held by:** the runner only, and only its delivery step reads it; it is
  removed from the environment of lbx, the box, `collect.ts` and
  `render.ts`, and scrubbed from every report file.
- **Stored in:** a agents repository secret, set 2026-10-01 00:03 UTC;
  the app "Notes Co Agent Reports" is invited to #system-health, to
  #product (`C0TEST00001`) and to the shadow channel #agents-shadow
  (`C0TEST00002`).
- **Create:** at https://api.slack.com/apps, Create New App, From a
  manifest, workspace Notes Co, with the manifest below; Install to
  Workspace; then
  `gh secret set SLACK_AGENTS_POST_TOKEN --repo notes-co/agents`
  and paste the Bot User OAuth Token at the prompt, which does not echo
  it. In each channel a live job posts to, `/invite` the app's bot, and
  add the channel's id to the `post` list of `channels.yml`; do the same
  for the shadow channel, whose id goes in `shadow` in `channels.yml`.
- **Revoke:** https://api.slack.com/apps, the posting app, OAuth and
  Permissions, Revoke All OAuth Tokens; then Reinstall to Workspace for a
  new token and set the secret again. To stop all posting at once, remove
  the app from the workspace.

The posting app's manifest:

```yaml
display_information:
  name: Notes Co Agent Reports
  description: Posts the reports of agents jobs. Cannot read.
features:
  bot_user:
    display_name: Notes Co Agent Reports
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

### `ELEVENLABS_API_KEY`

- **Grants:** an ElevenLabs API key on the Notes Co account, for text to
  speech: the narration of demo videos. It spends the account's character
  quota.
- **Used by:** `media.ts` of a job whose `media.secrets` lists it (the demo
  videos job, once it exists); the generated workflow passes it only to
  that job's "Run the job" step.
- **Held by:** the runner, which gives it to that job's `media.ts` and to
  nothing else: it is removed from the environment of lbx, the box,
  `collect.ts` and `render.ts`, and scrubbed from every report file.
- **Stored in:** agents repository secret, set 2026-10-05.
- **Revoke:** in ElevenLabs, Developers, API Keys: delete the key; create a
  new one (restricted to text to speech if the account offers scoped
  keys) and
  `gh secret set ELEVENLABS_API_KEY --repo notes-co/agents`.
- **Status:** the key's restrictions and the account it belongs to are not
  recorded; fill them in here.

### `LIVETESTS_MAILBOX_USER`, `LIVETESTS_MAILBOX_APP_PASSWORD`

- **Grants:** the address of the shared live-test mailbox and an app
  password for it, which reads its mail over IMAP (Gmail). `media.ts` uses
  them to sign in to the dashboard: it asks for a magic link and reads it
  from the mailbox. Anyone holding both can read every sign-in link sent
  to that address, so they can sign in as the live-test user.
- **Used by:** `media.ts` of a job whose `media.secrets` lists them
  (demo-videos, docs-screenshots, scenario-checks); scenario-checks hands
  them to the scenarios run, which signs in and reads invite mail
  with them. backend's old copy of the password is no longer used.
- **Held by:** the runner, which gives them to that job's `media.ts` and to
  nothing else; both are removed from the environment of lbx, the box,
  `collect.ts` and `render.ts`. The password is scrubbed from every report
  file; the address is not, since it is not secret and may show on screen.
- **Stored in:** agents repository secrets, set 2026-10-05.
- **Revoke:** sign in to the mailbox's Google account, Security, App
  passwords: remove the password; create a new one and set it here
  (`gh secret set LIVETESTS_MAILBOX_APP_PASSWORD --repo notes-co/agents`).

### `EXPLORER_INGEST_TOKEN`

- **Grants:** pushing a scenario run's progress to the explorer
  (`https://explorer.notes-co.example`, tailnet only): its
  `/ingest/runs/<run id>/start`, `/messages` and `/finish` calls. Anyone
  holding it and on the tailnet can add runs that open explorer pages show
  until the run's own results artifact replaces them; it reads nothing.
- **Used by:** `media.ts` of a job whose `media.secrets` lists it
  (scenario-checks), which hands it to the scenarios run along with
  the explorer's URL (`EXPLORER_URL` in `jobs/scenario-checks/media.ts`,
  not a secret). Without it the run pushes nothing; a push that fails never
  fails or slows the run.
- **Held by:** the runner, which gives it to that job's `media.ts` and to
  nothing else: it is removed from the environment of lbx, the box,
  `collect.ts` and `render.ts`, and scrubbed from every report file. The
  explorer service holds the same value to check it.
- **Stored in:** agents repository secret, and
  `~runtime/stacks/explorer/.env` on hostc (owner runtime, 0600,
  never in git). Not set yet.
- **Revoke:** make a new random value (`openssl rand -hex 32`), set it in
  the stack's `.env` and restart the stack, then
  `gh secret set EXPLORER_INGEST_TOKEN --repo notes-co/agents`.
  Runs between the two steps push nothing, which costs only their live
  view.

### The YouTube grant

`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`,
`YOUTUBE_CHANNEL_ID`.

- **Grants:** `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET` are the
  OAuth client "Notes Co Publishing" (Desktop app) in the Google Cloud
  project `notes-labs-youtube` (YouTube Data API v3 enabled; consent screen
  External, published, unverified). Alone they grant nothing.
  `YOUTUBE_REFRESH_TOKEN` is the grant a channel manager gave that client
  for the "Notes Co" brand channel, with the scopes `youtube.upload`
  (upload videos) and `youtube.force-ssl` (manage the channel's videos,
  captions, thumbnails and playlists); with the client it makes access
  tokens that can do both on that channel. `YOUTUBE_CHANNEL_ID` is the
  channel's public id, `UCwXVcG-xmbKmm5EZ3ATLDgA`: not a secret, the
  channel the runner insists the grant answers for. The project has no
  API audit, so the kit uploads private only and a person publishes in
  YouTube Studio.
- **Used by:** live runs of jobs with `output.kind: youtube`; the
  generated workflow passes them to no other job, to no shadow run, and to
  no step but "Run the job".
- **Held by:** the runner only. They are removed from the environment of
  lbx, the box, `collect.ts` and `render.ts`, never given to the media
  stage, and the first three are scrubbed from every report file. The
  runner refuses a token with any scope but the two above, and a grant
  that `channels.list?mine=true` does not answer with exactly
  `YOUTUBE_CHANNEL_ID`.
- **Stored in:** agents repository secrets, set 2026-10-05. The
  owner's workstation keeps the copy the grant tool wrote.
- **Revoke:** the refresh token at https://myaccount.google.com/permissions,
  signed in as an account that manages the Notes Co channel: remove
  "Notes Co Publishing". A new grant then needs the consent flow again,
  choosing the Notes Co channel, and `YOUTUBE_REFRESH_TOKEN` set again.
  The client secret in the Google Cloud console, project
  `notes-labs-youtube`, APIs and Services, Credentials, the "Notes Co
  Publishing" client: add a new secret, set `YOUTUBE_CLIENT_SECRET`, then
  disable and delete the old one. To stop all uploads at once, delete the
  client or disable the YouTube Data API in that project.

### `BOX_REPO_TOKEN`

- **Grants:** a fine-grained personal access token with read-only access
  to the contents of lbx.
- **Used by:** every job workflow (checks out `lbx` at the pinned commit),
  Publish box image (also reads the release notes), Test lbx,
  the Network refusal check.
- **Held by:** the checkout step on the runner; it is not persisted into
  the checkout and never reaches the box.
- **Stored in:** agents repository secret.
- **Revoke:** the token's owner at
  https://github.com/settings/personal-access-tokens, or an org owner at
  https://github.com/organizations/notes-co/settings/personal-access-tokens/active.
  Then make a new token (lbx only, Contents read) and set the
  secret.
- **Status:** owner and expiry date not recorded; find them on the org's
  active token list above and fill them in here.

### `GH_TOKEN`

- **Grants:** a classic personal access token of the SpicyGrzl account
  (the Box release pull requests it opens are authored by SpicyGrzl). In
  agents it pushes the `box-release/<tag>` branch and opens the
  `box.yml` pull request, so it needs the `workflow` scope. Its full scope
  list is not recorded here.
- **Used by:** in agents, only Publish box image. The same org
  secret is used by more than 40 other org repositories.
- **Held by:** that workflow's pull request step on the runner.
- **Stored in:** org secret, visible to all repositories.
- **Revoke:** signed in as SpicyGrzl, https://github.com/settings/tokens,
  delete the token; then make a new one and set the org secret. Every
  repository that uses `GH_TOKEN` moves at once.

### `GITHUB_TOKEN`

- **Grants:** the workflow's own token. Job workflows ask for
  `contents: read` and `packages: read` (checkout, and pulling the pinned
  images from ghcr.io), and a check job's also for `actions: read`: its
  "Find the previous results" step (the runner, as `GH_TOKEN`) lists the
  environment's results artifacts and its download step fetches the
  newest; Publish box image asks for `contents`, `packages`
  and `pull-requests` write.
- **Held by:** the workflow's steps on the runner, never the box.
- **Revoke:** nothing to do; GitHub makes it per workflow run and it
  expires when the run ends.

## Made for one run

### GitHub installation token, per run

- **Grants:** made from the reader app for one run and narrowed to
  `actions`, `contents`, `metadata` and `pull_requests` read, plus
  `issues` or `organization_projects` read only when one of the job's tools
  needs it. A token granted more than it asked for is revoked and the run
  does not start.
- **Held by:** the runner and its github-mcp-server child; the box never
  sees it.
- **Lifetime:** at most an hour (GitHub's limit); revoked when the run
  ends, on every path.

### GitHub writer token, per delivery

- **Grants:** made from the writer app when a live run delivers, for the
  job's target repositories only, with `contents`, `pull_requests` and
  `checks` write and `metadata` and `members` read (only the first three
  while the installation has not accepted the other two). A token granted
  any other permission or repository is revoked and refused. The Revision
  poller makes a narrower one per started revision: `checks` write,
  `contents` and `metadata` read, on that repository only, to queue the
  round's check run.
- **Held by:** the runner only; the box and the second check never see
  it, and reports are scrubbed of it.
- **Lifetime:** at most an hour (GitHub's limit); revoked when delivery
  ends.

### YouTube access token, per delivery

- **Grants:** what the YouTube grant grants (upload and manage on the
  Notes Co channel), for at most an hour.
- **Held by:** the runner only; reports are scrubbed of it.
- **Lifetime:** made when a live youtube run delivers; forgotten when
  delivery ends and left to expire within the hour. It is not revoked:
  Google's revoke endpoint would end the whole grant, refresh token
  included.

### Gateway run key, per run

- **Grants:** calls to the run's model only, up to the run's worst-case
  cost, at most 2 at a time and 60 a minute. Alias
  `agents/<job>/<YYYY-MM>/<run name>`.
- **Held by:** the runner's model forwarder only; the box holds no key.
- **Lifetime:** the box's timeout plus 10 minutes; blocked when the box
  ends. Reports show its alias and sha256, never the key.

### Gateway media key, per run

- **Grants:** calls to the model a job's `media.model` names, up to its
  `usd_per_run` (at most $2), at most 2 at a time and 60 a minute. Alias
  `agents/<job>/<YYYY-MM>/<run name>-media`, so it counts in the job's
  month.
- **Held by:** the runner, which serves it to `media.ts` on a Unix socket
  that adds the key to each call; `media.ts` gets the socket's path,
  never the key.
- **Lifetime:** the media stage's `timeout_minutes` plus 10 minutes;
  blocked when `media.ts` ends. Reports show its alias and sha256, never
  the key.

## Model gateway on hosta

The stack is app-gitops `apps/hetzner/hosta/llm-gateway/`; its README
covers operating it. Its secrets are in `~runtime/stacks/llm-gateway/.env`
on hosta (mode 0600, owner `runtime`, never in git), with one recovery
copy of the whole file in the Scaleway Secret Manager secret
`llm_gateway_env` (shared-services, fr-par). After changing any of them:
update the recovery copy, then
`RUNTIME_UID=$(id -u) RUNTIME_GID=$(id -g) docker compose up -d --force-recreate litellm`
as `runtime` in the stack directory. The `.env` also has `GATEWAY_HOST`,
a leftover the compose file never reads; it is not a credential.

### Gateway `ACME_API_KEY`

- **Grants:** calls to the Acme model API from the gateway. A key of its
  own, created for the gateway on 2026-09-29, separate from the retired
  org secret's key.
- **Held by:** LiteLLM, which reaches Acme only through its egress relay.
- **Revoke:** create a new key in the Acme console, put it in the
  `.env`, update the recovery copy, recreate litellm, run
  `smoke.sh --live`, then revoke the old key in the Acme console.

### Gateway `ANTHROPIC_API_KEY`

- **Grants:** calls to the Anthropic API from the Anthropic Console
  workspace `agents`, which is used for nothing else and has its own
  monthly spend limit.
- **Held by:** LiteLLM only. It is never on GitHub and never in a box.
- **Revoke:** Anthropic Console, workspace `agents`, API keys: create a
  new key, put it in the `.env`, update the recovery copy, recreate
  litellm, then disable the old key. Disabling the key alone stops every
  Claude call and leaves the Acme models working.

### `LITELLM_MASTER_KEY`

- **Grants:** full admin of the gateway: the whole LiteLLM API and UI,
  served only on `127.0.0.1:4000` on hosta.
- **Held by:** LiteLLM; people use it through an SSH tunnel. It never
  leaves hosta.
- **Revoke:** generate a new one (`echo "sk-$(openssl rand -hex 32)"`),
  put it in the `.env`, update the recovery copy, recreate litellm.

### `LITELLM_SALT_KEY`

- **Grants:** encrypts the credentials LiteLLM stores in its database.
- **Held by:** LiteLLM.
- **Rotation:** never. Changing it makes the credentials already stored
  unreadable. A leak matters only together with the database or one of
  its backups; then replace the issuer key and every other key the gateway
  has issued.

### `POSTGRES_PASSWORD`

- **Grants:** the gateway's Postgres (keys, teams, spend), reachable only
  on the stack's internal network.
- **Held by:** LiteLLM and Postgres.
- **Revoke:** change the role's password in Postgres and in the `.env`
  together, update the recovery copy, recreate litellm.

### Gateway CA keys

- **Grants:** Caddy's private CA root ("Notes Co llm-gateway Root") and
  its intermediate, which issue the gateway's TLS certificate. The runner
  trusts only this root (`gateway-ca.pem`, public), so whoever holds the
  root key could impersonate the gateway to runners.
- **Held by:** Caddy.
- **Stored in:** `caddy-data/caddy/pki/authorities/local/` (mode 0600),
  and the nightly `caddy-data-*.tar.gz` archives in `backups/` (mode 0600,
  14 kept, on hosta only).
- **Revoke:** stop Caddy, empty `caddy-data/`, start Caddy so it creates a
  new root, export it into `gateway-ca.pem` (stack README, "The CA root for
  agents") and merge that before any run can reach the gateway again.
  Delete the old archives.

### hosta `runtime` ghcr.io login

- **Grants:** pulls from ghcr.io; the gateway needs it for the private
  egress relay image.
- **Held by:** docker on hosta, for the `runtime` user.
- **Stored in:** `~runtime/.docker/config.json` on hosta; its source is
  the Scaleway secret `ghcr_reg_cred` in shared-services, shared with other
  hosts.
- **Revoke:** revoke the token behind `ghcr_reg_cred` on GitHub, store a
  new one there, and log `runtime` in again (stack README, deploy step 1).
  Other hosts using `ghcr_reg_cred` need the same.

## Runners

### `notes-labs-ci` GitHub App private key

- **Grants:** the org-owned GitHub App `notes-labs-ci` (app id 4509729):
  `organization_self_hosted_runners` write and
  `organization_runner_custom_images` read. pool-a uses it to register
  the self-hosted runner VMs of both hosta pools (`hosta` CI and `agents`).
  Whoever holds it can register runners that receive org jobs.
- **Held by:** the pool-a server on hosta and on hostb. Each runner VM
  gets only a one-time just-in-time runner configuration, never the key.
- **Stored in:** hosta `/etc/pool-a/config.yaml`, mode 0600, root;
  the older copies beside it (`config.yaml.bak`, `config.yaml.before-*`,
  `config.yaml.v3.0`) are mode 0600 too; copies made before the
  2026-09-29 rotation hold the old, deleted key. hostb keeps its own
  copy.
- **Rotation:** rotated 2026-09-29 on both hosts after the key showed up
  in an agent session's output; the old key was deleted.
- **Revoke:** org Settings, Developer settings, GitHub Apps, `notes-labs-ci`
  (https://github.com/organizations/notes-co/settings/apps/notes-labs-ci),
  Private keys: generate a new key; on hosta drain the pools
  (pool-a-runner `host-setup/drain-and-restart.sh`), put the key in
  `/etc/pool-a/config.yaml` and restart pool-a; ask hostb's
  owner to do the same; then delete the old key.

## Credentials shared with atlas

The atlas-map-refresh Notes Agent uses these; atlas's old map
refresh workflow, which no longer publishes, holds them too.

### `NOTES_LABS_PROD_API_TOKEN`

- **Grants:** a Notes Co API token on prod for the SLO project
  (`vars.NOTES_LABS_PROD_PROJECT`), `project:view` and
  `project:portfolio:view`.
- **Used by:** the atlas-map-refresh Notes Agent (no model, daily), to read
  containment through backend's internal project path.
- **Stored in:** org secret, selected repositories: atlas,
  agents. The SLO project id is the agents repository secret
  `NOTES_LABS_PROD_PROJECT`.
- **Revoke:** on prod, the SLO project's Credentials page
  (`/app/<project uuid>/credentials`), revoke the token; create a new one
  with the same two permissions and set the org secret.
- **Status:** expiry date not recorded; read it on the Credentials page
  and fill it in here.

### `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`

- **Grants:** a Tailscale OAuth client that joins a GitHub-hosted runner
  to the tailnet as an ephemeral node tagged `tag:ci`, which reaches the
  private cluster addresses.
- **Used by:** atlas `atlas-map-refresh.yml`;
  in agents, the "Join the tailnet" step of a job with
  `media.network: tailnet` (demo-videos, docs-screenshots,
  scenario-checks), and no other step.
- **Stored in:** org secrets, selected repositories: backend, agents,
  atlas. backend has not used them since its live tests were removed.
- **Revoke:** Tailscale admin console, Settings, OAuth clients: revoke the
  client, create a new one with the same scopes and tag, and set both org
  secrets. agents and atlas move with it.
- **Status:** the client's exact scopes are not recorded; read them on the
  admin console and fill them in here.

## When a credential leaks

1. Revoke it at the issuer first (the Revoke step of its entry), before
   anything else.
2. Store the replacement and run the Tools smoke test (for tool
   credentials) or `hello` (for model keys).
3. Look for use in the window: the gateway's spend (`/team/info`), the
   provider consoles, GitHub's org audit log, OpenObserve.
4. Update "Rotation" in the table above.
