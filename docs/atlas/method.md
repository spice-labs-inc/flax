# The atlas method

An atlas is one page per repository, written for coding agents first and people second, that answers "what is X, where does Y live, what do I touch to change Z" without reading the codebases. It is content under version control with a fixed template, size budgets, generated cross-references, deterministic checks, and a scheduled agent that proposes the small cited edits that keep it true. This page explains why an atlas, what a page looks like, the budgets, what is generated, the maintenance rules and the trust model. The template itself, with notes-co examples, is in [template.md](template.md).

## Why an atlas for coding agents

A coding agent that starts a task in a large organization has two bad options: read the codebases (slow, expensive, and it still misses the parts that live in another repository) or guess (fast and wrong). An atlas gives it a third: read one index, resolve which one or two repositories matter, read their pages, and go to the right file. The page is dense and literal, every fact anchored to a repository path, so the agent can verify before it acts. People read the same pages when they need to; a human-facing document (an onboarding page, a runbook) is rendered from them on demand, not maintained beside them.

An atlas decays. Repositories move past the commit a page describes, and nobody updates a document that is nobody's job. The method's answer is to make staleness measurable (every page names the commit it describes), make the volatile parts generated (the recent changes, who depends on whom, the index rows), hold every page to a template and budgets a tool can check, and give the refresh to a scheduled agent whose every edit is a cited pull request.

## The pages

The workspace's atlas is a directory:

```
INDEX.md            the master table, one row per repository, generated per plane, plus a routing table
repos/<name>.md     one page per repository, in the template
repos/<name>/<section>.md   a section that outgrew its budget, moved whole
ARCHITECTURE.md     cross-repository flows, environments, deploy paths
GLOSSARY.md         the organization's vocabulary, definitions only
GAPS.md             known unknowns and verified inconsistencies
MAINTENANCE.md      the rules for keeping it current
_TEMPLATE.md        the page schema and its binding style rules
viz/                the map: flows, the wiring cache, the generated graph
```

A page has YAML frontmatter (name, repository, language, type, status, plane, deploy, `depends_on`, `used_by`, artifacts, default branch, `analyzed_commit`, `analysis_source`), an H1 of the form `# <name>: <role>` with the role at most 72 characters, and eleven sections with stable lowercase headings: `tldr`, `role`, `architecture`, `data`, `interfaces`, `configuration`, `build-test-run`, `cicd`, `keyfiles`, `invariants`, `recent`. Headings are ids: a tool or an agent extracts a section by grepping for it. A section is never deleted; a page writes "none" under it instead.

The style rules are binding: fact density over readability, every claim anchored to a path or a named workflow, exact identifiers verbatim (environment variables, routes, flags, queue and table names), bullets and tables over prose, one fact per bullet, small schemas inline. Facts without an anchor carry the prefix `UNVERIFIED`. A page never references an individual machine (home paths, local checkouts, worktrees) and never holds a secret value; secret names and where they are stored are fine. Depth scales with the repository: a core service lists every route and table, a tiny library is complete but short.

## Budgets

Budgets keep a page readable whole by an agent with a bounded context and stop one page from swallowing the atlas. `flax atlas check` fails on each:

| unit | budget |
|---|---|
| main page | 32 KB |
| section in a main page | 8 KB; past that it moves whole to `repos/<name>/<section>.md` |
| section file | 40 KB |
| top-level bullet, with its sub-bullets | 2 KB: split it, never drop true facts |
| any line in any file | 1,500 characters |
| `tldr` | 800 characters, trimmed in place |
| `recent` | the newest 5 lines |
| `INDEX.md` | 24 KB |
| `GLOSSARY.md` | 25 KB; one term per entry, 400 characters each |
| `GAPS.md` | 500 characters per entry, each starting with its repository tag |

