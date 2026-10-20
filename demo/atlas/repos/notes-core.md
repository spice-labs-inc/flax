---
name: notes-core
repo: notes-co/notes-core
language: Go
type: library
status: active
plane: app
deploy: Go module on GitHub (tag v*), consumed by go.mod
depends_on: [action-build-notes]
used_by: [notes-api, notes-cli, notes-worker]
artifacts: [github.com/notes-co/notes-core (Go module)]
default_branch: main
analyzed_commit: 0a1b2c3 2026-10-01
analysis_source: fresh-clone
---

# notes-core: shared Go library: note model, validation, event schema

## tldr
The Go module shared by notes-api, notes-worker and notes-cli: the note model, validation rules and the note-events message schema. Published as a Go module by tag; no runtime of its own.

## role
- Linked into notes-api, notes-worker and notes-cli at build time.

## architecture
- `src/` holds the whole program; one entry point at `src/main`.

## data
- none.

## interfaces
- Public API: `notes.Note`, `notes.Validate`, `events.NoteEvent` (`events/schema.go`).

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
