# @flax/atlas

An architecture atlas of your organization's repositories, written for coding agents and LLMs first and for people second, with the tooling that keeps it honest: a page template, maintenance rules, size budgets, generated tables, a wiring pipeline that turns the prose into a graph, and a 3D viewer of that graph.

The atlas itself is content and lives in your workspace: one page per repository under `repos/`, a few shared pages (`INDEX.md`, `ARCHITECTURE.md`, `GLOSSARY.md`, `GAPS.md`, `MACHINES.md`), the curated tables in `flax.yml`, and the map's data under a `viz/` directory. This package contains no content about any organization; `demo/atlas` in the flax repository is a fictional one, notes-co, that every command below runs against.

## The method in one paragraph

Every repository gets one Markdown page with the same eleven stable sections (`## tldr`, `## role`, `## architecture`, `## data`, `## interfaces`, `## configuration`, `## build-test-run`, `## cicd`, `## keyfiles`, `## invariants`, `## recent`) and a YAML frontmatter that names what it depends on and which commit it describes. Facts are anchored to files or commits or marked UNVERIFIED. Pages have size budgets so an agent can read one whole; a section that outgrows its budget moves to a section file and leaves an outline behind. Everything derivable is generated, never hand-edited: `used_by` from every `depends_on`, the outlines, the `## recent` lines, the INDEX rows. A check runs on every change. The same prose is the input of a pipeline: the frontmatter gives the build layer, a model extracts the runtime wiring (network, queue, data) from the prose once and caches it by content, the gitops checkout gives what runs where, hand-written flow files give guided journeys, and a viewer draws it all as one self-contained HTML page. `templates/_TEMPLATE.md` and `templates/MAINTENANCE.md` hold the full rules; copy both into your atlas.

## Commands

All of them run from the workspace directory (the one holding `flax.yml`) or with `--workspace <dir>`, through the `flax` command.

| command                                                             | what it does                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flax atlas check [--stale]`                                        | every self-consistency check: template conformance (frontmatter keys, the 11 headings, `type`, `status` and `plane` values), shareability (no machine-local paths, no secret-looking values), INDEX coverage, `depends_on`/`used_by` symmetry, budgets, generated content current, cited gitops paths (when enabled); `--stale` adds a remote-HEAD audit over the network. Exit 1 on any failure. |
| `flax atlas used-by [--check\|--write] [--doc a,b]`                 | `used_by` as the inverse of every `depends_on`                                                                                                                                                                                                                                                                                                                                                    |
| `flax atlas outlines [--check\|--write] [--doc a,b]`                | outlines of sections that live in section files                                                                                                                                                                                                                                                                                                                                                   |
| `flax atlas index [--check\|--write] [--seed-planes]`               | the INDEX plane tables between generated markers                                                                                                                                                                                                                                                                                                                                                  |
| `flax atlas budgets`, `flax atlas symmetry`, `flax atlas generated` | the individual offline checks                                                                                                                                                                                                                                                                                                                                                                     |
| `flax atlas recent [--write] [--doc a,b]`                           | `## recent` against the merged PRs on the default branch (`gh api`)                                                                                                                                                                                                                                                                                                                               |
| `flax atlas inventories [--write] [--src repo=dir]`                 | generated blocks rendered from another repository's head by your own renderer modules                                                                                                                                                                                                                                                                                                             |
| `flax atlas drift [--verbose]`                                      | docs whose `analyzed_commit` is behind their repository's head (`gh api`); drift that is only version pins is marked `noise`                                                                                                                                                                                                                                                                      |
| `flax atlas generate --reuse-wiring`                                | rebuild `data/graph.json` and `data/report.json` from the docs, the tables, the gitops checkout, the flows and the committed wiring cache; no model call                                                                                                                                                                                                                                          |
| `flax atlas generate --reextract-changed [--max-extractions N]`     | the same, asking the model for new docs and docs whose wiring sections changed                                                                                                                                                                                                                                                                                                                    |
| `flax atlas build [--graph path]`                                   | bundle the viewer with the graph into `dist/index.html` (and `atlas-3d.html`, one self-contained file)                                                                                                                                                                                                                                                                                            |
| `flax atlas serve [--port N]`                                       | a local preview of the built page                                                                                                                                                                                                                                                                                                                                                                 |
| `flax atlas wiring-eval --socket path \| --base-url url --model id` | ask another model to extract a sample of docs and compare with the cached answers; never writes the cache                                                                                                                                                                                                                                                                                         |