When a section moves to a section file, the main page keeps the heading, a pointer line and a generated outline (one line per top-level bullet of the file), so a reader of the main page still sees what is there. Section files share the main page's `analyzed_commit`. The budgets are configuration in the workspace's `atlas` section; the numbers above are the defaults.

No history files: git and the pull request list are the record, and rationale that still holds goes into `invariants`. No fast-moving facts in the shared pages: versions, dates, pull request numbers, schedules and live status belong in the repository page; the index, the glossary and the architecture page point to it.

## Generated content

Generated content is never hand-edited. `flax atlas <tool>` runs each generator; `--check` (the default) changes nothing and exits 1 when a file would change, `--write` writes:

- `used-by`: every page's `used_by` is the inverse of all `depends_on`. To record a consumer, add this repository to the consumer's `depends_on` and run it.
- `outlines`: the outlines of sections that live in section files.
- `index`: the index's plane tables (page, status, role) between marker comments, from each page's `plane`, `status` and H1. The routing table and the prose stay hand-written.
- `recent` (network): checks each `recent` line against the merged pull requests on the default branch (number, merge commit, merge date in the workspace's time zone), rewrites them in one form, keeps the newest five and adds a line for each newer merged pull request.
- `inventories` (network): tables read from another repository's head, between markers placed once by hand.
- `budgets`, `symmetry`, `generated`: the checks alone.

A workflow in the atlas repository runs `used-by`, `index` and `outlines --write` on the refresh agent's branches and on every push to the default branch, so a pull request never has to carry generated changes by hand.

## The maintenance rules

- **Targeted refresh**: a session that merged, reviewed or learned about a significant change in repository X updates `repos/X.md` in the same session. This is the standing duty, and it is the reason the atlas is consulted before exploring code: whoever reads it is the one who notices it is stale.
- **Staleness-driven refresh**: a page's `analyzed_commit` is behind the repository's head and you are about to rely on a volatile section (`recent`, `cicd`, `interfaces`): refresh that page first.
- **Refresh one page**: a fresh shallow clone of the default branch (never a developer's working copy), the commit log from the old `analyzed_commit` to head, update only the sections the drift touches, run `recent`, bump `analyzed_commit` and `analysis_source`, keep every heading, keep facts anchored, then ripple: `index` when the role, status or plane changed, `used-by` when `depends_on` changed, the architecture page when flows changed, the glossary for new vocabulary.
- **After any batch of edits**: run `flax atlas check` and fix what it reports. Sections: template conformance, shareability, index coverage, dependency symmetry, budgets, generated content current, and with `--stale` a remote-head audit. When the repositories cannot answer a question, record it in `GAPS.md`; never silently guess.
- **New, renamed and archived repositories**: a new page from the template via a fresh clone, with its plane and its `depends_on`; an archived repository keeps its page with `status: archived`; a renamed one renames the file and every reference.
- **Pushing**: hand edits go to the default branch after a rebase; the scheduled agent's edits go through pull requests, and only the map refresh job merges its own, and only for the map's data and cache.

The scheduled part is two reference jobs of the agents package: `atlas-doc-refresh` proposes cited edits for up to three drifted pages a run, and `atlas-map-refresh` regenerates the map daily (see [../agents/reference-jobs.md](../agents/reference-jobs.md)).

## The trust model

Every fact was derived from the repository source at `analyzed_commit`, from a fresh clone of the remote default branch unless `analysis_source` says otherwise. A fact the author could not anchor is prefixed `UNVERIFIED` and stays marked in the map. `recent` and `cicd` go stale fastest; `architecture` and `data` drift slowly. Before a load-bearing change, verify the specific claim against the code at head: the atlas routes you to the right file, it does not replace reading it. The staleness check for one page is a comparison of `analyzed_commit` with the remote head.

For the map, the same stance: the model is never trusted on its own. See [wiring.md](wiring.md).

## To confirm against the package

- The config keys for budgets and sections as the package publishes them (the planes and the gitops path check, `checks.gitopsPaths`, off by default, are in the demo already).
