# The scenario library

One Gherkin library proves what the product does, across every customer surface and every environment, and the same scenarios serve live checks, recordings for the manuals and the coverage map. This page explains the idea: surfaces listed by builders from their machine-readable sources, items and parts, touches as the unit of proof, the coverage map and its gaps, and planned scenarios for features not built yet. The runner, the tag policy and the results format are in [runner.md](runner.md); the persona dataset in [personas.md](personas.md).

## One library, many uses

A product has several surfaces people meet: an API, a web app, a command line, an installer, a documentation site, a build action, the emails it sends. Each usually has its own tests in its own repository, written in its own vocabulary, and nobody can say which customer-visible thing nothing proves. The library takes the opposite shape: one repository of feature files in the product's own words, grouped by surface, that a runner points at one environment at a time. A scenario reads the same whether it drives a browser, calls the API or types into a shell, and a feature file is the catalog entry the explorer shows and the recording the manual embeds. The scenarios use no model anywhere; they are deterministic checks, and their value is that they can be trusted on a schedule.

## Surfaces, items and parts

A surface is one way the product is reached. A surface item is one reachable thing on it: an API operation, a web route or a control on it, a CLI command, an installer artifact, a documentation page, an action input, an email. Items come from builders, not from scenarios: each builder lists every item of one surface from that surface's machine-readable source of truth and writes `surface/<name>.json`. No model is involved. notes-co's surfaces:

| surface | role | source the builder reads |
|---|---|---|
| api | service | the published API reference, per environment |
| web | ui | the web app's routes and every test id in its source at the default branch |
| cli | other | the CLI's commands that reach the service |
| action | other | the build action's metadata at its latest release |
| install | other | the installers, release files and package registry entries |
| docs | site | the docs site's sitemap and source |
| email | other | the emails the API and the identity provider send |

Every item has a stable id (`<surface>:<natural key>`, never a counter or a hash of volatile data), a label, its surface and area (the API tag, the route section, the site, the command group), the environments a scenario must cover it in, where and when it was read (`seen`: a URL, or a repository file at a commit), and optional details the explorer uses (a kind, a route id, the documents that mention it). An item may have a parent, which makes it a part: a page's share control is a part of the page. The explorer draws a page as a hex that opens into a sub-map of its parts. A surface that exists in only some environments says so in the workspace, and a surface with one deployment for all environments (a public site) is named by its area, never by an environment.

Each surface file also lists `outOfScope` (something deliberately not counted as surface, with the reason) and `notes` (plain statements about how the surface was read and what could not be read), so a gap in the map is never a silent omission.

The generic readers ship with the package: an OpenAPI reader, an action metadata reader, registry tag readers, sitemap, robots and search-index readers, and a reader for a web framework's routes and test ids. A builder for a surface of your own is a small module that calls them and returns items; the workspace registers it by surface name.

## Touches: the unit of proof

A scenario proves an item by touching it. Touches happen three ways: the API client records a touch for every answered request, the browser page records one for every route it lands on, and a step calls `touch(item, need?)` for everything else (a CLI command that ran, an installer that was downloaded, an email that arrived). A touch names the item, optionally which need it proved, and the step that was running. The run attaches each scenario's touches to its result, and the coverage map turns touches into statuses.

Needs make a touch precise. An API operation passes in an environment only when scenarios prove both its success and its refusal without a token, so one touch may say `need: success` and another `need: auth-refusal`. The client also records refusals of a bad token, of a session that is not an API token, and of a missing permission; the gaps page shows those as "also proven", and an operation never needs them to pass.

## The coverage map and the gaps

`flax scenarios coverage` reads `surface/*.json` and, when given result directories, the runs, and writes `coverage-map.json` (every item with its status per environment) and `GAPS.md` (every gap by name, grouped by surface and area). Statuses per item per environment:

- `uncovered`: no scenario touches it;
- `planned`: only a planned scenario names it;
- `failing`: the latest run that touched it failed;
- `passing`: the latest run that touched it passed.

A status string is written with one character per environment in the order `flax.yml` lists them, and the file names that order in `envs`, so a reader never assumes a count. Items are judged per environment: an item verified on `test` and never touched on `live` is a gap on `live`. The map marks every item `uncovered` until scenarios exist, which is the point: the first coverage map of a product is a list of everything nobody proves, and `GAPS.md` is the backlog it implies.

A documentation sources file lists the READMEs and internal pages that document items, with the ids each one names, so the explorer can show where an item is documented; sources are not items and have no coverage.

## Planned scenarios

`@planned` marks a scenario for a feature not built yet. It is listed, never run, and its steps may not exist. It lets the library say what the product should do before it does, lets the coverage map show `planned` instead of `uncovered`, and lets the explorer's planned door list written-but-waiting scenarios beside the tracked issues they wait on. When the feature ships, the tag comes off and the steps are written; the scenario id (`<feature file>:<line>`) stays stable while the scenario stays where it is.

## Writing a scenario

Features live in `features/<surface>/`, step code in `src/steps/`, and helpers the steps share in `src/checks/`. Given steps are setup and type nothing; When steps are what the reader does; Then steps are what they see. A scenario names what it needs with tags, never a product variant by name: `@env:<id>` limits it to environments, `@fixture` says it creates a fixture organization, `@serial` says it changes something outside its fixture that another scenario reads, `@dispatch` says it starts a workflow on the code host. The world object the steps share is a class the package exports (environment, hosts by key, run id, touches, a browser page with route tracking) that a workspace subclasses with its own API client and fixture logic.

```gherkin
Feature: Sharing a note

  @env:test @env:live @fixture
  Scenario: A reader opens a shared note without signing in
    Given a note shared by the fixture user
    When I open the share link in a fresh browser
    Then I see the note's title and body
    And the API refused the share without a token
```

The last step is a `touch` with `need: auth-refusal` on `api:GET /v1/shares/{id}`; the second is a browser route touch on `web:share`; both come from steps the workspace wrote once.

## To confirm against the package

- The exact builder registration shape and the list of generic readers in the first public version.
- The status names in `coverage-map.json` and the `GAPS.md` layout as the package writes them.
