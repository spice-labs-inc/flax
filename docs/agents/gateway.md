# The model gateway

Every model call a job makes goes through a gateway. The gateway holds the real provider keys, issues a short-lived key for each run with a dollar and time ceiling, counts spend, and refuses a key that has spent its budget. This page describes the reference deployment the `gateway` package ships, the five endpoints and the catalog fields the agents package depends on, and the static provider mode for people who do not want to run a gateway.

## Why a gateway

The guardrail story only holds with a gateway in the picture: a job never holds a provider key, it gets a per-run key capped in time and dollars, and spend is read from the gateway, never trusted from the job. A direct provider key cannot do that: it cannot be capped per run, it cannot be blocked when the run ends, and it tells you what you spent only after the bill. So the gateway layer ships with the agents package: the runner-side key and budget code, the forwarder, the catalog format, and the reference deployment. A stranger runs the reference gateway with their own provider key and gets the same per-run keys and budgets the original deployment has.

## The reference deployment

`packages/gateway` is a compose stack: the gateway itself (LiteLLM, a third-party open-source model proxy) with its Postgres; Caddy in front with a certificate from the gateway's own private certificate authority, serving the runner-side endpoints and nothing more; an egress relay (the lbx relay image) that lets the gateway reach the provider hosts and nothing else; `bin/make-ca.sh`, which writes a private CA and a server certificate with openssl, so every deployment has its own CA and nothing is ever copied; `bin/bootstrap.sh`, which turns the workspace's models file into the gateway's model list and catalog, creates the team and issues the issuer key; `bin/smoke.sh`, which proves every endpoint answers; and systemd units for a nightly backup of the database and the certificates.

`.env` beside the compose file must set every variable, and compose refuses to start with any missing: `GATEWAY_BIND_ADDR` (the address runners reach, published on 8443), `GATEWAY_SERVER_NAME` (the name the certificate is issued for; it never has to resolve), `PROVIDER_API_HOST` and `PROVIDER_API_KEY` (one non-Anthropic provider; Anthropic is allowed by `ANTHROPIC_API_KEY`), `EGRESS_RELAY_IMAGE` pinned by digest, the gateway's master and salt keys, the database password, `MONTHLY_BUDGET_USD`, `KEY_MAX_USD`, and the runtime user's ids. The full LiteLLM API and admin site are reachable only on the gateway host's loopback.

The workspace's side is a small `gateway.yml` at its root: the `https` URL with no path, the certificate's `server_name`, the `team`, the `ca` file name (the CA root, committed beside it), and the ceilings `key_max_usd` and `key_max_minutes`, which mirror the gateway's own upper bounds so a job that could never get a key fails in review. The CA file holds CA certificates only, each valid today; a private key or any other block is refused. There is no `enabled` switch: with `keyMode: litellm`, every run goes through the gateway.

## The five endpoints

The runner reaches the gateway at the configured URL over TLS, with the issuer key as a bearer token: a team service account key that may issue, block and read the keys of its team, and nothing else. It calls:

1. `GET /team/info?team_id=<team>` before a run: `team_info.spend` and `team_info.max_budget` for the monthly check, plus `keys[].key_alias` and `keys[].spend` to attribute spend to a job and month. A job's month is the sum over the keys whose alias starts with `<team>/<job>/<YYYY-MM>/`; blocked and expired keys keep their spend, so the package keeps no ledger.
2. `POST /key/generate` right before the box starts: `team_id`, `key_alias` (`<team>/<job>/<YYYY-MM>/<run>`), `models` (the run's model only, by its gateway name), `max_budget` (the run's worst case in dollars, at most `key_max_usd`), `duration` (the box's timeout plus ten minutes, at most `key_max_minutes`), `max_parallel_requests`, `rpm_limit` and `metadata` naming the job, run, month and model. It reads `key` (the run key, which never leaves the runner process) and `token` (the key's id).
3. `POST /key/update` with `{ key, blocked: true }` when the box ends, on every path. A blocked key keeps its row and its spend. A key the runner cannot block marks the run incomplete and fails it.
4. `GET /key/info?key=<id>` after the gateway's spend write: `info.spend`, what the run cost, into the report. A failed read is noted and does not fail the run.
5. `GET /v1/models/info`, with no key: the catalog, a JSON object keyed by gateway model name. The forwarder relays it to the box narrowed to the run's model, and the agent's plugin reads the model's levels from it.

