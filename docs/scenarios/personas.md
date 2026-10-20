# Personas and journeys

The persona dataset says who the product is for, what each of them is trying to do, and which surface items each step of their journey runs through. It lives beside the scenarios as YAML, is validated by code, and is joined to the coverage map so the explorer can say, per persona and per station, what proves it or that nothing proves it yet. This page describes the files, every field, the stations, the journeys and the checks.

## The files

```
personas/<id>.yml          one persona per file, with cited evidence
journeys/stations.yml      every journey station, defined once
journeys/<persona>.yml     a persona's stations in order
```

`flax scenarios dataset` validates the three kinds of file against the rules below and, when `coverage-map.json` is present, writes `journeys.json`: every station resolved to the item ids it matches, the orphans (items no journey touches), the stations whose matchers match nothing, and the dead matchers. That file is one of the explorer's data files.

## A persona

A persona file keeps its fields in a fixed order; a field out of order or an unknown field is an error. The fields:

- `id`: lowercase letters, digits and dashes; the file is named `<id>.yml`.
- `name`: how the persona is referred to.
- `type`: one of the persona types the workspace's vocabulary lists. The defaults: `primary`, `secondary`, `supplemental`, `internal`, `buyer`, `negative`. A negative persona is one the product is not designed for; it has no journey, and the "designed" fields may be empty for it.
- `summary`, `who`: one paragraph each on who this is.
- `titles`: job titles this persona holds.
- `goals`, `needs`: what they want and what they need from the product.
- `consumes`: what they take away (a report, a feed, an answer).
- `prize`: an optional `quote` in their words and a `test`: the one observable outcome that says the product paid off for them.
- `journey`: a `name` and `steps`, the journey in prose, before it is formalized as stations.
- `friction`: what gets in their way.
- `antiGoals`: what they must never have to do.
- `surfaces`: the surfaces they use; `neverTouches`: the ones they never do.
- `editions`: the product variants they use, from the vocabulary; required only when the vocabulary lists any.
- `fixtureRole`: which fixture identity plays this persona in a scenario.
- `tensions`: with another persona (`with`, by id), the `conflict`, and the design `rule` that resolves it.
- `evidence`: a list of claims, each with a `source`, a `date` and `assumption: true` until a real customer conversation confirms it.
- `sources`: the documents behind the evidence, each with a `title`, `date` and `where`.

A persona of any type but `negative` must fill every "designed" field; every persona must fill `id`, `name`, `summary`, `who`, `fixtureRole`, `evidence` and `sources`. Tensions must name another existing persona. The whole file text, comments included, is held to the workspace's wording rules (no em-dashes by default; a workspace adds its own banned words with the message to give).

notes-co's `personas/team-lead.yml`:

```yaml
id: team-lead
name: Priya, the team lead
type: primary
summary: Runs a small product team and keeps its decisions in shared notes.
who: A manager of six who writes the weekly plan and reads everything her team shares.
titles: [Engineering manager, Team lead]
goals: [Find last week's decision in ten seconds, Share a plan with one link]
needs: [Search across the team's notes, Share links that need no account]
consumes: The weekly plan page and the decisions folder.
prize:
  quote: I stopped answering "where did we decide that" in chat.
  test: A decision is found by search within a day of being written.
journey:
  name: From the first note to a shared plan
  steps: [Sign up, Create a folder, Write a note, Share it, Search for it later]
friction: [Sign-up asks for a company name she does not have]
antiGoals: [Managing permissions per note]
surfaces: [web, api, email]
neverTouches: [cli, action]
editions: []
fixtureRole: owner
tensions:
  - with: automation-engineer
    conflict: She wants fewer settings; he wants every setting exposed to the CLI.
    rule: Every setting has a default that needs no decision; the CLI exposes it anyway.
evidence:
  - claim: Team leads search before they browse.
    source: Interview notes, two product teams
    date: 2026-09-02
    assumption: true
sources:
  - title: Interview notes, two product teams
    date: 2026-09-02
    where: the research folder
```

## Stations

A station is one step of a journey, defined once in `journeys/stations.yml` so several personas can share it:

- `key`: a lowerCamel identifier.
- `name`: the step in the product's words.
- `stage`: one of the stages the vocabulary lists. The defaults: `Discover`, `Start`, `Survey`, `Understand`, `Act`, `Prove`.
- `kind`: how the station is proven: `surface` (by surface items), `planned` (by a feature not built yet) or `elsewhere` (by tests outside this library, such as a build's own edition tests).
- `match`: for a `surface` station, at least one matcher: an exact item id, a prefix ending in `*`, or `api:* <path>` for every method of a service surface's path (exact, or a prefix ending in `*`). A matcher must start with a surface name, may not match a whole surface, and may use `*` only at the end.

```yaml
stations:
  - key: signUp
    name: Sign up with an email address
    stage: Start
    kind: surface
    match: [web:signup, email:welcome]
  - key: shareNote
    name: Share a note by link
    stage: Act
    kind: surface
    match: [web:note:share, "api:* /v1/shares"]
  - key: searchLater
    name: Find a note by a word in it
    stage: Understand
    kind: planned
    match: []
```

## Journeys

`journeys/<persona>.yml` lists a persona's stations in order:

```yaml
persona: team-lead
stations: [signUp, createFolder, writeNote, shareNote, searchLater]
```

One journey per persona, no station twice, every station defined, no journey for a negative persona. The validator warns about a station on no journey and a designed persona with no journey yet.

## What the join gives

With the coverage map, each `surface` station resolves to the items its matchers match, and each item carries its status per environment. So the explorer can draw a persona's journey as a line across the map, say for every station what last proved it ("verified on Live at 5:32 PM" or "Nothing proves this yet"), compare the plan with reality in a persona-by-stage matrix, and list the gaps: stations without a scenario, planned work naming no persona, features on no journey, and items no journey touches. The dataset is the bridge between "what the product can do" and "who it is for", and it is why coverage is not a percentage: a hundred passing scenarios that touch nothing on anyone's journey are a hundred passing scenarios.

## To confirm against the package

- Whether the default vocabulary (persona types, stages, station kinds) ships with the package or must be given in the workspace.
- The exact `journeys.json` field names as the package writes them (see [../explorer/data.md](../explorer/data.md)).
