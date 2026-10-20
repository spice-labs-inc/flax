# INDEX: every notes-co repo (start here)

Read this first, then open only the `repos/<name>.md` you need. Cross-repo questions: ARCHITECTURE.md. Terms: GLOSSARY.md.

## Task routing (what to read for common tasks)
| Task | Read |
|---|---|
| Add an API endpoint | repos/notes-api.md |
| Change what the worker sends | repos/notes-worker.md |
| How a change reaches test and live | repos/notes-gitops.md, repos/action-build-notes.md |

## App plane
<!-- BEGIN GENERATED index-plane:app (flax atlas index; do not edit by hand) -->
| doc | status | role |
|---|---|---|
| repos/notes-api.md | active | the HTTP API: notes, users, sharing |
| repos/notes-cli.md | active | the `notes` command line: sync a folder of markdown with the API |
| repos/notes-core.md | active | shared Go library: note model, validation, event schema |
| repos/notes-web.md | active | the customer web app for writing and sharing notes |
| repos/notes-worker.md | active | queue consumer: notifications and digests |
<!-- END GENERATED index-plane:app -->

## Delivery plane
<!-- BEGIN GENERATED index-plane:delivery (flax atlas index; do not edit by hand) -->
| doc | status | role |
|---|---|---|
| repos/action-build-notes.md | active | reusable action: build, push the image, write the gitops pin |
| repos/notes-gitops.md | active | Flux source of truth: what runs on test and live |
| repos/notes-installer.md | active | install script and image that fetch the notes CLI |
<!-- END GENERATED index-plane:delivery -->

## Docs plane
<!-- BEGIN GENERATED index-plane:docs (flax atlas index; do not edit by hand) -->
| doc | status | role |
|---|---|---|
| repos/notes-docs.md | active | the public documentation site |
<!-- END GENERATED index-plane:docs -->
