---
name: notes-cli
repo: notes-co/notes-cli
language: Rust
type: cli
status: active
plane: app
deploy: GitHub Release binaries (3 targets) + install.sh
depends_on: [notes-core, action-build-notes]
used_by: [notes-installer]
artifacts: [GitHub Release assets notes-x86_64-linux, notes-aarch64-darwin, notes-x86_64-windows]
default_branch: main
analyzed_commit: 0a1b2c3 2026-10-01
analysis_source: fresh-clone
---

# notes-cli: the `notes` command line: sync a folder of markdown with the API

## tldr
The Rust CLI customers run on their own machines. It syncs a local folder of markdown notes with notes-api over HTTPS and keeps a local SQLite cache of what was synced. Shipped as release binaries with an install script.

## role
- Runs on the customer's machine; calls notes-api at `/api/v1/notes` over HTTPS (`src/api.rs`).

## architecture
- `src/` holds the whole program; one entry point at `src/main`.

## data
- Local SQLite cache `~/.notes/cache.db` (`src/cache.rs`); not a service store.

## interfaces
- CLI: `notes sync <dir>`, `notes login`, `notes status`.

## configuration
- `NOTES_ENV` selects the environment (test or live); read in `src/config`.

## build-test-run
- `make build && make test`; toolchain pinned in `.tool-versions`.

## cicd
- `.github/workflows/ci.yml` runs on every PR; `publish.yml` runs on main and calls action-build-notes.

## keyfiles
| to change | file |
|---|---|
| the build | `Makefile` |

## invariants
- Never log a note body.

## recent
none
