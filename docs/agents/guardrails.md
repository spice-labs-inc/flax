# Guardrails

A scheduled agent that reads text nobody controls (repository contents, log lines, chat messages) and writes to places people trust (pull requests, channels) has to be held by code, not by prompts. This page is the design of those guardrails: what the agents package enforces, in the order a run meets it, and why each rule is there. Every rule below is a check, a runner behavior or a delivery behavior with its own tests in the package; `flax agents check` fails with one line per problem, naming the file and field.

## The shape of a run

1. The checks run against the workspace tree. A run never starts from a tree the checks reject.
2. The media stage (if any) runs on the runner with the network and its own secrets.
3. `collect.ts` builds the input, by code, through its own tools server.
4. The runner reads the month's spend from the gateway and refuses a run whose worst case would pass the job's or the team's budget.
5. The runner asks the gateway for a key for this run alone and starts the forwarder on a Unix socket.
6. The sandbox starts with no network: a fresh data directory holding the prompt, the input and the schema; a read-only directory of sockets as its only way out.
7. The model answers. The answer is checked: schema, quotes, the pull request checker, the citation and attribution checks, the untrusted-input gate, then the second check by another model in a fresh sandbox.
8. Code delivers: a pull request on an agent branch, or one chat message to a listed channel. The key is blocked and its spend read into the report.

Each step is a guardrail, and no step can be switched off by a job.

## No provider key in a job, anywhere

A job never holds a model provider's key. The workflow holds one secret for the model path, the gateway issuer key, and it reaches the runner process alone: never the sandbox, never `collect.ts`, `render.ts`, `publish.ts` or `media.ts`. The sandbox is started without `--env`, so no host variable reaches it, and the coding agent inside gets a placeholder key the forwarder drops. Every report file and the run summary go through a scrubber that knows every secret the run touched, including keys issued during the run; a value that shows up anyway is replaced with `[redacted]` and the run fails, asking for rotation.

Why: a key inside a sandbox is a key a misled model can read from its own environment and send anywhere a tool reaches. Keeping it out of the sandbox altogether, behind a forwarder that allows one path and one model, limits what the sandbox can ask for at all.

## Per-run gateway keys with time and dollar ceilings

Right before the sandbox starts, the runner asks the gateway for a key for this run alone: only the run's model, a budget equal to the run's worst case (every token of `tokens_per_run` at the model's higher price), a lifetime of the sandbox's timeout plus ten minutes, two calls at a time and sixty a minute, and an alias naming the job, the month and the run. The gateway refuses any call once the key has spent its budget. When the sandbox ends, on success, failure or a thrown error, the runner blocks the key and reads its spend into the report; a key it could not block marks the run incomplete and fails it, and the key still expires on its own.

The workspace's gateway settings carry the gateway's own ceilings on a key's dollars and minutes, and the check refuses a job whose worst case could never get a key, so the failure happens in review and not on the first run.

## The forwarder

The sandbox reaches the model through one Unix socket. Behind it is the forwarder, an HTTP server in the runner process that passes on only the messages endpoint (`POST /v1/messages`) and the catalog entry of the run's model, forces the run's model, caps `max_tokens` at `tokens_per_run`, drops every header the sandbox sends except the API version, beta and accept headers, adds the run's key, answers anything else with a 404 without calling the gateway, and records every request and reply in `forwarder.json` in the report. The media stage gets a forwarder of its own on its own socket when its job asks for a model, with a key capped at the stage's `usd_per_run`.

## Budgets

Three ceilings, each enforced by a different party. The job's `usd_per_month` and the workspace's shared monthly budget are checked by the runner before each run, against spend read from the gateway (the sum over this job's keys of the month, by alias; the package keeps no ledger of its own). The per-run worst case is enforced by the gateway on the run's key. The gateway's team budget is enforced by the gateway on every key. A stub run or a preflight reaches no gateway and checks only the worst case.

## Runs are fenced in

The sandbox has no network at all: lbx runs it with `--no-network`, so the box has a loopback interface and nothing else. Its one way out is the socket directory mounted read-only at `/run/agent`, holding `model.sock` and, for a job with tools, `tools.sock`. The data directory is fresh per run, owned by the runner, mode 0700, outside the home directory, and holds only the prompt, the input and the schema before the run; files the sandbox wrote are read without following links, up to a size cap. The coding agent gets a fixed tool set (read, grep, find, ls; bash when the job says `shell: true`; the job's own tools by name) and loads nothing it finds on its own: no discovered extensions, skills or instruction files.

Before anything is created, a real run asks the lbx on `PATH` whether it has `--socket-dir` and `--no-network`, and refuses to start if not. The workspace pins the sandbox by release tag, commit and image digest, and the workflow refuses to run unless the tag still names the commit. A manual workflow, the network refusal check, proves the sandbox cannot reach the systems behind the tools by trying from inside the pinned box: every lookup and connection must fail with no route.

## Tools reach upstreams only through the tools server

A tool is a folder with a `tool.yml` (our own description, an argument schema with a bound on every value, the upstream and the only operations it may call, a result cap, and whether its results are `trusted` or `untrusted`) and a mapping. The tools server runs in the runner process, serves only the job's tools over `tools.sock`, checks every call against the schema and the method gate, caps and marks every result as data, scrubs it, and records every message in the report. The upstreams start on the runner with their own credentials, once per run, in a work directory outside the data directory; the sandbox never shares anything with them but the socket. `collect.ts` gets a second tools server of its own, on a mailbox outside the data directory, serving only `collect_tools`, so deterministic collection never opens a second, unchecked path to the credentials. See [tools.md](tools.md).

## Untrusted input is tracked

Every tool result carries its tool's `source` tag, and the report records whether the model saw untrusted text, for the model or for `collect.ts` (since that can reach the model through the input). A job says in its output what such a run delivers: `report_only` keeps the plan or message in the report, `open_pr` or `post` goes ahead and says so. Pick `report_only` unless the job cannot work without such text and a person reviews everything anyway.

## After the answer: checks, the second check, delivery

What happens once the model has answered is the other half of the design and has its own page, [checks.md](checks.md): the answer is read as one JSON value with one repair turn, every pull request passes code checks (paths, limits, patches, citations, attribution, tool quotes) before a second model in a fresh sandbox approves it, and delivery is done by code that holds the only write credential. Nothing on that page can be switched off by a job either.

## Allowlists change rarely, jobs change freely

Models with their prices and levels, channels with their ids, repositories, link hosts and the MCP server binaries (pinned by checksum) each live in a file the check validates and code owners review. A job may use only what is listed. Budgets add up under one shared cap, so adding a job forces the conversation about which jobs are worth it.

## To confirm against the package

- The exact check names and messages as the package prints them.
- Whether every private rule listed in the original guardrails document ships, or some stay private extensions (the chat-platform specifics, the video delivery rules).
