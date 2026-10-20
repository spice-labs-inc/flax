---
name: notes-web
repo: notes-co/notes-web
language: TypeScript
type: ui
status: active
plane: app
deploy: test/live via notes-gitops HelmRelease (ghcr image)
depends_on: [notes-api, action-build-notes]
used_by: []
artifacts: [ghcr.io/notes-co/notes-web]
default_branch: main
analyzed_commit: 0a1b2c3 2026-10-01
analysis_source: fresh-clone
---

# notes-web: the customer web app for writing and sharing notes

## tldr
A SvelteKit single-page app served from its own container. It calls notes-api over HTTPS for everything and holds no data of its own. Logins go through Auth0 and the API validates the token.

## role
- Front door of the product; the only surface customers see.
- Calls notes-api at `/api/v1/**` over HTTPS (`src/lib/api.ts`).

## architecture
- `src/` holds the whole program; one entry point at `src/main`.

## data
- none; every read and write goes through notes-api.

## interfaces
- HTTP: serves the SPA at `/`; no API of its own.

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
