---
name: notes-gitops
repo: notes-co/notes-gitops
language: YAML
type: gitops
status: active
plane: delivery
deploy: none (Flux reads it)
depends_on: []
used_by: [notes-api, notes-worker]
artifacts: [none]
default_branch: main
analyzed_commit: 0a1b2c3 2026-10-01
analysis_source: fresh-clone
---

# notes-gitops: Flux source of truth: what runs on test and live

## tldr
The gitops repository Flux polls. One overlay per cluster under apps/<env>/ lists the applications and pins their image versions; action-build-notes commits the pins.

## role
- Flux on each cluster reconciles `apps/<env>/`; action-build-notes writes the pins.

## architecture
- `src/` holds the whole program; one entry point at `src/main`.

## data
- Version pins in `apps/<env>/<app>/patch.yml`.

## interfaces
- none.

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