The forwarder relays exactly two things from the box to the gateway: `POST /v1/messages` (the Anthropic Messages API, with the run key added) and that narrowed catalog. Everything else the box asks for gets a 404 without a call. Every provider behind the gateway must serve the Messages API, because it is the only model API the forwarder relays.

What the run says when something goes wrong: an unreachable gateway, a certificate the pinned CA does not vouch for, a refused issuer key or a refused key request each fail the run before anything starts, naming the gateway and the cause; a job or team over budget is refused before any key is issued, with the spend and the limit; a per-run budget reached means the gateway refuses the next call and the run fails; a key that cannot be blocked fails the run with the answer kept.

## The catalog fields

The workspace's `models.yml` is the source of truth; `bin/bootstrap.sh models <path>` turns it into the gateway's model list and catalog, and is rerun whenever it changes. Per model: `id` (`<provider>/<name>`; the gateway knows the model as `<name>`, jobs name the full id), `provider` (`anthropic` routes to Anthropic with its key; any other value routes to the one `PROVIDER_API_HOST`), `usd_per_million_input` and `usd_per_million_output` (the prices the gateway bills and the catalog shows; the runner's worst case uses the same numbers, so they must be what the provider charges), `thinking` (the levels a job may ask for; absent means every level) and `confirmed: false` for a placeholder that is left out of the gateway and refused by the runner. The catalog entry carries the name, the prices and the levels; a model needing more (a context window, a display name) gets it from an overrides file beside the compose file.

## The static provider mode

The alternative for a plain host: one provider key, no gateway, nothing to deploy. In the workspace's `agents` section:

```yaml
agents:
  provider: { name: anthropic, baseUrl: https://api.anthropic.com, keyMode: static }
```

with one repository secret, `MODEL_API_KEY`. This is the default when the section says nothing. The forwarder adds that key to each call instead of a per-run key; the sandbox still holds no key, the forwarder still relays one path and one model and still caps `max_tokens`, and the runner's own worst-case check against the job's monthly limit still runs. What static mode cannot do: cap a single run at the provider, block a key when the run ends, or read back spend the job cannot influence; every run uses the same key, and only the runner's worst-case arithmetic limits it. Pick it to get started; move to `keyMode: litellm` when runs must be capped at the provider, which is before any job runs unattended on a schedule.

## Operating the reference gateway

1. Write `.env` (secrets from `openssl rand -hex 32`, mode 600).
2. `bin/make-ca.sh <server name> ./certs "<org name>"`; copy `certs/ca.pem` to the workspace root under the name `gateway.yml` gives. Two years later, reissue the server certificate with the same CA and the workspace keeps working.
3. `bin/bootstrap.sh models <workspace>/models.yml`, then `docker compose up -d`.
4. `bin/bootstrap.sh team --issue-runner-key` creates the team (its models the catalog's, its budget `MONTHLY_BUDGET_USD`, its keys allowed to call the key endpoints only) and prints the issuer key once; store it as the workspace repository secret `LLM_GATEWAY_ISSUER_KEY`. It lasts ninety days; run the command again before then and replace the secret.
5. `bin/smoke.sh` from the host or any runner, with the CA root and the issuer key: one line per endpoint, a run key issued exactly as the runner asks, its spend read back, the key blocked and refused; `--live` adds one tiny real call and checks that spend was recorded.
6. Enable the backup timer and copy `backups/` off the host: a lost CA means a new CA in every workspace, a lost database means lost spend history.

Keep `KEY_MAX_USD` and `MONTHLY_BUDGET_USD` equal to the workspace's numbers. Old months' keys can be deleted on the admin site when the team's key list gets large; the package never deletes them.

## To confirm against the package

- Whether the package's check compares `models.yml` prices with the gateway's catalog at check time or only at run time.
