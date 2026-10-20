---
name: notes-docs
repo: notes-co/notes-docs
language: Markdown
type: docs
status: active
plane: docs
deploy: GitHub Pages at docs.notes.example via deploy.yml
depends_on: [action-build-notes]
used_by: []
artifacts: [none]
default_branch: main
analyzed_commit: 0a1b2c3 2026-10-01
analysis_source: fresh-clone
---

# notes-docs: the public documentation site

## tldr
The Astro documentation site for customers, published to GitHub Pages on every merge to main. It documents the web app, the CLI and the API.

## role
- Customer documentation; links to the API reference notes-api serves.

## architecture
- `src/` holds the whole program; one entry point at `src/main`.

## data
- none.

## interfaces
- none (static site).

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
