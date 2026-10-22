# Tools

What the model and `collect.ts` may look up during a run, and how the
tools reach their upstreams without the box holding a credential. To add
one, see [adding-a-tool.md](adding-a-tool.md).

## How tools work

A tool lets the model look something up during a run (logs, pods, a
workflow run, a Slack channel) without holding the credentials behind it.
Each tool is a folder `tools/<name>/` with a `tool.yml` (our description,
an argument schema with a limit on every value, the upstream and the only
operations it may call there, a result cap) and a `map.ts`. A job lists
the tools it uses in `job.yml`, and `limits.tool_calls` and
`limits.tool_seconds` cap calls per run (200 by default) and seconds per
call (60 by default).

The box has no network path to the credentials. On the runner, the tools
server (`src/tools-server/`) is an MCP server on `tools.sock` in the
runner's socket directory ([Socket transport](runtime.md#socket-transport)), and Pi's
plugin ([`images/agent/pi-mcp-mailbox/`](../images/agent/pi-mcp-mailbox/))
connects to `/run/agent/tools.sock`. The server serves only the job's tools, checks every call, caps and marks every
result as data, and records every call for the run report. Each `tool.yml`
says whether its results can carry text anyone can write
(`source: untrusted`: pull request and issue bodies, Slack messages, log
lines, web pages) or only text a person reviewed or our own systems wrote
(`source: trusted`); every call and result carries that tag, and the run
report says whether the model saw untrusted text.

The tools read OpenObserve (`logs-streams`, `logs-schema`, `logs-search`,
`metrics-range`, `traces-latest`, `traces-search`), the Kubernetes
clusters dev, staging, prod and shared-services (`k8s-pods`,
`k8s-events`, `k8s-pod-log`, `k8s-helmreleases`, `k8s-namespaces`), GitHub
(`gh-workflow-runs`, `gh-job-log`, `gh-pull-requests`, `gh-open-prs`,
`gh-merged-prs`, `gh-releases`, `gh-commits`, `gh-compare`, `gh-file`, `gh-release-file`, `gh-maintainer-notes`, `gh-run-report`, `gh-board-items`, `gh-product-epics`, and at one commit `gh-grep`, `gh-path-history`, `gh-blame`, `gh-tree`) and the Slack alert channels
(`slack-history`), plus `echo`, a stand-in that reads nothing. Behind them,
the runner starts each upstream with only its own credential:
kubernetes-mcp-server per cluster (namespaces are listed by the tools
server itself, with one fixed read), github-mcp-server with a read-only token
made for the run (maintainer notes, run reports, comparisons and the code reads at a
commit are read by the tools server itself, with the same token), OpenObserve's REST API through a port-forward over the
shared-services Kubernetes API, and a Slack adapter. Only allowlisted read
operations are ever called, and results are scrubbed of customer ids and
secrets before the model sees them. The two MCP server binaries are pinned
by version and checksum in `mcp-servers.yml` and downloaded with
`flax agents fetch-servers <dir>`.

For a job that lists tools, `flax agents run-job` does this around the box:

1. before the box starts: download the pinned MCP server binaries (when a
   tool reads Kubernetes or GitHub) and start the upstreams the job's tools
   use, both in the run directory outside the data directory; start the
   tools server on `tools.sock`;
2. start Pi with the job's tool names added to its `--tools` allowlist
   (the plugin, which registers them, is loaded for every run);
3. after the box stops: stop the tools server and the upstreams (the GitHub
   token is revoked), and put `tools.json` (every call with its result) and
   every message (`socket/in/` and `socket/out/`) into the report;
4. check every quote of a tool result in the answer (any object with a
   `tool` and a `quote`) against what that tool returned in the run; a
   quote no tool returned fails the run.

A job without tools gets no tools server and no `tools.sock`; the plugin
still loads, for the model shim. A stub run (`--stub`) of a job with tools starts the tools server with no
upstreams, so it needs no credentials and reaches nothing. See
[docs/adding-a-tool.md](adding-a-tool.md).

`collect.ts` can gather its input through the same tools. A job names them
in `collect_tools`, and `limits.collect_tool_calls` caps the calls (200 by
default). The runner then starts the upstreams before `collect.ts` and
gives it a second tools server, serving only those tools, on a mailbox in
the run directory outside the data directory. `collect.ts` connects with
`connectCollectTools()` from `src/collect/tools.ts`, still without any
credential, and gets results already scrubbed of customer ids and secrets.
Its calls go into the report as `collect/tools.json` and
`collect/mailbox/`. `jobs/system-health-report/collect.ts` is the example.

## Tools smoke test

The manual workflow "Tools smoke test" (Actions tab, `flax agents tools-smoke`)
starts each upstream exactly as a run does, with the real secrets, and makes
only read-only calls: each MCP server's tool list and one trivial read per
upstream. It prints tool names, counts and PASS or FAIL per upstream, never
results or secret values, and fails if any upstream fails. Run it after
changing a tool's upstream, a pin in `mcp-servers.yml`, a secret, or the
reader accounts behind them.
