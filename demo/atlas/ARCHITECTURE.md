# ARCHITECTURE: how the notes-co repos fit together

## Flow: publish a note
notes-web calls notes-api; notes-api writes notes-db and publishes note-events; notes-worker consumes the event and mails the people the note was shared with.

## Environments
Two clusters, test and live. Flux reconciles notes-gitops onto both; action-build-notes writes the test pin on every merge, live is promoted by a release PR.
