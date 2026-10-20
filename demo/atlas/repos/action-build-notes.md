---
name: action-build-notes
repo: notes-co/action-build-notes
language: YAML
type: gh-action
status: active
plane: delivery
deploy: none (consumed by ref; dominant pin @v2)
depends_on: []
used_by: [notes-api, notes-cli, notes-core, notes-docs, notes-web, notes-worker]
artifacts: [none]
default_branch: main
analyzed_commit: 0a1b2c3 2026-10-01
analysis_source: fresh-clone
---

# action-build-notes: reusable action: build, push the image, write the gitops pin

## tldr
The reusable GitHub Action every notes repo calls from publish.yml: builds the image, pushes it to ghcr.io and commits the new pin to notes-gitops for test.

## role
- Called by ref from every service repo's `publish.yml`.

## architecture
- `src/` holds the whole program; one entry point at `src/main`.

## data
- none.

## interfaces
- Inputs: `image`, `gitops-path`; see `action.yml`.

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
