# Runtime

Where a job runs, what starts inside the sandbox, how the sandbox talks to the runner, and how the sandbox and the agent image are pinned. The short version: a job is a generated workflow that runs the committed runner bundle; the runner starts lbx with no network and a directory of Unix sockets; the agent image holds the coding agent and one small plugin; and every piece is pinned by digest, release tag or exact version.

## Where jobs run

`flax agents generate` turns each `job.yml` into a workflow in the workspace's `.github/workflows/`, on the runner labels the workspace names, with read-only access to the workspace repository, a timeout derived from the job's turn limit, and one run at a time per job. A job starts on its cron, after another job succeeds, or by hand from the Actions tab. The generated workflow checks out the workspace, sets up Node, runs the preflight (`node dist/run-job.mjs <job> --preflight`), then one step that gets the secrets and calls the package's reusable action, which pulls the pinned agent image, fetches the lbx release binary the workspace pins (from the repository the `sandbox` key names) and checks its checksum, puts `lbx` on `PATH`, and runs `node dist/run-job.mjs <job>`. Every `flax agents` command takes `--workspace <dir>` or reads `FLAX_WORKSPACE`, and otherwise works in the current directory.

The workflow installs nothing from a registry. `dist/` in the workspace holds the runner as one ES module (the runner, the tools server, every tool mapping and the runtime dependencies, importing only Node's own modules), one bundle per job script, and a manifest with the sha256 of each bundle and of every source it was built from. `flax agents generate --dist` rebuilds it from the locked dependencies, with the same bytes on every machine. Before every run the bundled runner checks the manifest against the tree it runs in and refuses to start when something changed since the build. Pull requests never change `dist/`; a workflow rebuilds it on the default branch after each merge.

A run checks the job, builds a fresh run directory, writes the prompt (with the preamble), the input and the schema into the data directory, starts the tools and the forwarder, starts the box, reads the answer, checks it, delivers, and keeps a report as the run's artifact: the input, the answer, every tool and model call, the agent's transcript, timings, the maintainer notes, and `status.json` and `summary.md` saying how it went. A job with `model: none` runs no model: its workflow pulls no image, and the runner builds the answer from the media stage and delivers it.

## lbx and the run box

Every model run is one `lbx --run`: one command, once, no terminal, in a box removed when the command ends. The runner gives lbx `--no-network` and `--socket-dir <dir>`, a data directory, a timeout, and never `--env` or `--net-policy`. The box has only a loopback interface. Its one way out is the socket directory, which lbx mounts read-only at `/run/agent`:

- `model.sock`: the forwarder. The coding agent's provider calls the model over HTTP on a loopback address, and a small shim in the agent's plugin passes each connection byte for byte to this socket; the forwarder adds the run's key outside the box, forces the model, caps `max_tokens`, allows only the messages endpoint and the catalog entry, and records every call.
- `tools.sock`: the model's tools server, for a job with tools (see [tools.md](tools.md)).

The socket directory is created fresh for each run, mode 0700, in the user runtime directory, else in `/dev/shm`, else in the run directory. The runner checks lbx's rules itself before lbx starts (owned by the runner user, not group or world writable, not a link, outside the home, data, state and configuration directories, only the runner's own sockets inside, a path short enough for a Unix socket) so the failure is clear, and removes the directory when the run ends, on every path. lbx enforces the same rules again.

Before anything is created, a real run asks the lbx on `PATH` whether it has `--socket-dir` and `--no-network`: given either flag without `--run`, an lbx that has it answers "only valid with --run", an older one "Unknown option". The run refuses to start on the wrong answer. `--apparmor-profile` is never passed; the socket transport does not depend on it.

The outcome of a run is the status file lbx writes on the host (`status=<exited|timeout|signal|setup-failed> code=<n>`, with an optional `cleanup=incomplete`), never standard error; the runner reads it and keeps it in `status.json`. See [../lbx.md](../lbx.md) for the grammar.

## The agent image

Two images exist. The full lbx image is for developers: languages, build tools, several agents, many gigabytes; jobs never run in it. The agent image is for jobs: the coding agent, the package's own plugin (the model shim and the tools client) and, when the workspace names one, a model provider plugin, on a plain Ubuntu base with Node, and nothing else. The image this repository publishes carries no provider plugin; a workspace that names one builds its own image from the same definition with two build arguments (the package and its version) and pins that, and the action refuses a pinned image whose provider plugin label is not the plugin the workspace names. Every job runs on a fresh runner that pulls the image, so a small one saves minutes on every run. It behaves like the full image under `lbx --run`: the same in-box user (`agent`), home layout, `/data` directory and entrypoint.

The image's definition pins exact versions of Node (with checksums), the coding agent and both plugins; the check refuses a tag or a range. The build verifies the installed versions, that every flag the runner passes to the agent still exists, that the plugins are owned by root in a directory the box user cannot change, and that the plugin loads. A publish workflow builds the image for a given lbx release, runs it once under `lbx --run` with no network, and prints the digest, release, commit and launcher checksum a workspace pins; the workspace writes them with the package's pin command and opens a pull request. Jobs move to a new box only when a person merges that pull request.

The pin lives in the workspace: the lbx release tag, the commit it names (whose `lbx` launches the run), and the agent image by digest. With placeholders and `pinned: false`, checks warn and real runs are refused, so a workspace can be set up before its first publish without any job running on an unknown box.

## Model gateway

Only the runner talks to the gateway, at an address the workspace names, trusting only the gateway's private CA root committed in the workspace and checking the certificate's server name. It holds one secret for the model path, the issuer key, and uses it to read the month's spend, issue the run's key, block it when the run ends and read what it spent. The sandbox never sees the gateway. See [gateway.md](gateway.md) for the reference deployment and the alternative static provider mode.

## Thinking levels and models

Every run passes the job's level to the coding agent, so no run depends on the agent's default. The models file lists each model with its prices (the worst case is computed at the higher one) and the levels it honors; the gateway's catalog must list the same names, prices and levels, and the forwarder passes the level fields through unchanged. A run started by hand may pick another listed model or level, recorded in the report.

## Networks

The box has none. The runner reaches the gateway and the upstreams through the runner's own network. A media stage may join a named private network (a workflow step the workspace defines, joined just before the run step and left right after, on every path) to reach internal addresses; the model's box never joins anything. The network refusal check is a manual workflow that starts the pinned box as a run does, with a probe in place of the agent, and tries lookups and connections to every system behind the tools and to a public site; every attempt must fail with no route, and a control must reach a listener on loopback inside the box.

## To confirm against the package

- The reusable action's exact inputs.
