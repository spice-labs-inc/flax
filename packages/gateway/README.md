# gateway: the reference model gateway

A LiteLLM deployment the flax agents runner calls instead of the model provider: LiteLLM, Postgres, Caddy in front with a certificate from the gateway's own private CA, and an egress relay that lets LiteLLM reach the provider hosts and nothing else. The gateway holds the real provider keys. Each run gets its own short-lived key, limited to its model and its worst-case cost; the gateway records what every key spent, and the runner reads the month's spend from it before each run.

The runner talks to the gateway over TLS pinned to the CA root in the workspace (`gateway.yml ca`), checked against `gateway.yml server_name`, and holds one secret, `LLM_GATEWAY_ISSUER_KEY`: a LiteLLM team service-account key that may issue, block and read keys of its team (`gateway.yml team`). That key stays in the runner process. The sandboxed box never sees the gateway, the issuer key or the run key.

## What the runner calls

Five endpoints, all with the issuer key as a bearer token except the catalog:

| call | what the runner sends and reads |
|---|---|
| `POST /key/generate` | sends `team_id`, `key_alias` (`<team>/<job>/<month>/<run>`), `models` (gateway model names), `max_budget` (USD, at most `key_max_usd`), `duration` (`<n>m`, at most `key_max_minutes`), `max_parallel_requests`, `rpm_limit` and `metadata` (job, run, month, model). Reads `key` (the run key) and `token` (the key's id, the sha256 of the key). |
| `POST /key/update` | sends `{key, blocked: true}` when the run ends. A blocked key keeps its row and spend. |
| `GET /key/info?key=<id>` | reads `info.spend`: what the run cost. |
| `GET /team/info?team_id=<team>` | reads `team_info.spend` and `team_info.max_budget` for the monthly check, and `keys[].key_alias` with `keys[].spend` to sum a job's month by alias prefix. |
| `GET /v1/models/info` | no key. A JSON object keyed by gateway model name; each entry carries the name, prices per million tokens and the thinking levels the model honors. The runner's forwarder relays it to the box narrowed to the run's models. |

The box reaches the model only through the runner's forwarder on a Unix socket, which relays exactly two things to the gateway: `POST /v1/messages` (the Anthropic Messages API, with the run key added) and `GET /v1/models/info`. Everything else the box asks for gets a 404. Caddy serves the same short list on the runner side and nothing more; the full LiteLLM API and UI are on the admin site, `127.0.0.1:4000` on the gateway host only.

## Catalog fields

The workspace's `models.yml` is the source of truth; `bin/bootstrap.sh models` turns it into the gateway's model list and catalog. Per model:

| models.yml | required | becomes |
|---|---|---|
| `id` | yes | `<provider>/<name>`; the gateway knows the model as `<name>` (everything after the first slash). Jobs name the full id. |
| `provider` | yes | `anthropic` routes to `api.anthropic.com` with `ANTHROPIC_API_KEY`; any other value routes to `PROVIDER_API_HOST` with `PROVIDER_API_KEY`. One such provider per gateway. |
| `usd_per_million_input`, `usd_per_million_output` | yes | the prices LiteLLM bills (converted to per token; cache reads and writes at the input price) and the prices the catalog shows. The runner's worst-case budget uses the same numbers, so they must be what the provider charges. |
| `thinking` | no | the levels a job may ask for (`off`, `low`, `medium`, `high`, `xhigh`); the catalog lists them as the provider plugin's reasoning levels (`off` is `none`, `xhigh` is `max`). Absent means every level. |
| `confirmed: false` | no | a placeholder: left out of the gateway, refused by the runner. |

Every provider must serve the Anthropic Messages API at `https://<host>/v1/messages`, because that is the only model API the forwarder relays. A model needing more in its catalog entry (a context window, a display name) gets it from `models/overrides.json` next to the compose file, an object keyed by model name that is merged over the generated entries.

## Ten-minute path

A workspace picks its model provider in `flax.yml` under `agents.provider`. Two options:

**(a) One static key, no gateway.** `provider: { name: anthropic, baseUrl: https://api.anthropic.com, keyMode: static }` and one secret, `MODEL_API_KEY`. Nothing to deploy. There is no per-run key: every run uses the same key, and only the runner's own worst-case budget check limits a run. Pick this to get started; move to (b) when runs must be capped at the provider.

**(b) Per-run keys from this gateway.** `provider: { name: <pi provider name>, keyMode: litellm }`, this package deployed, a `gateway.yml` at the workspace root, the gateway's CA root next to it, and the secret `LLM_GATEWAY_ISSUER_KEY`.

```yaml
# gateway.yml
url: https://10.0.0.1:8443        # the address the runners reach the gateway at
server_name: gateway.example.internal   # the name in the gateway's certificate
team: agents                      # the LiteLLM team run keys belong to
ca: gateway-ca.pem                # the CA root, a file at the workspace root
key_max_usd: 25                   # the stack's KEY_MAX_USD
key_max_minutes: 120              # the longest a run key lives
```

The rest of this page is deploying (b).

## Deploying

Everything runs from one directory on the gateway host as one unprivileged user (the "runtime" user below): the compose file, `.env`, `certs/`, `models/`, `pgdata/`, `backups/`. Docker Compose v2, `jq`, `openssl` and `curl` on the host; `yq` or `node` to read `models.yml` (or hand the bootstrap a `models.json`).

### 1. Variables

`.env` next to `docker-compose.yml` must set every one of these; compose refuses to start with any missing.

| variable | what |
|---|---|
| `GATEWAY_BIND_ADDR` | the host address runners reach, published on port 8443 (the `url` in `gateway.yml`). Only runners and the host itself should be able to reach it. |
| `GATEWAY_SERVER_NAME` | the DNS-style name the certificate is issued for (`server_name` in `gateway.yml`); it never has to resolve. |
| `PROVIDER_API_HOST` | the host of the non-Anthropic provider, the only host besides `api.anthropic.com` the egress relay allows. With Anthropic only, set it to `api.anthropic.com`. |
| `PROVIDER_API_KEY` | that provider's API key. |
| `ANTHROPIC_API_KEY` | the Anthropic API key. |
| `EGRESS_RELAY_IMAGE` | the llm-in-a-box relay image, pinned by digest (`ghcr.io/<org>/llm-in-a-box-relay:<tag>@sha256:<digest>`). |
| `LITELLM_MASTER_KEY` | LiteLLM's master key (`sk-` plus a long random string); used only on the admin site. |
| `LITELLM_SALT_KEY` | the salt LiteLLM encrypts stored credentials with; never change it after the first start. |
| `POSTGRES_PASSWORD` | the database password. |
| `MONTHLY_BUDGET_USD` | the cap on all spend per calendar month (UTC), on the proxy and on the team. |
| `KEY_MAX_USD` | the most any one key may be issued with (`key_max_usd` in `gateway.yml`). |
| `RUNTIME_UID`, `RUNTIME_GID` | the runtime user's ids (`id -u`, `id -g`); Caddy, Postgres and the backup run as them. |

Generate the three secrets with `openssl rand -hex 32` (prefix the master key with `sk-`). Keep `.env` at mode 600.

### 2. Certificates

`bin/make-ca.sh` writes a private CA (ECDSA P-256, valid 10 years) and a server certificate for one name (2 years, SAN = the name) with openssl. Nothing is copied from anywhere; every deployment has its own CA.

```sh
bin/make-ca.sh gateway.example.internal ./certs "Example Org"
openssl verify -CAfile certs/ca.pem certs/server.pem
```

`certs/ca.pem` goes to the workspace root under the name `gateway.yml ca` gives (`gateway-ca.pem` above). The keys (`ca-key.pem`, `server-key.pem`) stay in `certs/`, mode 600, owned by the runtime user; Caddy reads the server key from there. Two years later, move `server.pem` and `server-key.pem` away and rerun the script with the same `ca.pem` and `ca-key.pem` in place to issue a new server certificate: the workspace keeps working without a change. The runner refuses anything but a CA certificate in that file, and refuses it once expired.

### 3. Models

```sh
bin/bootstrap.sh models /path/to/workspace/models.yml
```

writes `models/model_list.yaml` (LiteLLM's model list) and `models/models-info.json` (the catalog). Rerun it whenever `models.yml` changes, then `docker compose up -d --force-recreate litellm caddy`.

### 4. Start

```sh
sysctl -w net.ipv4.ip_nonlocal_bind=1   # if GATEWAY_BIND_ADDR exists only once a bridge is up
docker compose up -d
docker compose ps
```

### 5. Team and issuer key

```sh
bin/bootstrap.sh team --issue-runner-key
```

creates the LiteLLM team (its models are the catalog's, its budget `MONTHLY_BUDGET_USD` per month, its keys allowed to call `/key/generate`, `/key/update`, `/key/info`, `/key/list` and `/key/health` only) and prints a team service-account key once. Put it in the workspace repository secret `LLM_GATEWAY_ISSUER_KEY`. The key lasts 90 days; run the same command again before then and replace the secret. Without `--issue-runner-key` the command only creates or updates the team.

### 6. Smoke test

From the gateway host or any runner, with the CA root and the issuer key:

```sh
GATEWAY_URL=https://10.0.0.1:8443 GATEWAY_SERVER_NAME=gateway.example.internal \
GATEWAY_CA=certs/ca.pem LLM_GATEWAY_ISSUER_KEY=... GATEWAY_MODEL=claude-haiku-4-5 \
bin/smoke.sh
```

prints one line per endpoint: the catalog lists the model, the team's spend and budget, a run key issued exactly as the runner asks, its spend read back, and the key blocked and refused. `--live` adds one tiny real call with the run key and checks that spend was recorded (a zero means the model list has no prices).

### 7. Backups

`systemd/llm-gateway-backup.service` and `.timer` run `docker compose --profile jobs run --rm backup` nightly at 03:17 UTC as the runtime user: a Postgres dump (keys and spend) and an archive of `certs/` (the CA and keys) into `backups/`, 14 of each kept. Install them as user units:

```sh
mkdir -p ~/.config/systemd/user
cp systemd/llm-gateway-backup.* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now llm-gateway-backup.timer
loginctl enable-linger "$USER"
```

The service's `WorkingDirectory` expects the stack at `~/llm-gateway`; edit it if yours is elsewhere, and point `OnFailure` at an alert unit of your own if you have one. Copy `backups/` off the host; a lost `certs/` means a new CA in every workspace, a lost database means lost spend history.

## Reading spend

The admin site (`ssh -L 4000:127.0.0.1:4000 <host>`, then `http://127.0.0.1:4000/ui` with the master key) shows every key by alias, so a job's month is the keys under `<team>/<job>/<YYYY-MM>/`. The runner reads the same numbers from `GET /team/info`.
