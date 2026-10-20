# The page template

Every repository page in an atlas follows one template: fixed frontmatter, an H1 that names the repository and its role, and eleven sections with stable lowercase headings in a fixed order. This page walks through the template with examples from notes-co's atlas, so a page can be written or reviewed without the schema beside it. The rules are binding; `flax atlas check` fails a page that breaks them.

## Frontmatter

```yaml
---
name: notes-api
repo: notes-co/notes-api
language: TypeScript
type: service
status: active
plane: app
deploy: test/live via notes-gitops pins
depends_on: [notes-core, notes-gitops, action-build-notes]
used_by: [notes-web, notes-cli, notes-worker]
artifacts: [ghcr.io/notes-co/notes-api]
default_branch: main
analyzed_commit: 4f2c9a1 2026-10-12
analysis_source: fresh-clone
---
```

- `type`: one of `service`, `library`, `cli`, `ui`, `gh-action`, `infra`, `gitops`, `docs`, `sample`, `data`, `tool`, `fork`.
- `status`: `active`, `maintenance`, `parked`, `deprecated`, `archived`, `sample`.
- `plane`: one of the planes the workspace's atlas section lists for the index (notes-co: `app`, `delivery`, `docs`). The index tables are generated from it.
- `deploy`: where and how it ships, in one line: `none`, environments via a mechanism, a registry image and chart, a package registry.
- `depends_on`: the internal repositories this one consumes at build, test, release or runtime, including the gitops repository its release pins into and the action repositories its workflows call. Names only; not the organization-wide license sync, not repositories that only produce its test data.
- `used_by`: generated, the inverse of every `depends_on`. Never hand-edited.
- `analyzed_commit`: the short commit and date the page describes. `analysis_source` is `fresh-clone` or `local-stale`.

## The H1

```
# notes-api: the notes service, one HTTP API over Postgres and a queue
```

A colon, then the role in at most 72 characters: what it is plus its role. The index row shows it; detail beyond it goes in `role`.

## The eleven sections

**`## tldr`**: three to six dense sentences, at most 800 characters. What it does, where it runs, what feeds it, what it feeds, current state. No dates, pull request numbers or history.

> notes-api serves the notes web app, the CLI and the worker over one HTTP API (`src/routes/`), stores notes in Postgres (`notes`, `folders`, `shares`) and publishes `note.changed` events to the `notes-events` queue that notes-worker consumes. It runs in test and live from the image notes-gitops pins. Authentication is a third-party identity provider; the API issues its own session tokens.

**`## role`**: why it exists, which flows it takes part in (name them: `publish-a-note`, `share-a-note`), its upstream callers and inputs, its downstream callees and outputs, naming repositories, queues, buckets and endpoints.

**`## architecture`**: the module map, one bullet per top-level module with its path and responsibility, covering all of them; the key entry points with paths; the process model for a service (threads, workers, cron, queue consumers).

- `src/routes/`: one file per resource (`notes.ts`, `folders.ts`, `shares.ts`), handlers only.
- `src/store/`: Postgres access through `db.ts`; migrations in `migrations/` run by `pnpm migrate`.
- `src/events/publish.ts`: publishes `note.changed` to `notes-events` after each write.

**`## data`**: databases and tables with their purpose, the migration directory and tool, buckets, queues (exact names), caches, on-disk formats; and ownership: which data this repository is the source of truth for.

**`## interfaces`**: for a service, a table of every route: route, method, handler path, auth, purpose. For a CLI, a commands and flags table. Events consumed and produced with their exact names. File formats read and written. For a library, its public surface.

| route | method | handler | auth | purpose |
|---|---|---|---|---|
| `/v1/notes` | GET | `src/routes/notes.ts` | session | list the caller's notes |
| `/v1/notes` | POST | `src/routes/notes.ts` | session | create a note; publishes `note.changed` |
| `/v1/shares/:id` | GET | `src/routes/shares.ts` | none | read a shared note by its share id |

**`## configuration`**: environment variables, config files and secrets: name, purpose, where it is read (a path). Chart or compose values that matter.

- `DATABASE_URL`: Postgres connection; read in `src/store/db.ts`.
- `QUEUE_URL`: the broker; read in `src/events/publish.ts`.
- `AUTH_ISSUER`: the identity provider; read in `src/auth.ts`. The client secret is `NOTES_AUTH_SECRET`, stored in notes-gitops's secret store.

**`## build-test-run`**: the exact commands that work (build, lint, test, run locally), toolchain pins, known local caveats.

**`## cicd`**: each workflow file, its trigger and what it does; the release path: how a change reaches each environment, the versioning scheme, image and chart publication.

- `.github/workflows/build.yml`: on push to `main`, builds and tests through `action-build-notes`, publishes `ghcr.io/notes-co/notes-api:<sha>`, and writes the pin into notes-gitops `apps/test/notes-api.yml`.
- Promotion to live is a pull request on notes-gitops that copies the test pin to `apps/live/`.

**`## keyfiles`**: a table from "to change X" to the files: the eight to fifteen most likely change tasks for this repository.

| to change | file |
|---|---|
| add a route | `src/routes/<resource>.ts`, `src/app.ts` |
| add a table | `migrations/<n>_<name>.sql`, `src/store/` |
| change what notes-worker receives | `src/events/publish.ts`, notes-worker `src/consume.ts` |

**`## invariants`**: gotchas, constraints, sharp edges, things that look wrong but are intentional, data safety rules.

- A share id is a capability: anyone with it reads the note. Never log it.
- `note.changed` is published after the commit; a consumer may see the event before a replica sees the row.

**`## recent`**: the newest five merged pull requests on the default branch, one line each: `- <YYYY-MM-DD>: PR #N (merge <sha7>) <what changed>`, the date in the workspace's time zone. Generated by `flax atlas recent`.

## Section files

A section that outgrows 8 KB moves whole to `repos/notes-api/interfaces.md`, whose first line is `# notes-api: interfaces (full detail)`. The main page keeps the heading, any short lead text, a pointer line ("Outline below; full detail in repos/notes-api/interfaces.md") and a generated outline. `tldr` and `recent` never move. The map's page reader resolves section files, so their full text reaches the wiring stage.

## What never goes on a page

- A home directory path, a local checkout, a worktree name, a personal tool path.
- A secret value. Secret names and where they are stored are fine.
- Narrative filler, marketing tone, prose padding added for readability.
- A fact with no anchor and no `UNVERIFIED` prefix.
- An em-dash in new text; US English throughout.

## To confirm against the package

- Whether the enum values for `type`, `status` and `plane` are fixed by the package or come entirely from the workspace's atlas section.
