# flax

flax is a set of packages for keeping an engineering organization honest about itself: scheduled agents that run unattended on cheap models with code guardrails, an architecture atlas of your repositories written for people and coding agents, a scenario library that proves what your product does across every surface, and an explorer that maps it live. Your content (jobs, atlas pages, scenarios, personas, configuration) lives in your own workspace repository; flax reads it and never contains it.

Packages: `@flax/core`, `@flax/contract`, `@flax/agents`, `@flax/atlas`, `@flax/scenarios`, `@flax/explorer`, `@flax/cli`, plus `packages/gateway`, a reference model-gateway deployment. The `flax` command is the one entry point: `flax agents ...`, `flax atlas ...`, `flax scenarios ...`, `flax explorer ...`. Each release publishes the packages, built, as tags of this repository (`core-vX.Y.Z` and so on) that a workspace depends on as git dependencies; see [docs/getting-started.md](docs/getting-started.md).

The `demo/` workspace is a fictional company, notes-co, that every package runs against.

Licensed under Apache-2.0.
