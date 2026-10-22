# flax documentation

flax is a set of packages for keeping an engineering organization honest about itself: scheduled agents that run unattended on cheap models behind code guardrails, an architecture atlas of your repositories written for people and coding agents, a scenario library that proves what your product does across every surface and every environment, and an explorer that maps those proofs live. Your content (jobs, atlas pages, scenarios, personas, configuration) lives in your own workspace repository; flax reads it and never contains it. This page is the map of the documentation and the one-page story of how the pieces fit.

## The one-page story

Most organizations have three documents that are always a little wrong: the architecture overview, the test plan and the list of what the product actually does. They go stale because keeping them fresh is nobody's job and because the tools that could keep them fresh are not trusted to write unattended. flax takes the opposite position. It treats those documents as content under version control, gives each one a deterministic toolchain that checks it, and lets a scheduled agent propose the small, cited edits that keep it true, under guardrails written in code rather than in prompts.

The pieces:

- **A workspace** is a directory (usually its own private repository) with one `flax.yml` at its root and your content beside it: `jobs/` for the agents package, atlas pages for the atlas package, `features/`, `personas/` and `journeys/` for the scenarios package. `flax.yml` names your organization, your GitHub owner and your environments once; each package reads its own section. The framework is published and versioned; the workspace pins it. See [workspace.md](workspace.md).
- **`flax agents`** runs jobs: small folders holding a `job.yml`, a prompt, an output schema and fixtures. A job runs a model inside a sandbox with no network and no credentials, through a gateway that issues a key for that one run with a time and dollar ceiling. What the model answers is checked by code, by a second model, and only then delivered as a pull request or a chat message by code the model never touches. See [agents/jobs.md](agents/jobs.md) and [agents/guardrails.md](agents/guardrails.md).
- **`flax atlas`** maintains the atlas: one page per repository in a fixed template with stable section headings, budgets on size, generated cross-references, and a 3D map whose wiring is extracted by a model and then kept honest by deterministic resolution against known component ids. See [atlas/method.md](atlas/method.md).
- **`flax scenarios`** runs one Gherkin library against any environment and records which surface items each scenario touched. Surfaces (the API, the web app, the CLI, the installer, the docs site, the build action) are listed by builders from their machine-readable sources, so the coverage map says exactly what nothing proves yet. A persona and journey dataset says who needs what. See [scenarios/library.md](scenarios/library.md).
- **`flax explorer`** is the living map: a page plus a small service. Every surface item is a hex colored by its latest verdict per environment, personas walk their journeys across it, a timeline scrubs back through every run, and a running scenario breathes on the map as its steps finish. See [explorer/model.md](explorer/model.md).
- **lbx** is the sandbox the agents package depends on: a separate open-source host tool that runs one command, once, in a box with no network, a data directory and a read-only directory of Unix sockets as the box's only way out. See [lbx.md](lbx.md).

How they link: the agents package carries reference jobs that keep the other two fresh. `atlas-doc-refresh` finds atlas pages whose repository moved past the commit they describe and proposes the smallest cited edits; `atlas-map-refresh` regenerates the map and re-extracts wiring only for pages that changed; `scenario-checks` runs the scenario library against one environment on a schedule, keeps the results as a workflow artifact under a published contract, and pushes progress into the explorer as it runs. `scenario-watch` keeps scenario text true to the product. So one scheduled loop keeps the architecture map, the coverage map and the explorer in step with the code, and every edit it makes is a reviewable pull request with evidence.

The demo workspace in this repository, `demo/`, is a fictional company called notes-co: a notes web app, an API, a worker, a CLI, a docs site, an installer, a gitops repository and a build action, with two environments, `live` and `test`. Every example in these pages uses it.

## The documents

Start here:

- [getting-started.md](getting-started.md): the ten-minute path on a plain Linux host with docker.
- [workspace.md](workspace.md): the workspace convention and the shape of `flax.yml`.
- [contracts.md](contracts.md): the index of every published contract, with its type file.
- [lbx.md](lbx.md): the sandbox, its runtimes, unattended runs and the network wall.

The agents package:

- [agents/jobs.md](agents/jobs.md): the job format, field by field.
- [agents/guardrails.md](agents/guardrails.md): what code enforces before a model runs, and why.
- [agents/checks.md](agents/checks.md): what happens to the answer: checks, the second check, delivery by code.
- [agents/delivery.md](agents/delivery.md): pull requests, revisions and chat messages, by code.
- [agents/tools.md](agents/tools.md): how a model looks things up without holding a credential.
- [agents/runtime.md](agents/runtime.md): the sandbox, the agent image, sockets and networks.
- [agents/gateway.md](agents/gateway.md): the reference gateway deployment and the static provider mode.
- [agents/reference-jobs.md](agents/reference-jobs.md): the jobs that ship with the package.
- [agents/media.md](agents/media.md): the media kit: narrated videos rendered from scenario record runs, production options and stand-ins.

The atlas package:

- [atlas/method.md](atlas/method.md): why an atlas for coding agents, and the rules that keep it true.
- [atlas/template.md](atlas/template.md): the page template with notes-co examples.
- [atlas/wiring.md](atlas/wiring.md): model-extracted wiring kept honest by code.
- [atlas/viewer.md](atlas/viewer.md): the map.

The scenarios package:

- [scenarios/library.md](scenarios/library.md): one Gherkin library across surfaces and environments.
- [scenarios/personas.md](scenarios/personas.md): the persona and journey dataset.
- [scenarios/runner.md](scenarios/runner.md): environments, tags, fixtures, results and the live push.
- [scenarios/recorder.md](scenarios/recorder.md): terminal recordings that are also tests.

The explorer:

- [explorer/model.md](explorer/model.md): what the map shows and how to read it.
- [explorer/data.md](explorer/data.md): every data file and its contract.
- [explorer/deploy.md](explorer/deploy.md): the page, the service, ingest and the compose example.

## Conventions in these pages

The command is `flax <agents|atlas|scenarios|explorer> ...`. The workspace file is `flax.yml`. The sandbox is lbx, configured through `LBX_*` environment variables. Every example organization is notes-co. Where a page states something the packages do not do yet, it says "planned"; where a fact comes from the extraction work rather than from the package as published, the page lists it under "To confirm against the package" at its end.
