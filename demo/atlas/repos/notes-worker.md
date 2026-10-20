---
name: notes-worker
repo: notes-co/notes-worker
language: Go
type: service
status: active
plane: app
deploy: test/live via notes-gitops HelmRelease (ghcr image)
depends_on: [notes-core, action-build-notes, notes-gitops]
used_by: []
artifacts: [ghcr.io/notes-co/notes-worker]
default_branch: main
analyzed_commit: 0a1b2c3 2026-10-01
analysis_source: fresh-clone
---

# notes-worker: queue consumer: notifications and digests

## tldr
The Go worker that consumes note-events from RabbitMQ and sends share notifications and daily digests over SMTP. It reads notes-db for digest content and never writes to it.

## role
- Consumes the `note-events` queue on RabbitMQ (`internal/consume.go`).
- Sends mail through the SMTP relay named in `SMTP_HOST` (`internal/mail/`).
- Reads notes-db for digest content (`internal/digest/`).

## architecture
- `src/` holds the whole program; one entry point at `src/main`.

## data
- Reads Postgres `notes-db` (tables `notes`, `shares`); owns nothing.

## interfaces
- Queues: consumes `note-events`; produces nothing.
- CLI: `notes-worker run` and `notes-worker digest --date`.

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
