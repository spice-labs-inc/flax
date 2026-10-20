# The viewer

The viewer is an interactive, filterable 3D map of an organization's whole architecture, generated from the atlas. Flat diagrams make you trace lines; this lets you fly through the system and ask it questions. It is one self-contained HTML file with no server and no network calls, built from a committed graph by code alone, so a reader needs nothing and a deploy can never silently regenerate it. This page describes what the map shows, how to read it, how it is built and published, and how to run it.

## What it shows

**Components, not repositories.** Several repositories ship more than one deployable thing; those are separate nodes, grouped by the repository they come from. notes-co's `notes-api` repository is one component; a workspace repository that builds a service, a worker and a CLI is three.

**Connection layers, independently toggleable.** A single "depends on" arrow hides how the system behaves, so the connection type is a first-class dimension:

| layer | meaning | source |
|---|---|---|
| network | runtime calls over HTTP, object storage or mail, third parties included | the `role` and `interfaces` sections, by extraction |
| queue | producer to queue to consumer, broker visible | the `data` and `interfaces` sections, by extraction |
| data | who owns and reads which database, bucket or engine | the `data` section, by extraction |
| build | libraries consumed at build time | `depends_on` frontmatter |
| delivery | source to registry to gitops pin to environment, or straight to where it ships (a site, releases, action tags, a package registry) | `deploy` and `type` frontmatter, the `cicd` section, the gitops checkout |
| shared dependencies | components containing the same items | a committed containment snapshot, derived, not declared |

The first five read relationships out of pages. The sixth measures them from what each component contains, so its edges are marked derived: a shared transitive library is not an architectural relationship. It is off by default, undirected, and excluded from the layout, so turning it on moves nothing.

**Planes.** Components sit in plane shells the workspace defines (notes-co: the app, delivery, docs, plus the two every map has: infrastructure and third parties). Third-party services are their own plane; they are not your infrastructure. Filters cover plane, open-source versus internal (visibility comes from the code host, not guesswork) and lifecycle status.

**Guided flows.** Hand-written journeys from `viz/flows/`, animated one hop at a time with everything outside the journey hidden; they autoplay until you take over. notes-co's `publish-a-note` flow walks from the web app to the API to the queue to the worker to the docs site.

**A shape language**, so kind reads without reading a label: a hexagon is a service you own, a small dot a library, a square a datastore, a hollow square a machine, a diamond a queue or broker, a hollow ring something outside your boundary. Node size tracks how connected a thing is in the current view, and pulses travel each edge from source to target so direction is visible.

**The inspector.** Selecting anything opens the atlas prose behind it, and every connection carries the anchor it was extracted from and its unverified flag, so a claim can be checked against the source page.

**Every navigable state is in the URL**, as hierarchical segments after a hash: `#/view/storage`, `#/view/storage/node/notes-api`, `#/flow/publish-a-note/3`, `#/custom/network,data/app,infra`. Hash segments, because the map ships as one static file: a real path would 404 on reload wherever it is hosted. Any view can be pasted into a message.

## How to read it

Start from a view the workspace configured (the runtime view with network and data layers on is a good default), open a plane, and follow pulses: a request points at the service, a response points back at the caller, a message goes producer to queue to consumer. Turn on the build layer to see what a library change touches; turn on delivery to see how a commit reaches an environment. Open a flow when you want the story rather than the graph. When a connection looks wrong, open the inspector and read the anchor: the fix is on the page, or in the aliases table, never in the graph file.

## How it is built and published

The force-directed layout runs once in the generator and the coordinates are baked into `viz/data/graph.json`, so the page never simulates anything: it loads, draws, and is interactive. Nodes render in one draw call and edges in another; toggling a layer rewrites an alpha buffer in place. The page gets its configuration (planes, colors, views, the organization's code host) embedded at build time as a JSON script tag beside the graph.

Two commands with a strict division of labor:

- `flax atlas generate`: the pipeline, from the pages to `viz/data/graph.json` and `report.json`. Needs a model only for pages whose wiring changed; see [wiring.md](wiring.md).
- `flax atlas build`: bundles the committed graph and configuration into `viz/dist/`. It must never regenerate. A deploy workflow runs it on a push that touches `viz/`, and it writes the site's custom domain file on every build so a redeploy cannot drop it.

The reference deployment is a static site from the atlas repository's own pages feature, private to people with read access to the repository when the host offers that. A regeneration is a deliberate step: the `atlas-map-refresh` job daily, or a person locally.

## The shared-dependency layer

A portfolio subject (a tag in an inventory tool's survey of your own software) does not name a component by itself, so that join is a human decision recorded in `viz/subjects.md`. Only exceptions go in the file: a subject named exactly like a component id or label matches automatically, and anything left over is reported loudly rather than dropped in silence. Containment is fetched as a committed snapshot, never live, so the generator runs from committed inputs with no credential and no network; it is stale by design, since containment changes when code changes. Only items held by two or more subjects are kept. Two constants set the layer's density: a rarity gate (a pair gets no edge unless it shares an item that at most that many components hold, which stops "everyone depends on the logging library" from connecting the whole map) and a ubiquity cutoff (items held by more than half the components are dropped). Weighting is inverse document frequency, so a package shared by exactly two components counts far more than one shared by twenty. The fetcher for the snapshot is the organization's own; the stage that reads it ships with the package.

## Running it

```sh
flax atlas generate --reuse-wiring   # from the committed cache, no model
flax atlas build                     # viz/dist/ from the committed graph
flax atlas serve                     # a local server on the built page
```

`flax atlas build --graph <path>` bundles another graph file without touching the committed one, which is how a preview is reviewed; `flax atlas generate --only a,b` generates the wiring of named pages for debugging, and `--max-extractions N` caps a run. Every command takes `--workspace <dir>` and works on the directory `atlas.root` names.

## To confirm against the package

- Whether the containment snapshot's fetcher ships (as a configurable client) or stays private with only the reader stage public.
