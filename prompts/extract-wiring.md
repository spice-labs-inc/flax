You are extracting a machine-readable wiring graph from one document of an
internal architecture atlas. The atlas is written for LLMs: dense, anchored, and
literal. Your job is extraction, not inference.

# The component under analysis

Repo: {{REPO}}
Components this repo ships: {{OWN_COMPONENTS}}

# Document sections

{{SECTIONS}}

# Known component ids

Use these exact ids when an endpoint is one of them. Never invent a variant
spelling of an id that appears here.

{{COMPONENT_IDS}}

# What to extract

Emit one edge per distinct runtime relationship the document states, on exactly
one of three layers:

- `network`: a request one component makes to another over HTTP/gRPC/S3/SMTP,
  including calls to third parties. Direction is caller to callee.
- `queue`: a message relationship. Model these as TWO edges through the queue
  itself: producer to queue, and queue to consumer. Never connect a producer
  straight to a consumer.
- `data`: a component reading or writing a durable store: a database, a bucket
  or bucket prefix, an on-disk dataset, a secrets engine. Direction is component
  to store.

Every endpoint is either a known component id or an infrastructure node you
declare in `infra`. Declare infrastructure with the exact identifier the
document uses: queue and exchange names verbatim (`note-events`,
`digest-{user}-daily`, `activity-log`), database names, bucket prefixes, and
external hostnames (`api.github.com`, Auth0, Stripe).

## What counts as infrastructure

This is the rule that decides whether the graph is readable or unusable. An
infrastructure node is a shared, named, durable system that more than one thing
could address. Everything else is a detail that belongs in an edge's `label`,
`detail` or `anchor`: never its own node.

Declare a node for:

- a database or schema (`notes-db`, `billing`, the per-tenant SQLite file)
- an object-storage bucket or blob store, as ONE node. A prefix, key pattern or
  directory inside it is not a separate node: name it in the edge label instead
  (`writes pqc_reports/`), and point the edge at the bucket
- a queue, exchange, or the broker itself
- a secrets or key-management engine (Vault, a cloud secret manager)
- a published dataset another system consumes (the search index, the exported notes archive)
- a distinct third-party service reached over the network (Auth0, Stripe, an
  SMTP relay, the GitHub API, a package registry)

Do not declare a node for:

- a CLI flag or argument (`--notes-dir`, `--index-dir`)
- a filesystem path, mount point, temp dir or working dir (`/work/notes`, `./data/`, `~/.notes`)
- a single file (`notes.txt`, `config.json`, a `.jsonl` log)
- an environment variable, chart value or config key (`mail.from_address`)
- a Kubernetes Secret, ConfigMap, ExternalSecret or CRD name
- a local cache directory
- a directory, prefix, folder or key pattern of any kind, including index and
  output directories: these are locations inside a store, not stores
- an individual feed inside an aggregator: one node for the service, not one
  per feed (`ghsa`, `nvd`, `rustsec` are sources ingested BY an advisory
  service, not separate infrastructure)
- a Slack channel, alert route or notification target

When the same real thing has several spellings across the atlas, use the
plainest canonical one: `postgres` not `postgres:16`, `Vault` not
`vault-active.vault.svc.cluster.local:8200`, `registry.npmjs.org` not
`npm-registry`.

# Rules

- Only emit an edge the document actually states. Do not complete the picture
  from what you know about systems like this one.
- Every edge needs an `anchor`: the repo-relative path, env var, chart value,
  queue name, route, or workflow file the document cites for that claim. If the
  document states the relationship but cites nothing, use the section name.
- If the document marks something UNVERIFIED, or hedges it, set
  `"unverified": true` and keep the hedge out of `detail`.
- `label` is short and concrete: the env var, port, route, queue name, or
  protocol. Prefer `HTTP :3000` or `MARKER_SERVER` over `calls`.
- `detail` is one sentence a reader can act on. No marketing, no filler.
- Do not emit build or library dependencies. Those come from frontmatter and are
  not your job. A crate compiled in-process is not a network edge.
- Do not emit an edge from a component to itself.
- Prefer the most specific component id. If the document says the API proxies to
  a tenant's worker, the target is `notes-worker`, not the repo it lives in.

# Output

Return only a JSON document, no prose and no code fence:

{
  "edges": [
    {
      "from": "<component or infra id>",
      "to": "<component or infra id>",
      "layer": "network" | "queue" | "data",
      "label": "<short>",
      "detail": "<one sentence>",
      "anchor": "<path, env var, route, or section>",
      "unverified": false
    }
  ],
  "infra": [
    {
      "id": "<exact identifier from the document>",
      "kind": "queue" | "broker" | "store" | "external" | "registry",
      "label": "<display name>",
      "role": "<one sentence: what it holds or carries>"
    }
  ]
}

If the document describes no runtime wiring at all, return
`{"edges": [], "infra": []}`.