`--check` is the default for every generator: it changes nothing and exits 1 when a file would change, which is what CI runs. Node 22.6 or newer.

## The workspace file

The shared keys of `flax.yml` (`org`, `github`, `environments`) feed the atlas: `github` is the GitHub owner every repository URL, visibility lookup and clone derives from; `environments` become the map's environment nodes, in the order listed; the first one is the reference environment, the one rule every flax package follows. Everything else sits under `atlas:`. A minimal section:

```yaml
org: notes-co
github: notes-co
environments:
  - { id: live, label: Live }
  - { id: test, label: Test }
atlas:
  root: atlas # the directory holding INDEX.md and repos/, relative to flax.yml
  planes:
    - {
        id: app,
        label: Notes app,
        index: true,
        heading: "## App plane",
        map: true,
      }
    - {
        id: delivery,
        label: Delivery,
        index: true,
        heading: "## Delivery plane",
        map: true,
      }
    - { id: infra, label: Environments, map: true }
    - { id: external, label: Third party, map: true }
```

Defaults carry the method: the sections, the budgets, the `type` and `status` vocabularies, the shareability patterns. Your organization's tables have no defaults beyond what the pipeline needs to run. The keys, each with the code that reads it:

| key                                                                                                             | meaning                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`, `viz`                                                                                                   | the atlas directory (relative to the workspace) and the viz directory (relative to the atlas root; `viz`), which holds `data/`, `cache/`, `flows/`, `prompts/` and `dist/`                                                                                      |
| `org.registry`, `org.packageGroups`, `org.ownHosts`                                                             | the container registry prefix artifacts lines name, the package group ids manifests name your org by, and the hostname suffixes that are yours (a wiring answer naming one is not a third party)                                                                |
| `site.title`, `site.searchPlaceholder`, `site.cname`, `site.timezone`                                           | the page title (`<org> atlas` when unset), the search box hint, the custom domain written to `dist/CNAME` when set, and the timezone of merge dates                                                                                                             |
| `docs.sections`, `docs.mainOnly`, `docs.wiringSections`, `docs.frontmatter`                                     | the stable sections, those that never move to a section file, those the wiring stage reads, and the required frontmatter keys                                                                                                                                   |
| `docs.rootPages`, `docs.noVolatile`, `docs.budgets`, `docs.recentNoise`, `docs.symmetryExempt`, `docs.gapsTags` | the shared pages checked for shareability, the pages that may not carry fast-moving facts, the twelve budget numbers, PR titles that never make a `## recent` line, docs exempt from symmetry, extra GAPS tags                                                  |
| `docs.localRefs`, `docs.localRefsAllow`                                                                         | shareability patterns and the lines allowed through                                                                                                                                                                                                             |
| `docs.driftNoise`                                                                                               | per repository: path patterns that are noise for `drift`, and files whose only changed lines are `image:` pins                                                                                                                                                  |
| `enums.type`, `enums.status`, `enums.statusOrder`                                                               | the frontmatter vocabularies and the INDEX sort order                                                                                                                                                                                                           |
| `planes[]`                                                                                                      | one list: `id`, `label`, `index` + `heading` (rowed in INDEX), `map` (drawn), `slug`, `color`, `anchor`, `placed`, `pull` (3D layout)                                                                                                                           |
| `map.defaultPlanes`, `map.views[]`                                                                              | the planes the viewer opens with and its preset views (`id`, `label`, `hint`, `layers`, `planes`)                                                                                                                                                               |
| `map.planeRules`, `map.planeFix`, `map.externalPlane`, `map.infraPlane`, `map.deliveryPlane`                    | how a repo gets its plane: by repo list, by `type`, by infra language, else the fallback; per-node overrides; the three planes the pipeline needs by role                                                                                                       |
| `map.components`                                                                                                | the components a repo ships when it ships more than one (`id`, `label`, `role`, `kind`)                                                                                                                                                                         |
| `map.environments`                                                                                              | a mapping of workspace environment id to its role sentence                                                                                                                                                                                                      |
| `map.deliveryNodes`, `map.sites`, `map.outlets`, `map.curatedEdges`                                             | hand-known nodes (registry, reconciler, published sites by host regex, release outlets) and edges; a curated edge with `phase: after` is emitted after the per-doc delivery edges, which only matters for the order the 3D layout sees |
| `map.delivery`                                                                                                  | `registryMatch`, `registryNode`, `pinActions.immediate` and `.pr` (actions whose presence means a gitops pin), `applyTool` (`name` matched in deploy lines, `title` for prose, `label`, `detail`)                                                                                                                                      |
| `map.gitops`                                                                                                    | `repo`, `checkout` (relative to the atlas root), `overlays` (overlay directory to environment node), `curated` (stack directory to component), optional `machinesDir`, `machinesSkip`, `machineReconciler` for compose stacks per machine                       |
| `map.manifests.checkouts`                                                                                       | where sibling checkouts live for the manifests stage (`..`)                                                                                                                                                                                                     |
| `map.resolve`                                                                                                   | `aliases`, `canonical`, `generic`, `envTokens` (the workspace environment ids when unset), `storeMerge`, `storeNames`, `ownedDb`, `gateway`, `transit`, `proxyEdges`, `minGraph` (the emit floor; 100 nodes and 100 edges by default, lower it for a small org) |
| `map.tenancy`                                                                                                   | the single-tenant split: `plane`, `from`, `inNamespace`, `perProjectData`, `sharedDespite`, `customerSide`; the stage runs only when set                                                                                                                        |
| `map.wiringSkipTypes`                                                                                           | doc types that get no model call (`gh-action`, `docs`, `sample`)                                                                                                                                                                                                |
| `inventories[]`                                                                                                 | `id` (the generated block), `doc`, `repo`, `paths` (sparse checkout), `renderer` (a module path, see below)                                                                                                                                                     |
| `checks.gitopsPaths`                                                                                            | `enabled` (off by default), `prefixes` (regex sources such as `apps/(test\|live)`), `skipPhrases`, `skipSections`                                                                                                                                               |
| `llm`                                                                                                           | `modelEnv`, `fallbackEnv`, `socketEnv`, `socketModelEnv` (the environment variables that name the models and the socket), `concurrency`, `maxTokens`                                                                                                            |
| `sources.containment`, `sources.advisories`                                                                     | the committed snapshots the shared-dependency and advisory stages read, relative to the viz directory; both stages skip quietly when the file is absent                                                                                                         |

