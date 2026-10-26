# The workspace

A workspace is where your content lives: the jobs, atlas pages, scenarios, personas and configuration that describe your organization. It is a plain directory, usually a private repository of its own, with one `flax.yml` at its root. The flax packages are published and versioned; the workspace pins them and never contains them. This page describes the shape of `flax.yml`, what each section holds, how environments work, and the line between what belongs in the workspace and what belongs in the framework.

## Why a separate workspace

Three things are true of every organization that runs flax: its repositories have names, its environments have names, and its content changes every week. None of that belongs in a published package. The framework reads the workspace, validates it, generates what it needs from it (workflows, bundles, data files) and writes nothing into it that a person did not ask for. The package cannot rot unnoticed either, because the organization's own jobs run on it; a private workspace that pins a public package is the same arrangement that kept the original internal tooling honest.

The split also keeps secrets, hostnames and history out of the public packages. A workspace holds the names of secrets and where they are stored, never their values. The framework holds neither.

## The shape of flax.yml

The notes-co demo workspace, `demo/flax.yml`, is the smallest valid file:

```yaml
# notes-co's flax workspace. Shared keys here; each package reads its own section below.
org: notes-co
github: notes-co
environments:
  - { id: live, label: Live }
  - { id: test, label: Test }
agents: {}
atlas: {}
scenarios: {}
explorer: {}
```

The shared keys are validated by the core loader (`packages/core/src/workspace.ts`):

- `org` (required): the short organization name used in defaults and titles. Never an internal codename; it appears in page titles, commit messages and generated prose.
- `github` (optional): the GitHub owner the workspace's repositories live under. Builders clone from it, delivery writes to it, and the atlas links to it.
- `environments` (required, at least one): the environments in order. An entry is either a plain string (`live`) or a mapping with `id` and an optional `label`. Ids must be unique. The first environment is the reference environment (below).
- One section per package: `agents`, `atlas`, `scenarios`, `explorer`. The loader keeps every other top-level key as an untyped section and leaves its shape to the package that owns it. A missing section reads as an empty mapping; a package with nothing to configure needs no section at all.

Everything else is per package. Each package documents its own section in its own pages; the summary:

