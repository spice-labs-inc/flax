# @flax/scenarios

A runner for a Gherkin scenario library that proves what a product does across every surface (web app, API, CLI, emails, websites) and every environment, plus the coverage map and the persona dataset that go with it. Your scenarios, step definitions, surface files, personas and journeys live in your workspace; this package reads them and never contains them.

## Commands

Run in the workspace directory (the one holding `flax.yml`), or point `FLAX_WORKSPACE` at it:

| command | does |
|---|---|
| `flax scenarios run --env <env> [--tags <expression>] [--out <dir>] [--dry-run] [--fixtures] [--dispatch] [--parallel <n>] [feature paths...]` | runs the scenarios against one environment with cucumber, writes `results/<env>/<run id>/` (`run.json`, `planned.json`, `messages.ndjson`), and, when `EXPLORER_URL` and `EXPLORER_INGEST_TOKEN` are set, pushes the run's progress to an explorer service as it goes |
| `flax scenarios run --env <env> --record <dir> [--record-all] [--dry-run] [feature paths...]` | the same run limited to the scenarios with a video sidecar (`<name>.video.yml` or `<name>.<id>.video.yml` beside the feature; every selected scenario with `--record-all`), paced and filmed: `<dir>/<id>/` gets `video.webm`, `timeline.json`, a screen per step, terminal scenes and the sidecar; see [docs/scenarios/recorder.md](../../docs/scenarios/recorder.md#browser-recordings) |
| `flax scenarios coverage [--results <dir>]` | the coverage map (`coverage-map.json`) and its report (`GAPS.md`) from the surface files and the latest run per environment |
| `flax scenarios dataset` | validates `personas/*.yml`, `journeys/stations.yml` and `journeys/*.yml`, then resolves every journey's stations against the coverage map into `journeys.json` |

`flax` is `@flax/cli`; `flax-scenarios` is the same entry as a plain bin.

## The workspace

```
flax.yml            org, github, environments, and the scenarios: section
surface/<name>.json one file per surface: every item a scenario can touch (see @flax/contract SurfaceFile)
features/<surface>/*.feature
steps/*.ts          step definitions; support/world.ts subclasses the World below
personas/*.yml      the persona dataset
journeys/stations.yml, journeys/<persona>.yml
results/<env>/<run id>/
```

Every path above is a default; the `paths` key of the `scenarios:` section renames any of them, and `demo/flax.yml` in this repository shows every key with a comment.

### flax.yml, the scenarios section

- `envs.<id>`: per environment (the ids come from the shared `environments` list, whose first entry is the reference environment), `hosts` by key (`api`, `web`, whatever the steps and builders need), `excludeTags` (tags a scheduled run never runs there) and `fixtures: always | when-asked | never` (whether runs create fixture accounts there: always, only when started with `--fixtures`, or never).
- `surfaces`: in display order; `title`, `role` (`ui`, `service`, `site`, `other`), `envs` (where the surface exists; empty means everywhere), `linkHost` (the host key a route id is appended to for a link), `kinds` (how items are named in product words, by id segment or `details.kind`), `pageKind` and `elementKind`, and `islands` for a surface drawn as several islands.
- `vocabulary`: `personaTypes`, `stages`, `stationKinds`, `editions`, `editionTitles`, and `elsewhere`, the sentence used for anything verified outside these runs.
- `textRules`: regular expressions the dataset's prose must not match, with the message to give.
- `http`: the user agent and the synthetic-client header every scenario request carries, so the product can tell checks from customers.
- `cucumber`: `imports` (globs of support and step files), `features`, `stripTypes` and `loaders` (below).
- `versionProbe`, `touchesMediaType`, `envPrefix`, `timezone`, `tagLabels`, `recorder`, `matchers`, `personaRequiredFields`.

## Step files run on plain Node

The runner registers its own module loader that type-strips `.ts` step and support files with Node's `stripTypeScriptTypes`, in the main thread and in every worker of a parallel run. Nothing else is needed on the path. The requirements are Node's: Node 22.13 or later, erasable syntax only (no enums, namespaces or parameter properties; `import type` for types), and relative imports that name their `.ts` extension. A workspace that prefers another loader sets `cucumber.stripTypes: false` and lists it under `cucumber.loaders` (for example `["tsx/esm"]`).

## The World and the hooks

`@flax/scenarios/support/world` exports `ScenarioWorld`: `env`, `hosts` (the environment's hosts by key), `runId`, `touches` with `touch(item, need?)` and `record(touch)`, `page()` (one Chromium per run, a context per scenario, and every navigation on a surface with a `linkHost` recorded as a touch of its route), `byTestId(surface, id)`, `closePage()`, and `media` and `recording` (below). `@flax/scenarios/support/hooks` exports `installBaseHooks({ timeoutMs, recordInitScript })`: the default timeout, parallel assignment by tag policy, the step index on every touch, the touches attachment after each scenario, the shared browser's close, and in a record run the recording of each filmed scenario.

A workspace subclasses the World and registers the subclass:

```ts
import { setWorldConstructor } from "@cucumber/cucumber";
import { installBaseHooks } from "@flax/scenarios/support/hooks";
import { ScenarioWorld } from "@flax/scenarios/support/world";

export class NotesWorld extends ScenarioWorld {
  token: string | undefined;
}
setWorldConstructor(NotesWorld);
installBaseHooks({ timeoutMs: 10_000 });
```

and adds its own hooks beside the base ones (an environment guard, fixture teardown). The private half of a product's World (its API client, fixture accounts, sign-in) stays in the workspace, in the subclass.

Steps tell a recording what they act on through `this.media`: `click(locator)` and `type(locator, text)` act (paced, with a cursor, when the scenario is filmed), `pointAt(locator)`, `highlight(locator)` and `terminal({ command, output })` only matter when it is. `installBaseHooks({ recordInitScript })` hands a filmed page a script for every document, such as stand-in text. The sidecar schema is `@flax/scenarios/record/video-sidecar.schema.json`; its loader, the timeline types and the pacing are in `record/sidecar`, `record/timeline` and `record/pace`.

Playwright is a peer dependency, loaded only when a scenario asks for a page: a workspace with no browser scenarios installs none.

## Local scenarios

`@flax/scenarios/local/terminal`, `local/recorder` and `local/stops` are the public half of a local runner: a real shell (bash, zsh or pwsh) in its own tmux server with a sandbox home, a recorder that keeps a terminal session as a cast with stops, and the stop markers. The product-specific half, which commands are run, how the product's wrapper and container runtime are shimmed, which editions exist, stays in the workspace: a World that subclasses the public one and a runner that sets the variables those steps read. The package ships no `local` command; a workspace writes its own on top of these pieces.

## Mailbox

`@flax/scenarios/mailbox` waits for the emails a scenario causes (a sign-in link, an invite) in an IMAP mailbox the workspace names. It loads no browser.

```ts
import { awaitLink, plusAddress, type Mailbox } from "@flax/scenarios/mailbox";

const mailbox: Mailbox = { host: "imap.example.com", user: "checks@example.com", password: process.env.MAILBOX_PASSWORD! };
const to = plusAddress(mailbox.user, `login-${runId}`); // checks+login-<run id>@example.com
const since = new Date();
// ... the step asks the product to send the email to `to` ...
const link = await awaitLink({ mailbox, to, since, pattern: /https:\/\/app\.example\.com\/login\?[^\s"'<>]+/ });
```

- `Mailbox`: `{ host, port?, user, password, secure? }`; `port` defaults to 993 and `secure` (TLS from the start) to true.
- `plusAddress(user, tag)`: `user+tag@domain`, so each run's emails are told apart in one mailbox.
- `awaitMessage({ mailbox, to, since, folders?, timeoutMs?, pollMs?, match?, log? })`: polls until an email to `to` that arrived after `since` and passes `match` is there, newest first, and returns `{ folder, subject, date, text, html }`. Each poll opens a fresh connection and searches `folders` in order (default `INBOX`, `Junk`, `Spam`; a folder the mailbox lacks is skipped, and a provider with another spam folder name is given it). The defaults are 5 minutes and 5 seconds; past the timeout it throws, naming the address.
- `awaitLink({ ...the same, pattern })`: the first match of `pattern` in the first such email whose text or HTML has one, with `&amp;` undone. `findLink(pattern, text, html?)` is the same extraction on its own.
- `connect`: how a poll opens the mailbox (`connectImap` by default); tests pass a fake `MailClient`.

## Library

Everything the commands use is exported: `@flax/scenarios/lib/surface` (reading, merging and writing surface files), `lib/repo` (shallow clones of a workspace's repositories into a cache), `lib/http` (fetch with the synthetic identity), `mailbox` (above), `run/messages` (cucumber messages into results), `run/tags` (the one declarative environment and tag policy), `run/live` (the push to an explorer), `coverage/map`, `dataset/schema`, `dataset/journeys`, and `builders/sveltekit` (a surface builder for a SvelteKit app: routes, test ids, form actions). The data shapes are in `@flax/contract`.
