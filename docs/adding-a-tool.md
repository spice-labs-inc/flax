# Adding a tool

A tool lets the model look something up while a job runs: logs, pods, a
workflow run, a Slack channel. Tools are read-only, and the model never
holds the credentials behind them.

`tools/echo/` is a complete, minimal example to copy from. It returns the
text it is given and reads nothing. The real tools are listed under
[The tools](#the-tools).

## How a call travels

```
run box (no credentials, no network)
  Pi + the pi-mcp-mailbox plugin
    one JSON-RPC message per line over /run/agent/tools.sock
runner (holds the credentials)
  the tools server, an MCP server listening on that socket
    -> the upstream named in tool.yml (see The upstreams)
```

The box has no network at all. lbx mounts the runner's socket directory
read-only at `/run/agent`, and the tools server listens on `tools.sock`
there (see [Socket transport](runtime.md#socket-transport)). The plugin
(`images/agent/pi-mcp-mailbox/`) connects over it at start, lists the tools,
and registers each with Pi under the name, description and argument schema
the tools server gives. The tools server lists exactly the tools the job
names in `job.yml`.

The plugin is bundled with its one dependency, the MCP client SDK, into a
single ES module that imports only Node's own modules
(`flax agents bundle-pi-plugin <file>`, `src/pi-plugin/bundle.ts`). The agent
image copies it to `/opt/pi-extensions/pi-mcp-mailbox.mjs`, root-owned,
next to the Acme provider, so it needs no `node_modules` in the image and
nothing from Pi, and the box user cannot change it.

## How a run starts the tools

For a job that lists tools, `flax agents run-job` (`src/run-job/tools.ts`):

1. refuses to start when a secret the job's tools need is not set, naming
   it;
2. downloads the pinned MCP server binaries into the run directory with
   their checksums checked, when a tool reads Kubernetes or GitHub;
3. starts only the upstreams the job's `tools` and `collect_tools` use,
   once, in a work directory in the run directory, outside the data
   directory (see [The upstreams](#the-upstreams)); for a job with
   `collect_tools` this happens before `collect.ts`, which gets a tools
   server of its own serving only those tools, on a mailbox in the run
   directory outside the data directory (`collect.ts` runs on the runner,
   not in the box), stopped when `collect.ts` ends;
4. starts the model's tools server on `tools.sock` in the run's socket
   directory, with the upstreams' scrubber;
5. starts the box with Pi loading the plugin (as for every run) and the
   job's tool names added to Pi's `--tools` allowlist after
   `read,grep,find,ls`, so a tool the job did not name never reaches the
   model;
6. when the box has stopped, stops the tools server and the upstreams,
   removes their work directory, and writes `tools.json` and every
   message over the socket (`socket/in/`, `socket/out/`) into the report;
7. checks the answer's quotes of tool results (see
   [Quoting tool results](#quoting-tool-results)).

The tool credentials are in the environment of the runner process only:
the generated workflow passes a job only the secrets its tools' upstreams
need, and `flax agents run-job` removes every tool secret from the environment
it gives lbx (so the box never sees them) and `collect.ts`. Each credential
value, the values inside it (a kubeconfig's token, the OpenObserve
password) and the installation token made for the run are scrubbed from
every report file like the gateway issuer key.

| Upstream      | Secrets passed to the job                                                                    |
| ------------- | -------------------------------------------------------------------------------------------- |
| `builtin`     | none                                                                                         |
| `kubernetes`  | `KUBECONFIG_DEV`, `KUBECONFIG_STAGING`, `KUBECONFIG_PROD`, `KUBECONFIG_SHARED_SERVICES` |
| `github`      | `AGENTS_READER_APP_ID`, `AGENTS_READER_PRIVATE_KEY`                                          |
| `openobserve` | `KUBECONFIG_SHARED_SERVICES`, `OPENOBSERVE_CI_AUTH`                                          |
| `slack`       | `SLACK_AGENTS_BOT_TOKEN`                                                                     |

A new credential (a new upstream, a new secret, or wider access for an
existing one) must be added to [credentials.md](credentials.md) in the same
pull request.

A stub run (`flax agents run-job <name> --stub`, and the offline test in
`pnpm test`) starts the tools server with no upstreams: it loads the job's
tools, starts the tools server on the tools socket, builds Pi's command
line and writes `tools.json`, but fetches nothing, needs no credentials and reaches
nothing. The stub answer calls no tools, so its quotes are not checked.

A job without tools gets no tools server and no `tools.sock`; the plugin
still loads, for its model shim.

## Quoting tool results

Any object in the answer with a string `tool` and a string `quote` is a
quote of a tool result. After a real run, each is checked against what the
tools server gave the model: `tool` must be one of the job's tools, and
`quote`, ignoring whitespace, must appear in a result that tool returned in
this run (for a JSON result, also in its string values without their
escapes), and be at least 6 characters besides spaces. A quote no tool
returned fails the run, and `status.json` lists each quote with whether it
was found (`src/run-job/evidence.ts`). Give a job's output schema such
objects when its answers must be traceable to a tool, as
`jobs/tools-proof/output.json` does.

The check proves the quote came from a tool, not that the answer reads it
correctly. To compare an answer with what the tool returned, open the
run's report: `tools.json` lists every call with its arguments, outcome and
the `result` the model got, and `answer.json` holds the answer.

## 1. Create the folder

```
tools/<name>/
  tool.yml    what the model is told, the argument schema, the upstream, the result cap
  map.ts      turns checked arguments into one upstream call
```

Nothing else may go in the folder, and neither file may be a link. The
name must be 2 to 41 lowercase letters, digits and dashes, starting with a
letter, and equal the folder name.

## 2. Write tool.yml

Schema: `schema/tool.schema.json`.

```yaml
name: echo
description: Returns the text it is given, unchanged. ...
arguments:
  type: object
  additionalProperties: false
  required: [text]
  properties:
    text:
      type: string
      description: The text to return.
      maxLength: 1000
upstream:
  server: builtin
  operations: [echo]
source: trusted
result_max_bytes: 4096
```

- `description`: 20 to 1000 characters, written by us. Never copy an
  upstream's tool description: it is third-party text the model would read
  as guidance.
- `arguments`: a JSON Schema (draft 2020-12) that compiles in strict mode,
  with a limit on every value: an object with
  `additionalProperties: false`, strings with `maxLength` (at most 16384)
  or an `enum`, numbers with `minimum` and `maximum`, arrays with
  `maxItems` (at most 100) and `items`. `$ref`, `anyOf`, `oneOf` and the
  other combining keywords are refused, so the limits can always be
  checked.
- `upstream.server`: the system the tool reads from: `builtin`,
  `kubernetes`, `github`, `openobserve` or `slack` (see
  [The upstreams](#the-upstreams)).
- `upstream.operations`: the only operations the tool may call there, from
  that upstream's list in `UPSTREAM_OPERATIONS` (`src/lib/tools.ts`). The
  tools server refuses any other, whatever `map.ts` returns, and the
  upstream refuses anything outside its own list again.
- `source`: `untrusted` when a result can carry text anyone can write
  (pull request and issue bodies and titles, comments, Slack messages, log
  lines, event messages, trace attributes, web pages, notes a model wrote),
  `trusted` when it carries only text a person reviewed before it landed
  or our own systems wrote (files and commits on `main`, releases, cluster
  state, metrics). When unsure, `untrusted`. Every call and result carries
  the tag, and a pull request job can refuse to open a pull request after
  its model saw untrusted text (`untrusted_input` in `job.yml`).
- `result_max_bytes`: at most 131072. Longer results are cut, and the model
  is told so.

## 3. Write map.ts

```ts
import type { ToolMapping } from "../../src/tools-server/mapping.ts";

const mapping: ToolMapping = {
  map: (args) => ({ operation: "echo", arguments: { text: args.text } }),
};

export default mapping;
```

`map(args, context)` gets arguments that already match `tool.yml`, and a
context with the time of the call (`now`) and the Slack channels tools may
read (`readChannels`). It returns one operation and the arguments to send
upstream. Put here what a schema cannot say: a time range of at most 24
hours, one `SELECT` with no `;`, a channel from `channels.yml`. Force
values the model must not choose, such as a row limit or
`return_content: true`. To refuse, throw `ToolRefusal` (from the same
module) with a message for the model. `src/tools-server/map-helpers.ts` has
the time-range check and small helpers the real tools share.

An optional `result(text, args)` trims the upstream's answer, for a limit
the upstream cannot apply itself (`k8s-events` keeps at most `limit`
events, since `events_list` has no limit). It runs before scrubbing and the
byte cap; if it throws, the call fails.

## 4. Check and test

```sh
flax agents generate
flax agents check
pnpm test
```

`map.ts` is built into the runner bundle, `dist/run-job.mjs`, which job
workflows run. Do not commit `dist/`: the Rebuild dist workflow rebuilds it
on main after the merge.
`tool.yml` is read from the tree at run time. `flax agents check` validates every
`tools/<name>/` (see [guardrails.md](guardrails.md)) and fails a job that
names a missing or invalid tool. Add the new tool to
`test/tools-catalog.test.ts`: the exact upstream call for its arguments,
each refusal, and that nothing reaches the fake upstream when it refuses.
A new upstream also needs tests against a
fake of it (`test/fake-upstreams.ts` has fake MCP servers over stdio and
HTTP, a fake GitHub API and a fake Slack API) in
`test/tools-upstreams.test.ts`. No test may reach a real system.

## 5. Use it in a job

List the name in the job's `tools:`. The job's `limits.tool_calls` (200 by
default, at most 1000) caps calls per run and `limits.tool_seconds` (60 by
default, at most 300) caps each call. Tool calls happen inside Pi's run,
which lbx already bounds by the job's run timeout (one minute per turn,
capped), so `tool_seconds` bounds only a single call and adds nothing to
the run's time or budget.

Adding or changing a tool needs code owner review (`CODEOWNERS`), because
any job may use it once it exists.

## What every call goes through

The tools server, not the tool, enforces these:

- the tool must be one the job lists;
- the job's call limit and per-call time limit;
- the arguments must match the schema;
- the operation must be one `tool.yml` lists;
- the result is cut to `result_max_bytes` and to what fits in one message,
  then wrapped with a note that it is data, not instructions;
- the call is recorded for the run report: tool, arguments, operation,
  the tool's `source` tag, outcome, time, result size and the result
  itself.

A refusal is a tool error the model sees, and nothing is sent upstream.
Error text from an upstream or from a `map.ts` that fails is wrapped as
data like a result. A request the Pi plugin refuses before sending (over
64 KB) shows only in Pi's transcript, because it never reaches the runner.

Every result, and every upstream error, is scrubbed before it is capped:
every UUID (customer org, project and report ids among them) collapses to
`:id`, as chicory does, and secret-shaped strings, the run's own credential
values and the query strings of signed URLs become `[redacted]`
(`src/tools-server/scrub.ts`).

## The upstreams

The runner starts the upstreams a job's tools use, each with only its own
credential (`startUpstreams` in `src/tools-server/start-upstreams.ts`), and
stops them when the run ends. MCP server children get a minimal environment
(`PATH`, `HOME` and the like) plus their own credential, and nothing else
of the runner's. Each upstream checks the operation name and the arguments
that matter once more before a call leaves the runner. At start, each MCP
server must offer every operation the tools call, or the run does not
start; the servers' own tool lists and descriptions are never passed on.
A stdio server's replies may be up to 64 MiB each (a pull request diff
with a committed bundle runs past 10 MiB, the SDK's default, which stops
the server). A server that stops mid-run fails the calls it had in hand
with the reason and the tail of its standard error, and is started again
for the next call, at most 3 times a run (`src/tools-server/mcp-upstream.ts`).

| Upstream      | What runs                                                                                                                                            | Credential                                                                                                                                                                                                      | Operations                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kubernetes`  | one `kubernetes-mcp-server` (stdio) per cluster: dev, staging, prod, shared-services; namespaces are listed by the tools server itself          | that cluster's `KUBECONFIG_<CLUSTER>`, written to a mode 0600 file                                                                                                                                              | `pods_list`, `pods_get`, `events_list`, `pods_log`, `resources_list`, `resources_get`, `namespaces_list`                                                                                                                                                                                                                                                 |
| `github`      | `github-mcp-server` (stdio)                                                                                                                          | an installation token of the `agents-reader` app, made for the run from `AGENTS_READER_APP_ID` and `AGENTS_READER_PRIVATE_KEY`, narrowed to the read permissions the job's tools need, revoked at the end | `actions_list`, `get_job_logs`, `list_pull_requests`, `pull_request_read`, `search_pull_requests`, `list_releases`, `get_latest_release`, `list_commits`, `get_file_contents`, `projects_list`, `list_issues`, `issue_read`, `maintainer_notes_list`, `compare_commits`, `run_report_read`, `commit_grep`, `path_history`, `commit_blame`, `commit_tree` |
| `openobserve` | OpenObserve's REST API (no MCP server), through a port-forward to the OpenObserve pod the tools server opens over the shared-services Kubernetes API | `KUBECONFIG_SHARED_SERVICES` for the forward, `OPENOBSERVE_CI_AUTH` (HTTP Basic) for OpenObserve                                                                                                                | `StreamList`, `StreamSchema`, `SearchSQL`, `SearchTracesSQL`, `PrometheusRangeQuery`, `GetLatestTraces`                                                                                                                                                                                                                                                  |
| `slack`       | `@slack/web-api`, no MCP server                                                                                                                      | `SLACK_AGENTS_BOT_TOKEN`                                                                                                                                                                                        | `conversations.history`, `conversations.replies`                                                                                                                                                                                                                                                                                                         |

- **kubernetes:** the config file sets `read_only = true`,
  `toolsets = ["core"]`, `enabled_tools` to the six operations and
  `denied_resources` to `v1/Secret`; the command line repeats
  `--read-only --toolsets core` and adds `--disable-multi-cluster`. The
  `config` toolset stays off, because its `configuration_view` returns the
  kubeconfig with its token. Every call names a `cluster`, which picks the
  server and is not passed on. `namespaces_list` does not go through
  kubernetes-mcp-server, whose table has no deletion time: the tools server
  makes one request, `GET /api/v1/namespaces` (with a `status.phase` field
  selector when a phase is asked for), with `@kubernetes/client-node` and
  the cluster's kubeconfig, and returns only each namespace's name, phase,
  creation time and deletion time. It takes no argument but `phase`
  (`Active` or `Terminating`). The reader account's `view` role already
  allows listing namespaces.
- **github:** `stdio --read-only --toolsets repos,pull_requests,actions
--tools <the twelve> --lockdown-mode`. `--tools` adds to the toolsets
  rather than narrowing them, so the server offers other read tools too;
  the tools server calls only the twelve. Every call must name the
  `notes-co` organization, `actions_list` only the
  `list_workflow_runs` and `list_workflow_jobs` methods,
  `pull_request_read` only its read methods, `search_pull_requests` only
  the query `org:notes-co is:pr is:open` (optionally with one
  `author:`) or `org:notes-co is:pr is:merged merged:>=<day>`, and no
  repository, `list_commits` only `main`, at most 50 commits and no other
  filter, `get_file_contents` only `refs/heads/main`, a release tag
  `refs/tags/vX.Y.Z`, or a commit by its full 40-character `sha` (not
  both a `sha` and a `ref`),
  `projects_list` only `list_project_items` of the organization's
  project 3 (the Engineering Board) with the `Status` field alone, at
  most 50 a page, filtered by `updated:>=<day>`, `status:` with board
  statuses, or both, `list_issues` only `notes-co/product` with
  the fixed fields (no body, author or assignees), no label or field
  filter, at most 100 a page and `since` only the start of a UTC day,
  `issue_read` only the `get` method on `notes-co/product`, and
  `get_job_logs` one job
  with `return_content: true`: without it the answer is a signed download
  URL that works as a credential until it expires. The run's token asks
  for `actions`, `contents`, `metadata` and `pull_requests` read, plus
  `organization_projects` read when a tool of the job calls
  `projects_list` and `issues` read when one calls `list_issues` or
  `issue_read` (`readPermissions` in `src/tools-server/github.ts`). If
  GitHub grants the token any permission it did not ask for, or any level
  beyond read, it is revoked and the run does not start. `maintainer_notes_list` does not go through github-mcp-server:
  the tools server reads the `job-<name>-maintainer-notes` artifacts of
  `agents` itself with the same token (one list request, then each
  download from the host GitHub redirects to, only an `https` host in
  `github-log-hosts.yml`, without the token), unpacks only
  `maintainer-notes.json` from each small zip and returns only notes that
  match the notes schema (`src/tools-server/artifacts.ts`). `compare_commits`
  is served by the tools server too: it makes one fixed `GET /repos/notes-co/{repo}/compare/{base}...{head}`
  with the same token, both ends commit shas (never a branch or tag),
  follows a redirect only within the API (a renamed repository), reads at
  most 32 MB, and returns the commits (sha, date, first line of the
  message) and files (path, status, line counts, and with `patch_lines`
  the first lines of each diff), leaving out the oldest commits and then
  the diffs of later files so the result stays under 100 KB and is never
  cut
  (`src/tools-server/compare.ts`). `run_report_read` is served by the tools
  server too: it reads one run's `job-<name>-report` artifact of
  `agents` the same way as the notes, unpacks only `status.json` and
  `input.json`, and returns names and counts from them, never page text or
  transcripts (`RunReportReader` in `src/tools-server/artifacts.ts`). The
  code reads are served by the tools server too, with the same token, each
  at a commit given by its full sha (`path_history` also by branch), and
  each tried again with backoff when GitHub answers with a 5xx or asks for
  a short wait (`src/tools-server/code-reader.ts`): `commit_grep` downloads
  the commit's tarball once per run (`GET /repos/notes-co/{repo}/tarball/{sha}`,
  then the download from `codeload.github.com` only, without the token, at
  most 300 MB), keeps it in the upstreams' work directory (at most eight a
  run, removed when the run ends) and searches it on the runner: text files
  only (no NUL byte in the first 8000 bytes), none over 1 MiB, the archive
  at most 1 GiB unpacked and 300,000 entries. The pattern is a JavaScript
  regular expression of at most 200 characters without back references,
  lookarounds or a repeated group that itself repeats or has alternatives,
  and it runs in a worker thread that is stopped when one batch of files
  takes over 10 seconds (`src/tools-server/code-grep.ts`). `path_history`
  and `commit_blame` are one fixed GraphQL query each (a path's history
  with each commit's pull requests; a file's text and blame at a commit),
  and `commit_tree` one `GET /repos/notes-co/{repo}/git/trees/{sha}?recursive=1`.
  They need no permission beyond `contents` and `pull_requests` read.
  transcripts (`RunReportReader` in `src/tools-server/artifacts.ts`).
- **openobserve:** our OpenObserve is v0.91.3, whose open-source build
  has no MCP server (that needs v0.92 or later), so the tools server calls
  the REST API directly, the same read endpoints the OpenObserve CLI and UI
  use: `GET /api/default/streams?type=logs` (StreamList, with
  `fetchSchema=true` when a tool asks which fields streams have),
  `GET /api/default/streams/{stream}/schema?type=logs` (StreamSchema),
  `POST /api/default/_search?type=logs` (SearchSQL),
  `POST /api/default/_search?type=traces` (SearchTracesSQL),
  `GET /api/default/prometheus/api/v1/query_range` (PrometheusRangeQuery)
  and `GET /api/default/{stream}/traces/latest` (GetLatestTraces). The
  open-source build enforces no roles, so the service account could write;
  the upstream builds only these six requests, in the `default`
  organization, and refuses any other operation or argument (a search
  gets one `SELECT`, a range of at most 24 hours, row 0, at most 100 rows
  and no query function). It returns a summary of each answer: stream
  names, types, sizes and newest record time, and which asked fields each
  has; field names and types; the total, time taken and
  rows of a search or trace list; the PromQL answer as is. Each connection
  to the local port opens its own forward to a ready pod labelled
  `app=openobserve` in `openobserve`, port 5080; when a forward cannot be
  opened, the pod is looked up again and the forward tried once more, and
  a request that fails before any answer is sent once more. At start, a
  `GET /healthz` through the forward (no credentials) checks that it
  opens. The forward needs `get` on `pods/portforward` (the WebSocket
  upgrade is a GET), not only `create`. Errors name the stage that failed
  (pod lookup, forward open, forward ready, forward dropped, HTTP) and the
  cause under it. The API
  server's service proxy is not used because it strips the
  `Authorization` header.
- **slack:** the adapter reads only channels in the `read` list of
  `channels.yml`, by channel id, at most 100 messages, from at most 24
  hours back, whatever the tool asked for, and returns only each message's
  ts, thread, user or bot, text, reply count and attachment text.

### The smoke test

The manual workflow "Tools smoke test" (`.github/workflows/tools-smoke.yml`,
Actions tab) runs `flax agents tools-smoke` on the agents pool with the real
secrets. It fetches the pinned binaries with their checksums checked, then
starts each upstream on its own exactly as a run does and makes only
read-only calls: each MCP server's tool list, and one trivial read per
upstream (`pods_list` in `flux-system` and `namespaces_list` on dev, `list_workflow_runs`
for agents, one `list_project_items` of the Engineering Board and
`list_issues` of `product`, then the code reads on agents (the
history of `README.md` on `main`, its first line's blame, the tree and a
grep of the newest commit to it), with a token asking for every read
permission a GitHub tool may need, OpenObserve `StreamList`, and `conversations.history`
with a limit of 1 on the first read channel). It prints tool names, counts
and PASS or FAIL per upstream, never results or credential values, and
fails if any upstream fails. Run it after changing an upstream, a pin or a
credential. It is written by hand, so `flax agents generate` leaves it alone
(only `job-*.yml` workflows are generated).

### The MCP server binaries

`mcp-servers.yml` pins `kubernetes-mcp-server` and `github-mcp-server` by
exact release and by the sha256 of each platform's release asset
(`linux-amd64` and `linux-arm64`), and `flax agents check` validates it.
`flax agents fetch-servers <dir>` downloads this platform's assets from the GitHub
releases, refuses any whose sha256 differs from the pin before writing
anything, unpacks `github-mcp-server` from its `.tar.gz`, and leaves both
executable in `<dir>`. To update a server, change its version and every
sha256 (from the release's asset digests, or its checksums file) in one
pull request.

## The tools

| Tool                  | Upstream                                               | Limits and forced values                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logs-streams`        | OpenObserve `StreamList`                               | log streams only; of each schema, only which of at most 10 named fields it has                                                                                                                                                                        |
| `logs-schema`         | OpenObserve `StreamSchema`                             | one log stream                                                                                                                                                                                                                                        |
| `logs-search`         | OpenObserve `SearchSQL`                                | one `SELECT`, no `;`, start and end required and at most 24 hours apart, at most 100 rows from row 0, log streams only, no query function                                                                                                             |
| `traces-search`       | OpenObserve `SearchTracesSQL`                          | the same limits as `logs-search`, trace streams only                                                                                                                                                                                                  |
| `metrics-range`       | OpenObserve `PrometheusRangeQuery`                     | range at most 24 hours, step at least 60 s (300 s by default)                                                                                                                                                                                         |
| `traces-latest`       | OpenObserve `GetLatestTraces`                          | at most 50 traces, range at most 24 hours, no `;` in the filter                                                                                                                                                                                       |
| `k8s-pods`            | kubernetes `pods_list`, `pods_get`                     | cluster from the four; a pod by name needs its namespace                                                                                                                                                                                              |
| `k8s-events`          | kubernetes `events_list`                               | at most 200 events (100 by default), newest first                                                                                                                                                                                                     |
| `k8s-pod-log`         | kubernetes `pods_log`                                  | at most 300 lines (100 by default)                                                                                                                                                                                                                    |
| `k8s-helmreleases`    | kubernetes `resources_list`, `resources_get`           | kind fixed to `helm.toolkit.fluxcd.io/v2` `HelmRelease`                                                                                                                                                                                               |
| `k8s-namespaces`      | kubernetes `namespaces_list`                           | name, phase, creation and deletion time only; optionally one phase                                                                                                                                                                                    |
| `gh-workflow-runs`    | GitHub `actions_list`                                  | `list_workflow_runs` and `list_workflow_jobs` only, `notes-co` repositories                                                                                                                                                                     |
| `gh-job-log`          | GitHub `get_job_logs`                                  | one job, `return_content: true` forced, at most 300 lines (100 by default)                                                                                                                                                                            |
| `gh-pull-requests`    | GitHub `list_pull_requests`, `pull_request_read`       | read methods only, `notes-co` repositories                                                                                                                                                                                                      |
| `gh-open-prs`         | GitHub `search_pull_requests`                          | query fixed to `org:notes-co is:pr is:open`, optionally one author; at most 100 per page, 10 pages; fields forced                                                                                                                               |
| `gh-releases`         | GitHub `list_releases`, `get_latest_release`           | `notes-co` repositories, at most 20, notes left out of the list                                                                                                                                                                                 |
| `gh-commits`          | GitHub `list_commits`                                  | `main` only, at most 50, no other filter                                                                                                                                                                                                              |
| `gh-compare`          | GitHub `compare_commits` (the tools server)            | two commit shas of one `notes-co` repository; commits and files, diffs only with `patch_lines` (at most 400 lines a file), the result kept under 100 KB                                                                                         |
| `gh-file`             | GitHub `get_file_contents`                             | `main`, or for a job with `pin_files` the commit its input's `repos` gives, or `ref` (`main` or a full sha); a plain relative path; a text file comes back after a first line with its blob sha, or only the lines `start_line` and `line_count` name |
| `gh-release-file`     | GitHub `get_file_contents`                             | a release tag `vX.Y.Z` only, a plain relative path; a text file comes back after a first line with its blob sha                                                                                                                                       |
| `gh-merged-prs`       | GitHub `search_pull_requests`                          | query fixed to `org:notes-co is:pr is:merged merged:>=<day>`, the day at most 31 days back; at most 100 per page, 10 pages; fields forced                                                                                                       |
| `gh-board-items`      | GitHub `projects_list`                                 | the Engineering Board (project 3) only, `Status` only; since a day at most 31 days back, board statuses, or both; at most 50 a page, by cursor; no ids, author or assignees in the result                                                             |
| `gh-product-epics`    | GitHub `list_issues`, `issue_read`                     | `notes-co/product` only; open, closed or both, since a day at most 31 days back; at most 100 a page, by cursor; fields forced; one epic by number with `get` only                                                                               |
| `gh-maintainer-notes` | GitHub `maintainer_notes_list` (the tools server)      | `agents` only, one job, at most 14 days back (7 by default), the newest 40 runs, notes only                                                                                                                                                     |
| `gh-run-report`       | GitHub `run_report_read` (the tools server)            | `agents` only, one run of one job by workflow run id; a digest of its report's `status.json` and `input.json`, names and counts only                                                                                                            |
| `gh-grep`             | GitHub `commit_grep` (the tools server)                | one commit by full sha; a safe regular expression of at most 200 characters, or plain text; optional path glob; text files up to 1 MiB; at most 200 matching lines (100 by default) and 60 KB, lines cut to 240 characters                            |
| `gh-path-history`     | GitHub `path_history` (the tools server)               | one path, on a branch (`main` by default) or from a full sha; at most 50 commits (20 by default) with author login and pull request number                                                                                                            |
| `gh-blame`            | GitHub `commit_blame` (the tools server)               | one text file at a full sha; at most 200 lines (100 by default) from `start_line`, each with its commit and pull request number                                                                                                                       |
| `gh-tree`             | GitHub `commit_tree` (the tools server)                | one commit by full sha, optionally under a prefix; files with sizes, at most 5000 (1000 by default) and 120 KB                                                                                                                                        |
| `slack-history`       | Slack `conversations.history`, `conversations.replies` | channels from the `read` list in `channels.yml`, at most 100 messages (50 by default), at most 24 hours back                                                                                                                                          |

Times are RFC 3339 with an offset, such as `2026-09-28T14:00:00Z`. An end
time more than five minutes in the future is refused.
