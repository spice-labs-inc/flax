---
name: notes-api
repo: notes-co/notes-api
language: Go
type: service
status: active
plane: app
deploy: test/live via notes-gitops HelmRelease (ghcr image)
depends_on: [notes-core, action-build-notes, notes-gitops]
used_by: [notes-web]
artifacts: [ghcr.io/notes-co/notes-api]
default_branch: main
analyzed_commit: 0a1b2c3 2026-10-01
analysis_source: fresh-clone
---

# notes-api: the HTTP API: notes, users, sharing

## tldr
The Go HTTP API behind notes-web and notes-cli. It owns the notes-db Postgres database, validates Auth0 tokens, and publishes a note-events message to RabbitMQ for every change so notes-worker can send notifications.

## role
- The one service that touches the database.
- Called by notes-web and notes-cli over HTTPS; calls Auth0 to validate tokens (`internal/auth/`).
- Publishes to the `note-events` queue on RabbitMQ (`internal/events/publish.go`).

## architecture
- `src/` holds the whole program; one entry point at `src/main`.

## data
- Postgres database `notes-db`: tables `notes`, `users`, `shares`, `outbox`; migrations in `migrations/` run by `migrate` on start.
- Queue `note-events` on RabbitMQ (exchange `notes`), one message per note change; source of truth for the outbox.

## interfaces
Outline below; full detail in repos/notes-api/interfaces.md (open it before relying on anything here).

- HTTP routes, all under `/api/v1`, all behind an Auth0 bearer token (`internal/http/routes.go`):
- Events produced: `note-events` (exchange `notes`), payload `events.NoteEvent` from notes-core.
- Health: `GET /healthz` (no auth).

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
