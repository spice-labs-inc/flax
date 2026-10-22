# Tools

Each tool a job can call lives in its own directory here, `tools/<name>/`,
holding `tool.yml` and `map.ts`, and a job lists the tools it uses by name
in the `tools` field of its `job.yml`. `pnpm check` validates every tool
and fails if a job names a tool that is missing or invalid. See
[docs/adding-a-tool.md](../docs/adding-a-tool.md).

Tools are read-only: they fetch or look things up and never change anything
outside the run. Writing, posting and opening pull requests are done by the
job's output step, not by tools, so every side effect goes through the output
rules in `job.yml`.

Every tool is reviewed by the code owners before it lands, because any job may
use it once it exists. The tools read OpenObserve, the Kubernetes
clusters, GitHub and the Slack alert channels; `echo` is a stand-in that
returns its argument and reads nothing. A run of a job that lists tools
starts the tools server and the upstreams behind them on the runner, and
the model calls them through the mailbox plugin in the box.
