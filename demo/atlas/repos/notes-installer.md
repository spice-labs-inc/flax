---
name: notes-installer
repo: notes-co/notes-installer
language: Shell
type: tool
status: active
plane: delivery
deploy: GitHub Release assets (install.sh) + Docker Hub image notesco/installer
depends_on: [notes-cli]
used_by: []
artifacts: [Docker Hub image notesco/installer]
default_branch: main
analyzed_commit: 0a1b2c3 2026-10-01
analysis_source: fresh-clone
---

# notes-installer: install script and image that fetch the notes CLI

## tldr
The install script and a small image that download the right notes-cli release binary from GitHub Releases and put it on PATH. Shipped by cutting a release.

## role
- Downloads release assets from GitHub Releases (`install.sh`).

## architecture
- `src/` holds the whole program; one entry point at `src/main`.

## data
- none.

## interfaces
- CLI: `install.sh [--version]`.

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
