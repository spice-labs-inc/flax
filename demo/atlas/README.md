# notes-co atlas: an LLM-consumable map of every notes-co repo

Audience: coding agents and LLMs first. Purpose: answer "what is X / where does Y live / what do I touch to change Z" without reading the codebases. The method, the budgets and the tools are `@flax/atlas`; this directory is the content.

## File layout

- `INDEX.md`: one row per repo under its plane heading, plus a task routing table. ALWAYS start here.
- `repos/<name>.md`: one doc per repo, all following `_TEMPLATE.md`; a section that outgrew its budget lives in `repos/<name>/<section>.md` with an outline left behind.
- `ARCHITECTURE.md`: cross-repo flows and environments. `GLOSSARY.md`: notes-co vocabulary. `MACHINES.md`: the fleet.
- `MAINTENANCE.md`: how this atlas is kept current. `_TEMPLATE.md`: the per-repo schema; never invent new section headings.
- `viz/`: the map's data (`data/graph.json`), the wiring cache (`cache/`) and the guided flows (`flows/`). `flax atlas generate --reuse-wiring` and `flax atlas build` run from the workspace directory above this one.

## Consumption protocol

1. Read `INDEX.md`. Resolve which repo(s) matter for the task.
2. Read only the relevant `repos/<name>.md` files. Do not bulk-read the whole atlas.
3. Within a doc, headings are stable ids: `grep -A40 '^## interfaces' repos/notes-api.md`.
4. Cross-cutting questions: `ARCHITECTURE.md`. Unknown terms: `GLOSSARY.md`.
5. Frontmatter is machine-readable: `depends_on` and `used_by` give the dependency graph; `analyzed_commit` and `analysis_source` give provenance.

## Trust model

- Every fact was derived from the repo source at `analyzed_commit`. Facts the author could not anchor to a file are prefixed `UNVERIFIED`.
- `## recent` and `## cicd` go stale fastest; `## architecture` and `## data` drift slowly. Verify a load-bearing claim against the code at HEAD before acting on it: the atlas routes you to the right file; it does not replace reading it.
