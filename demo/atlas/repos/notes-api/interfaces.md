# notes-api: interfaces (full detail)

- HTTP routes, all under `/api/v1`, all behind an Auth0 bearer token (`internal/http/routes.go`):
  - `GET /notes` list the caller's notes
  - `POST /notes` create a note
  - `PUT /notes/{id}` update a note
  - `POST /notes/{id}/share` share with another user
- Events produced: `note-events` (exchange `notes`), payload `events.NoteEvent` from notes-core.
- Health: `GET /healthz` (no auth).
