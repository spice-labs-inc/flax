# GLOSSARY: notes-co vocabulary

- **note-events**: the RabbitMQ queue notes-api publishes one message to per note change; notes-worker consumes it.
- **pin**: the image version an overlay in notes-gitops names for an application; Flux applies it.
