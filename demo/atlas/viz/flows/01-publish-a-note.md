---
id: publish-a-note
name: Publish a note
plane: app
summary: How a note typed in the web app becomes an email in a collaborator's inbox.
---

## Save the note
from: notes-web
to: notes-api
layer: network
anchor: src/lib/api.ts

The web app sends the note to the API over HTTPS. Nothing is stored in the browser.

## Write it down and announce it
from: notes-api
to: q:note-events
layer: queue
anchor: internal/events/publish.go

The API writes notes-db and publishes one note-events message through the outbox.

## Pick the event up
from: q:note-events
to: notes-worker
layer: queue
anchor: internal/consume.go

The worker consumes the event and decides who needs to hear about it.

## Send the mail
from: notes-worker
to: smtp
layer: network
anchor: internal/mail/

The worker sends the share notification through the SMTP relay.
