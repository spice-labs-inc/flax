# MAINTENANCE: how the atlas is kept current

An atlas decays from the day it is written. Each doc's frontmatter `analyzed_commit` says which commit of its repository it describes. All rules in `_TEMPLATE.md`'s header comment are binding for every edit. The tools named here are `flax atlas <cmd>`, run from the workspace directory (the one holding `flax.yml`).

## Who maintains it

Fill this section in for your organization: which scheduled job or agent finds drift (`flax atlas drift` lists the docs whose `analyzed_commit` is behind their repository's head and marks drift that is only version pins as noise), who refreshes a doc (a person, a coding agent run by a job), who regenerates the generated content, how changes reach the default branch, and who publishes the map. The method does not care which; it cares that each of those has an owner.

## Doc layout and budgets

- One repo = one main doc `repos/<name>.md` with the 11 stable headings of `_TEMPLATE.md`. Read a main doc whole only when it is within budget; otherwise grep the section you need and open its section file.
- **Section files**: a section over 8 KB moves whole to `repos/<name>/<section>.md` (first line `# <name>: <section> (full detail)`); tldr and recent never move. The main doc keeps the heading, any short lead text, the pointer line `Outline below; full detail in repos/<name>/<section>.md (open it before relying on anything here).` and a generated outline (one line per top-level bullet of the file). Edit the section file, then run `flax atlas outlines --write --doc <name>`. A section file shares the main doc's `analyzed_commit`. The map reads docs with their section files resolved, so their full text reaches the wiring stage.
- **Budgets** (binding; `flax atlas check` section 4 fails on each; the numbers are `docs.budgets` in `flax.yml`, these are the defaults):

| unit                                                                                | budget                                                                                                                                       |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| main doc                                                                            | 32 KB                                                                                                                                        |
| section in a main doc                                                               | 8 KB, else it moves to a section file                                                                                                        |
| section file                                                                        | 40 KB                                                                                                                                        |
| top-level bullet (with its continuation and sub-bullets; table rows count as lines) | 2 KB: split it into more bullets, never drop true facts                                                                                      |
| any line in any atlas file                                                          | 1,500 characters                                                                                                                             |
| `## tldr`                                                                           | 800 characters, trimmed in place, never moved elsewhere                                                                                      |
| `## recent`                                                                         | the newest 5 lines (`flax atlas recent`)                                                                                                     |
| INDEX.md                                                                            | 24 KB                                                                                                                                        |
| GLOSSARY.md                                                                         | 25 KB; definitions only, one term per entry, 400 characters per entry                                                                        |
| GAPS.md                                                                             | 500 characters per entry, each starting with its repo tag (`- [notes-api] ...`; `[atlas]` or `[org]` when no repo fits), no Resolved section |

- **No history files**: git and the PR list are the record. Rationale that still holds goes into `## invariants` or the section it explains.
- **No fast-moving facts in INDEX, GLOSSARY or ARCHITECTURE**: versions, dates, PR numbers, schedules, live/shadow status (the check fails on them). The repo doc holds the fact; the shared page points to it.
- Frontmatter `depends_on` and `used_by` carry repo names only (the check warns on notes); the note belongs in `## role` or `## interfaces`.
- `depends_on` = the internal repos this repo consumes at build, test, release or runtime, including the gitops repo its release writes pins to and the reusable action repos its workflows call; not an org-wide community-files sync and not repos that only produce its test data.
- The H1 reads `# <name>: <role>`: a colon, the role 72 characters or less, no em-dash (budgets fail otherwise); the INDEX row shows the role, so detail beyond it goes in `## role`.

## Generated content

`flax atlas <tool>` with `--check` (the default) changes nothing and exits 1 when a file would change; `--write` writes; `--doc a,b` limits a write to those docs where the tool takes it. Never edit generated content by hand.

- `used-by [--doc]`: every `used_by` is the inverse of all `depends_on`. To record a consumer, add this repo to the consumer's `depends_on`, then run it.
- `outlines [--doc]`: the outlines of sections that live in section files (generated-block marker lines never become outline bullets).
- `index`: the INDEX plane tables (`doc | status | role`, from frontmatter `plane:` and `status:` and the H1 line) between `<!-- BEGIN GENERATED index-plane:<plane> -->` markers under each index plane's heading (`planes[]` in `flax.yml` with `index: true`); the routing table and the prose stay hand-written. `index --seed-planes --write [--doc]` fills a missing `plane:` from where INDEX links the doc today.
- `recent [--doc]` (network): checks each `## recent` line against the merged PRs on the default branch (one paginated `gh api` list per repo): PR number, merge sha, and merge date in the workspace's timezone. It rewrites lines as `- <YYYY-MM-DD>: PR #N (merge <sha7>) <text>`, keeps the newest 5, and adds a line (the PR title) for each merged non-bot PR newer than the newest line.
- `inventories` (network): tables read from another repository's head, each between `<!-- BEGIN GENERATED <id> -->` markers in that repository's doc or section file (place the marker pair once by hand). Each inventory in `flax.yml` names a renderer module of your own (see the package README); the tool clones sparsely into a temp dir, or reads `--src <repo>=<dir>`.
- `budgets`, `symmetry`, `generated` (used-by, outlines and index checks together, offline): check sections 4, 3 and 4b.
- A workflow that runs `used-by --write`, `index --write` and `outlines --write` on every push keeps the generated content current when an agent edits frontmatter or a section file; `recent` and `inventories` need network and tokens, so they stay deliberate.

## When to refresh

- **Targeted**: you just merged, reviewed or learned about a significant change in repo X: update `repos/X.md` in the same session.
- **Staleness-driven**: a doc's `analyzed_commit` is behind the repo's HEAD and you are about to rely on volatile sections (`## recent`, `## cicd`, `## interfaces`): refresh that doc first.
- **Cross-repo moves**: a change in one repo can make another repo's doc wrong while its `analyzed_commit` stays current (a gitops repo parking a stack under another directory, for example). With `checks.gitopsPaths` enabled in `flax.yml`, check section 5 warns on cited gitops paths that no longer exist; for other moves, grep the atlas for the old path.

## After ANY batch of edits

Run `flax atlas check` and fix what it reports (fail must be 0). Sections: 1 template conformance (frontmatter keys, the 11 headings, `type`, `status` and `plane` values), 1b shareability, 2 INDEX coverage, 3 depends_on/used_by symmetry, 4 budgets, 4b generated content is current, 5 cited gitops paths resolve (warnings; only when enabled; reads the gitops checkout beside the atlas, else `gh api`), and with `--stale` a remote-HEAD staleness audit over the network. WARN lines are advisory. Run the same command in CI on pull requests and pushes. When you hit a question the repos cannot answer or find docs contradicting reality, record it in `GAPS.md` (and delete the entry when answered); never silently guess.

## The map

`flax atlas generate --reuse-wiring` rebuilds `data/graph.json` and `data/report.json` under the viz directory from the docs, the curated tables in `flax.yml`, the gitops checkout and the flows in `flows/*.md`, reusing the committed wiring cache and calling no model. `flax atlas build` bundles the viewer with that graph into `dist/`. Read `report.json` after a significant atlas change: `droppedEdges` (a claim whose endpoint did not resolve, often a renamed component) and `rejectedInfra` (detail-level noise the filter caught) jumping usually means a doc changed shape, not content.

- Wiring: the cache key hashes the wiring model, the extraction prompt and each doc's own wiring sections, section files included. With `--reuse-wiring` a doc whose sections changed keeps its previous extraction and the run lists those docs; `--reextract-changed` asks the model for new docs and changed docs only, at most `--max-extractions N` per run. A prompt change alone re-extracts nothing under either flag. The model is named by the variable `llm.modelEnv` points at; there is no default.
- Flow guard: a re-extracted doc whose new answer makes a curated flow step stop resolving keeps its previous answer and stays queued; the run names the doc, the step and the name the new answer used, so a person can add a `map.resolve.aliases` entry or update the flow. A step that does not resolve even with every previous answer fails the run.
- Curated knowledge lives in `flax.yml`, not in code: components a repo ships (`map.components`), environments and delivery nodes, hand-known edges (`map.curatedEdges`), aliases and canonical descriptions (`map.resolve`), plane fixes and the single-tenant lists (`map.planeFix`, `map.tenancy`). When a service joins or leaves a per-customer deployment, or a hostname of yours starts appearing in wiring, update those tables in the same session; otherwise the map states, confidently and in color, something that stopped being true.

## Audit: find stale docs

`flax atlas check --stale` compares every doc's `analyzed_commit` with `git ls-remote <repo> HEAD` and prints `STALE <name> <old> -> <new>`; `flax atlas drift` does the same through `gh api` and marks noise. Repos that cannot be resolved may be renamed or deleted: check the org's repository list, then update INDEX status.

## Refresh one repo doc

1. Fresh clone of the latest default branch. Never analyze existing developer working copies (they may be stale or on feature branches): `GIT_LFS_SKIP_SMUDGE=1 git clone --depth 50 --quiet <clone url> <session temp dir>/<name>`.
2. Scope the drift: `git -C <session temp dir>/<name> log --oneline <old-analyzed-commit>..HEAD` (if the old commit is not in the shallow history, deepen with `git fetch --deepen=200` or treat it as a full rewrite of volatile sections).
3. Update ONLY the sections the drift touches (in the section file if the section lives in `repos/<name>/`, then `flax atlas outlines --write --doc <name>`); run `flax atlas recent --write --doc <name>` for `## recent`; bump frontmatter `analyzed_commit: <short-sha> <date>` and `analysis_source: fresh-clone`.
4. Keep every heading from `_TEMPLATE.md` present and unrenamed. Keep facts path-anchored (cite file:line or a commit); keep the `UNVERIFIED` prefix discipline.
5. Ripple: if the H1 role, `status` or `plane` changed, `flax atlas index --write`; if `depends_on` changed, `flax atlas used-by --write`; if flows or deploy paths changed, `ARCHITECTURE.md`; new vocabulary, `GLOSSARY.md` (a definition and a pointer, nothing that changes with releases).

## Full sweep

Run the audit, then fan out sessions (one per stale repo, or batched by subsystem) with the "Refresh one repo doc" instructions plus `_TEMPLATE.md`. Afterwards run `flax atlas index --write` and `flax atlas used-by --write` once over the whole tree, and review the routing table and ARCHITECTURE by hand (they need judgment, not regeneration).

## New, renamed and archived repos

- **Discover**: diff your org's repository list (`gh repo list <org> --limit 300 --json name,isArchived`) against INDEX rows. Repos without a doc yet are listed in GAPS.md.
- **New repo**: create `repos/<name>.md` from `_TEMPLATE.md` via a fresh clone, with its `plane:`; list what it consumes in its `depends_on` and add it to each consumer's `depends_on`; run `flax atlas index --write` (rows it) and `flax atlas used-by --write`; add routing-table entries if it introduces a new task surface.
- **Archived**: set `status: archived` in frontmatter and run `flax atlas index --write` (its row stays in its plane, sorted last); keep the doc. Do not deep-refresh archived docs.
- **Renamed**: rename the doc file (and its `repos/<name>/` folder), fix `name:` and `repo:`, grep the whole atlas for the old name and fix references.

## Invariants of the atlas itself

- One repo = one file in `repos/`, filename = repo name exactly; section files live only in `repos/<name>/`.
- INDEX.md is the only file guaranteed to be read first: any repo not rowed there is invisible; every doc needs a `plane:` so the generated tables row it.
- Never delete a section heading; write "none" under it instead.
- Clones go in disposable session scratch space (temp dirs), never into developer working directories.
- SHAREABLE DOC RULE (see _TEMPLATE.md): docs never reference an individual machine (home-directory paths, local checkouts, worktrees, personal tool paths) and never contain credential or secret VALUES. Check section 1b enforces this with the patterns in `docs.localRefs`.
- Docs are for LLMs: density over polish. Do not "improve readability" by adding prose padding; do not strip identifiers or path anchors. US English, no em-dashes in new text.
