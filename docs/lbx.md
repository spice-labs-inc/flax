# lbx, the sandbox

lbx (llm-in-a-box) is a separate open-source host tool, published from its own repository, `spice-labs-inc/lbx`, that runs coding agents inside locked-down boxes so an agent working without permission prompts cannot touch your host. The agents package depends on it for every model run, and nothing else in flax does. This page says what lbx is, its three runtimes, the unattended run mode flax uses, the network wall, and how it is configured, at the level a flax reader needs; the lbx repository's own documentation has the rest, with every claim tied to a test.

## What it is, and what it is not

A box is a plain docker container, a system container, or a virtual machine, with your project mounted at `/data`, an optional network wall with a per-session allowlist, and an unattended mode for scheduled jobs. It is host isolation, not an adversarial sandbox: it keeps an agent working on code you trust off your host, and it does not make untrusted inputs safe. A run box shares the host kernel, so a kernel escape reaches the host; lbx's own guidance is to run unattended jobs inside a disposable virtual machine that holds only what the job needs, which is what the agents package's reference runner pool does.

The launcher is one static binary written in Rust; the scripts that run inside the box (the entrypoint, the virtual machine setup) are shell. The in-box user is `agent`. The tool and its repository are both called lbx.

## Runtimes

| runtime | isolation | inner containers | host needs |
|---|---|---|---|
| docker | a privileged container | yes | docker |
| sysbox | user namespace plus system call virtualization | yes | docker plus sysbox |
| vm | a full virtual machine | yes, in the guest | qemu, KVM, ssh |

Interactive sessions (`lbx <name>`) pick a runtime by configuration or auto-detection, keep a session by name across all runtimes, and mount the current directory at `/data`. Unattended runs are docker only.

## Unattended runs

`lbx --run` runs one command, once, with no terminal, in a new box that is removed when the command ends, and returns the command's exit code. The run box is narrower than an interactive session: not privileged, four capabilities, no inner docker, no sudo; it mounts only the data directory you name, never the current directory; it reaches the network only through the relay of an enforcing policy, or has no network at all with `--no-network`; and only the host variables named with `--env` reach the command. Every refusal happens before any resource is created and before any file is written. Three opt-in additions change the picture, each on request only: a socket directory, a run with no network, and an AppArmor profile.

```
lbx --run --runtime docker (--net-policy <file> | --no-network) --data <dir> --timeout <seconds> \
    [--socket-dir <dir>] [--apparmor-profile] [--env NAME]... <name> -- <command> [args...]
```

The command runs as the box user, with your host user's name, user id and group id, in `/data`. The timer starts with the command, never the setup. The outcome is the status file `$LBX_STATE_DIR/runs/<name>/status`, one line, `status=<setup-failed|timeout|signal|exited> code=<n>[ cleanup=incomplete]`, written on the host in a directory never mounted into a box; the last line on standard error repeats it as `lbx-run: ...` for a reader, and a refusal prints `lbx-run: status=refused code=125` with no file. Exit codes: 125 a refusal or setup failure, 124 a timeout, the command's own code otherwise. A run name is used once per host.

How flax uses it: the agents runner starts every model run as `lbx --run --runtime docker --no-network --data <run's data directory> --timeout <from the job's turns> --socket-dir <the runner's sockets> <run name> -- <the coding agent>`, never with `--env` or `--net-policy`, and reads the status file afterwards. The socket directory is mounted read-only at `/run/agent` and holds the model forwarder's socket and, for a job with tools, the tools server's socket: live channels to servers the runner owns, which are the box's only way out. Before anything is created, the runner asks the lbx on `PATH` whether it has `--socket-dir` and `--no-network` (given either without `--run`, an lbx that has it answers "only valid with --run"), and refuses to start otherwise. See [agents/runtime.md](agents/runtime.md) and the grammar in [contracts.md](contracts.md).

Operational guidance from lbx itself, repeated here because the runner follows it: compute the status and deny log paths yourself rather than parsing them from standard error, open a deny log without following links, and treat its content as untrusted text.

## The network wall (netwall)

Without `--net-policy` an interactive session has no wall. With one, the box has no route and no DNS, and exactly one door: a per-session relay outside the box that matches host names against the policy and logs every refusal. Policies are JSON files (`{"mode": "open|enforce|locked", "allow": [...], "block": [...]}`) that live on the host where the box cannot write; three ship with lbx: `open` (allow everything, log every connection), `enforce` (deny by default, a starter allowlist of model providers, code hosts and package registries) and `locked` (deny by default, only the model endpoints). Deny beats allow, a name that resolves to a private, link-local, metadata or carrier-grade address is refused even when allowed, a numeric address is refused, a malformed policy fails closed, and the relay checks the TLS server name against the host that was asked for. Every refusal is one line in `$LBX_STATE_DIR/netlogs/<name>/deny.log` with a one-word reason.

A `--no-network` run has no relay and no deny log: the box has a loopback interface and nothing else, and no connection reaches a public address, a host listener or the metadata address. This is the mode the agents package uses for every model run; the sockets replace the network.

## Configuration

Precedence: a command line flag, then an environment variable, then the config file, then the default. The config file is `$LBX_CONFIG` (default `~/.config/llm_in_a_box/config`), `key=value` lines, owned by you and not writable by others.

| key | variable | default |
|---|---|---|
| `image.docker`, `image.sysbox`, `image.vm` | none | `llm-in-a-box:<runtime>` |
| `state.dir` | `LBX_STATE_DIR` | `~/.llm-in-a-box`: sessions, base disks, run status, deny logs |
| `vm.mem`, `vm.cpus`, `vm.accel` | `LBX_VM_MEM`, `LBX_VM_CPUS`, `LBX_VM_ACCEL` | 16384 MiB, 8, `kvm` |
| `vm.store.size`, `vm.store.disable` | `LBX_VM_STORE_IMG_SIZE`, `LBX_VM_STORE_DISABLE` | 500G sparse, unset |
| `runtime.default` | `LBX_RUNTIME_DEFAULT` | auto-detect: vm if built, else sysbox, else docker |

The in-box scripts read `LBX_NO_INNER_DOCKER` and `LBX_RUNTIME_TYPE`; `--env` refuses to pass any `LBX_`-prefixed name. The launcher accepts an older spelling of each variable for compatibility with boxes an earlier launcher created; new configuration uses `LBX_*`.

## The agent image

flax's agents package does not run jobs in lbx's full developer image (languages, build tools, several agents, many gigabytes). It builds a small agent image of its own on the same base, with the same box user, home layout, `/data` and entrypoint, holding the coding agent and one plugin, and pins it by digest; lbx's `image.docker` is set to it for runs. The image behaves like the full image under `lbx --run`. See [agents/runtime.md](agents/runtime.md).

## Pinning lbx in a workspace

A workspace names the lbx repository under `agents.sandbox` and pins a release tag and commit in its sandbox pin file; the reusable action downloads that release's static binary, checks its checksum and refuses to run unless the tag still names the commit. The release notes carry a machine-readable block (the tag, the commit, the binary's name) that the agents package reads to write the pin. Moving to a new lbx release is a pull request the agent image's publish workflow opens, merged by a person.

## To confirm against the package

- The release binary's name and the exact wording of the release notes block in the first lbx release.