## Inventory renderers

An inventory is a table generated from another repository's files and written into a `<!-- BEGIN GENERATED <id> -->` block of an atlas page. What such a table says is your organization's business (your job definitions, your gitops layout), so the package ships no renderers: each entry under `inventories:` names a module, relative to the workspace, that exports `render(dir, helpers)` and returns the Markdown to put in the block. `helpers` carries `renderTable(header, rows)`, `parseYaml(text)`, `org.github`, and the inventory's `id` and `repo`. A JavaScript module always works; a TypeScript one works when the running Node strips types.

```ts
export function render(
  dir: string,
  { renderTable }: { renderTable: (h: string[], r: string[][]) => string },
): string {
  return renderTable(["job", "schedule"], [["nightly", "0 4 * * *"]]);
}
```

## The wiring prompt

`prompts/extract-wiring.md` in this package is the extraction prompt. A copy at `<viz>/prompts/extract-wiring.md` in your workspace overrides it. The prompt's hash is part of every cache key, so changing it means every doc misses the cache; under `--reuse-wiring` each keeps its pinned answer and the map does not change, and the next `--reextract-changed` run asks the model only for docs whose own text changed. A model backend is one of: a Unix socket speaking the Messages API (`llm.socketEnv`), the Anthropic SDK when `ANTHROPIC_API_KEY` is set (install `@anthropic-ai/sdk` yourself; it is optional), or the Claude Code CLI on `PATH`.

## Flows

Guided journeys are hand-written, one Markdown file per flow under `<viz>/flows/`, with frontmatter (`id`, `name`, `plane`, `summary`) and one `## Step` per hop (`from`, `to`, `layer`, `anchor`, then the prose). `from` and `to` must be node ids; a step that does not resolve is dropped and counted, never drawn, and a re-extraction that would break a step keeps the doc's previous answer (the flow guard).

## Development

```
pnpm --filter @flax/atlas build    # tsc to dist/
pnpm --filter @flax/atlas check    # type check (the viewer has its own tsconfig.app.json)
pnpm --filter @flax/atlas test     # node --test over dist
```

The package is `Apache-2.0`; the repository is `spice-labs-inc/flax`.