- `agents:` holds what the job runner needs beyond the shared keys: `repo` (the workspace's own repository), `budgetUsdPerMonth` (shared by all jobs; 100 by default), `runsOn` (runner labels), `sandbox` (the lbx repository whose releases carry the launcher, and the secret for a private one), `agentImage` (the image repository the sandbox pin names a digest of), `provider` (`name`, `baseUrl`, `keyMode` as `static` or `litellm`, an optional `plugin`), `networkJoins` and `setupSteps` (named workflow steps a job may ask for), `trustedLinkHosts`, `displayName`, `commitAuthor`, `neverEvidenceRepos`, `kitAction` (the reusable action every model job calls), and optional `board`, `epicsRepo`, `clusters`, `openobserve`, `video` and `docsLint` for the tools and checks that need them. A section that says nothing gets a stranger's safe defaults. The jobs live in `jobs/`, the tools in `tools/`, and the allowlists (models, channels, repositories, link hosts, the sandbox and gateway pins) in their own YAML files beside `flax.yml`. See [agents/jobs.md](agents/jobs.md).
- `atlas:` holds `root` (the atlas directory, `atlas` in the demo), `org` (the registry, package groups and own hosts the stages recognize), `site` (title, search placeholder, time zone), `planes` (one list, each with `index` and `map` flags, a heading, a color and a layout anchor), `map` (default planes, plane rules, views, the environments' role sentences, delivery nodes, sites, outlets, curated edges, the gitops layout, and `resolve` with aliases, canonical names, store names, owned databases and the emit floor), `checks` (the gitops path check, off by default) and `llm` (concurrency). The pages live under `<root>/repos/`, the flows in `<root>/viz/flows/`, the wiring cache in `<root>/viz/cache/`. See [atlas/method.md](atlas/method.md).
- `scenarios:` holds `name` and `repo` (the library's own repository), `http` (the user agent and the synthetic-client header every request carries), `envPrefix` (the prefix of the variables the runner hands the steps), `envs` (per environment id: `hosts` by key such as `api` and `web`, `excludeTags`, `allowTags`, `fixtures`), `versionProbe`, `surfaces` in display order (name, title, role, link host, kinds, page and element kinds, islands), `vocabulary` (persona types, stages, station kinds, editions), `personaRequiredFields`, `textRules`, `matchers`, `cucumber` (import globs and the features directory), `paths` (surfaces, features, personas, journeys, results, the coverage map, the gaps file, the journeys output, the board, the documentation sources), `timezone`, `tagLabels`, `recorder`, `capture` (the tag and page settings of screenshot runs) and `cadences` (slower schedules for heavy scenarios, each a tag and the environments it runs in). See [scenarios/runner.md](scenarios/runner.md).
- `explorer:` holds `title` and `description` for the page, `glossary` (the product's own glossary entries, each a `term` and a `text`, with an optional `section` naming a built-in heading) an optional `results` (the repository, workflow and job whose artifacts the service reads from the code host, and `extraJobs` for more jobs, such as a cadence's) and an optional `usage` (the usage view: the environment, the labels for each class of use, what an organization is called, the surfaces that count requests, and a history file for builds without a service; see [explorer/usage.md](explorer/usage.md)). The explorer reads the scenarios section too, since it draws the same surfaces, islands and kinds. See [explorer/data.md](explorer/data.md).

## Environments and the reference environment

The `environments` list is the one order for everything that varies by environment: how the explorer displays them, how status strings are written in data files (one character per environment, in this order), the merge precedence when two environments disagree about a surface item, and which environment is the reference. The reference environment is the first one. It is where the explorer's landing page leads, where personas are judged, and the environment a phrase like "on the way to live" points at. notes-co lists `live` first and `test` second; an organization with a staging tier between them lists three.

A scheduled job that checks environments (`scenario-checks` is one) names its environments by these ids in `job.yml`, one cron each, and every run checks exactly one. A scenario limits itself to environments with `@env:<id>` tags using the same ids. A surface that exists in only some environments says so in the scenarios section.

## What belongs where

In the workspace:

- Content: jobs with their prompts, schemas and fixtures; tools that read your systems; atlas pages, flows and the wiring cache; feature files, step code, personas and journeys; the explorer's board file.
- Names: your organization, GitHub owner, environments, hosts, channels, repositories, teams, runner labels, link hosts.
- Pins: the version of each flax package, the sandbox release and commit, the agent image digest, the gateway's address and certificate authority root.
- Generated files the framework writes for you to commit: workflows, the runner bundle, `JOBS.md`, the atlas's generated tables and outlines, and the explorer's board.

In the framework:

- The runner, the checks, the tools server, the forwarder, delivery and revision code, the agent image definition and the reference gateway deployment.
- The atlas tools, the pipeline stages, the extraction prompt (a workspace may override it), the viewer.
- The scenario runner, the coverage map, the dataset validator, the generic surface readers (OpenAPI, action metadata, sitemaps, registry tags), the terminal recorder, the explorer page and service.
- Every contract: data files, live events, run results, touches, run artifacts, the sandbox status grammar.

The rule of thumb: if a file would be different for another organization, it is workspace content; if it would be the same, it is framework.

## Pinning the packages

A private workspace is a small Node project. Its `package.json` depends on the flax packages at a version and carries the scripts that call them:

```json
{
  "name": "notes-co-flax-workspace",
  "private": true,
  "dependencies": {
    "@flax/cli": "0.1.0",
    "@flax/agents": "0.1.0",
    "@flax/atlas": "0.1.0",
    "@flax/scenarios": "0.1.0"
  },
  "scripts": {
    "check": "flax agents check && flax atlas check && flax scenarios check",
    "generate": "flax agents generate --dist"
  }
}
```

`flax <package>` resolves `@flax/<package>` from the workspace's own `node_modules` and runs the entry that package names, so the workspace's lockfile decides which framework version every command and every generated workflow uses. The sandbox is pinned separately, by release tag and commit, because it is a host tool and not an npm package; the agent image is pinned by digest. Moving to a newer framework is a dependency bump, a `flax agents generate --dist` and a review of the diff in the generated files.

## To confirm against the package

- The defaults of each section's keys as the packages publish them.
- Which end of the `environments` list wins a merge (the demo's comment says a later environment's reading wins; the extraction notes said the first).
- The published package names and the first version number.
