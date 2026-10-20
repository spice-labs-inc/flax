# Tools

A tool lets the model, or the job's `collect.ts`, look something up during a run (a workflow run, a file at a commit, a log line, a pod) without holding the credential behind it. This page explains what a tool is, how a call travels from the sandbox to an upstream and back, what every call goes through, and how a workspace adds one.

## What a tool is

A tool is a folder `tools/<name>/` in the workspace holding exactly two files:

- `tool.yml`: the tool's name (equal to the folder name), a description of 20 to 1,000 characters written by you (it is what the model reads about the tool, so it is yours, never an upstream's), the argument schema, the upstream it reads and the only operations it may call there, a result cap of at most 128 KB, and `source: trusted` or `source: untrusted`.
- `map.ts`: the mapping from the tool's arguments to the upstream's call and from the upstream's answer to the tool's result.

The argument schema is a strict JSON Schema object with no extra properties, and it puts a bound on every value: strings a maximum length (or an enum), numbers a minimum and maximum, arrays a maximum count, nested objects no extra properties. Combining keywords (`$ref`, `anyOf`, `oneOf`) are refused. The model chooses the arguments, so every value needs a bound the tools server can enforce before anything reaches an upstream.

`source` says whether the tool's results can carry text anyone can write (pull request and issue bodies, chat messages, log lines, web pages: `untrusted`) or only text a person reviewed or your own systems wrote (`trusted`). Every call and result carries that tag, and the run report records whether the model saw untrusted text, which decides what the run may deliver.

A job lists the tools the model may call in `tools`, and the tools `collect.ts` may call in `collect_tools`. `limits.tool_calls` caps calls per run (200 by default), `limits.tool_seconds` seconds per call (60 by default), and `limits.collect_tool_calls` the calls of `collect.ts`.

## How a call travels

The sandbox has no network and no credential. On the runner, the tools server is an MCP server listening on `tools.sock` in the runner's socket directory, which lbx mounts read-only at `/run/agent` inside the box. The coding agent's plugin connects to that socket and registers the job's tools by name. A call goes:

1. The model calls a tool. The plugin sends one JSON-RPC message, one line, over the socket.
2. The tools server checks the message (the framing, the method gate, the size limits: requests up to 64 KB, replies up to 256 KB, at most three times the call limit plus fifty messages over the run, one connection per box), validates the arguments against the schema, and refuses what the job did not ask for.
3. The mapping turns the arguments into one allowlisted read operation on the upstream, which runs on the runner with its own credential.
4. The result is capped, scrubbed of secrets and customer identifiers, marked as data (so the model is told it is a result, not an instruction), tagged with the tool's `source`, and sent back.
5. Every message in and out is recorded in the report (`socket/in/`, `socket/out/`), and `tools.json` lists every call with its result.

The repair turn's box gets a new session on the same socket, under the same calls, limits and record.

## What the runner does around the box

For a job that lists tools, a real run refuses to start while a secret one of its upstreams needs is not set, naming it. Before the box starts it downloads the pinned MCP server binaries only when a tool needs one, starts only the upstreams the job's tools read from, once per run, in a work directory inside the run directory and outside the data directory, then starts the tools server. The coding agent gets the job's tool names after its own read-only tools in its allowlist. When the box stops, the tools server and the upstreams stop, the work directory is removed, any token made for the run is revoked, and the record goes into the report, also when the run failed. A job without tools gets no socket and no server. A stub run starts the tools server with no upstreams behind it, so it needs no credentials and reaches nothing.

Every tool credential is removed from the environment of lbx, the box, `collect.ts`, `render.ts` and `publish.ts`, so it reaches the runner process alone, and the generated workflow passes a job only the secrets its listed tools' upstreams need.

## Collecting through tools

`collect.ts` can gather the input through the same tools. The runner starts the upstreams of every tool the job names once, before `collect.ts`, and gives it a second tools server serving only `collect_tools`, on a mailbox in the run directory outside the data directory, never mounted into the box. `collect.ts` connects through the package's client, still without any credential, and gets results already scrubbed. Every call goes through the same checks, caps and records as the model's, and the record goes into the report as `collect/tools.json`. Deterministic collection is cheaper and better than having the model gather everything, and it must not bring back a second, unchecked path to the credentials; one allowlist, one scrubber and one audit trail cover every read.

## Quoting tool results

An answer may quote a tool result: any object with a `tool` and a `quote`. After the run, every quote is checked against what that tool returned in this run, and a quote no tool returned fails the run. A pull request job with `tool_citations: true` may cite such a quote as the evidence for a changed line, and the second check sees the quote.

## Upstreams

The package ships the readers for the upstreams the reference jobs need: the code host (workflow runs, job logs, pull requests, releases, commits, comparisons, files and trees at a commit, search within a commit), and an echo tool that reads nothing, for stubs and proofs. The reference tools under `tools/` in the demo workspace are built on them. Readers for a log store, a cluster or a chat platform follow the same shape: an upstream started on the runner with one credential, a fixed list of read operations, and a scrubber; the private workspaces that run flax carry their own.

Two tests keep the upstreams honest. The tools smoke test starts each upstream exactly as a run does, with the real secrets, lists its tools and makes one trivial read per upstream, printing pass or fail and never a result. The network refusal check (see [runtime.md](runtime.md)) proves the box cannot reach the systems behind the tools by trying.

## Adding a tool

1. Create `tools/<name>/` with `tool.yml` and `map.ts`. Name the upstream and the operations; bound every argument; pick `source`.
2. Run `flax agents check`. It validates the schema, the bounds, the operations against what the upstream offers, and loads the mapping.
3. Write a test with a fake upstream: the mapping's arguments in, the operation out, the result shape back.
4. List the tool in a job's `tools` or `collect_tools`, run `flax agents generate` (the workflow gains the upstream's secrets, and only those), and `flax agents run-job <job> --stub`.
5. If the upstream needs a new credential, document its name, where it is stored and how to revoke it in the workspace's credentials page, in the same change.

## To confirm against the package

- Which upstream readers ship in the first public version beyond the code host and echo.
- The published client entry `collect.ts` imports to reach its tools server.
