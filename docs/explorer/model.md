# The explorer's model

The explorer is a living map of what the product does and what proves it: every surface item is a hex, colored by its latest verdict per environment; items sit on one island per surface, in districts by area; personas walk their journeys across the islands; a timeline scrubs back through every run; and a scenario that is running right now breathes on the map as its steps finish. This page explains the model behind the picture so a reader can tell what a hex, a color, a door and a line mean. The data files are in [data.md](data.md), the deployment in [deploy.md](deploy.md).

## One hex is one reachable thing

A hex is a surface item: an API operation, a web route or a control on it, a CLI command, a docs page, an installer artifact, an action input. Items come from the builders in the scenarios package, never from the scenarios themselves, so the map shows what the product exposes whether or not anything proves it. A hex's label is the item's label; its kind (a page, an element, an operation, a command) comes from the workspace's naming rules over the item's id and details, in product words.

A hex is split into sectors, one per environment, in the order `flax.yml` lists them: the first environment (the reference one) is centered on the top vertex, the rest go clockwise. With three environments the sectors are the three rhombi of a cube; with two they are halves; with one, the whole hex. Each sector carries that environment's verdict. A hex for an item that does not exist in an environment has that sector empty.

## Verdicts per object per environment

A verdict is the latest result of the scenarios that touched the item in that environment:

- grey, `uncovered`: nothing touches it;
- hatched, `planned`: only a planned scenario names it;
- red, `failing`: the latest run that touched it failed;
- green, `passing`: the latest run that touched it passed.

Verdicts are per environment because the same build can pass on `test` and fail on `live`, and because an item verified nowhere but the reference environment is still a gap elsewhere. A failing hex pulses; the panel beside the map says the scenario as a sentence, the failed step, the error, since when, the build it ran against and the screenshot. The words say "verified at 5:32 PM" rather than counting checks: the number of scenarios behind a verdict is a detail, the time it was last true is the fact.

## Islands and districts

Each surface is an island, and an island is divided into districts by area: the API's tags, the web app's route sections, the docs site's sections, the CLI's command groups. The workspace may split one surface into several islands (a public website drawn as three sites) by naming the areas each takes. A surface that lives in only some environments has its hexes' other sectors empty; a surface with one deployment for all environments (a public site) is named by its area and never by an environment.

Islands are laid out once from the data, deterministically, so the same data draws the same map and a link to an item lands on the same hex tomorrow.

## Sub-maps

An item with parts (a page with its controls) is a hex that opens into a sub-map: the page's elements as hexes of their own, with the page's verdict summarizing theirs. The map has levels, and every level is a path in the URL, so a sub-map is a page one can link to, not a panel inset.

## The four doors

Every door keeps the map (or, for personas, the journey lines), the timeline, the live strip and a panel beside the map; the words live in the panel, the picture stays.

- **Now** (the landing page): one sentence per environment, the reference environment first ("All 45 scenarios verified on Live at 5:32 PM PDT."), then under each environment what is failing there and what flipped in its last run. Failing hexes pulse; running ones breathe while a run is in progress.
- **Features**: the catalog of every feature file in the product's own words, by surface, with search over names, descriptions and steps. A feature's page shows where it stands per environment, its scenarios with their steps, the items it touches (lit on the map, everything else veiled), the personas that need it, its known problems and the planned work against it.
- **Personas**: the journey lines beside a persona-by-stage matrix, a brief per persona (who, goals, needs, prize, friction, evidence) with every station and what proves it or "Nothing proves this yet", plan against reality, and a gaps page: stations without a scenario, planned work naming no persona, features on no journey, items no journey touches.
- **Planned**: tracked issues and written-but-waiting scenarios, by area or by persona, with the feature each extends and the personas it serves; the map dims everything already built.

Under Features sits the inventory map itself (`/map`), zoomable to a surface, an area or one item, with the panel reading out the product, a surface, an area or one item with what last proved it and what fails. A scenario view (`/scenarios/<id>`) shows any scenario's steps with each step's result and time per environment side by side, the failure message and screenshot, and the build it ran against. Search (`/` or Ctrl K) covers features, personas, items, scenarios and stations, each with where it passes and when it last did.

## The timeline

Every scheduled run is a point on the timeline, per environment. Scrubbing back redraws every verdict as it stood after that run, with the build each service answered then, so a reader can see when an item started failing and which deploy was in between. A run started by a deploy carries its reason. The data behind it is a list of snapshots, one per run, each with a status string of one character per item per environment, which is why the page can scrub without refetching.

## The live strip

When a run is in progress, a strip per environment shows its progress and failures, the hexes of running scenarios breathe on the map, and the open scenario's steps fill in as they finish. The strip comes from the explorer service's event stream; when the run ends and the new data version is built, the page reloads its data in place, keeping its path, selection and timeline point. A run the service knows about but that pushes nothing (the scheduled job without a token) shows as in progress with no detail.

## Navigation lives in the URL

Every view is a path, and any of them can be pasted into a message:

| path | opens |
|---|---|
| `/now` | what is broken, what flipped and what ran, per environment |
| `/features`, `/features/<surface>`, `/features/<surface>/<feature>`, `/features?q=words` | the catalog, one surface, one feature, a search |
| `/personas`, `/personas/<persona>`, `/personas/<persona>/<station>`, `/personas/gaps`, `/personas/no-persona` | the matrix and lines, one persona, one station, the gaps, the items on nobody's journey |
| `/planned`, `/planned?by=persona` | planned work by area or by persona |
| `/map`, `/map/<surface>`, `/map/<surface>/<area>`, `/map/item/<item id>` | the inventory map, zoomed |
| `/scenarios/<scenario id>`, `/map/item/<item id>/scenario/<scenario id>` | a scenario, alone or opened from an item |

Query parameters keep the rest: `?env=<id>` (every environment when absent), `?at=<run id>` for an earlier timeline point, `?step=<n>` for a step of the open scenario, `?view=orphans` on the map. In the single-file build the same path rides after a `#`.

## The usage view

When a real-usage file is given (see [data.md](data.md)), the map heats each API hex by how many real requests it had in the reference environment, keeps the verification in the hex's center, and lists the items customers use that fail somewhere, the ones customers use that are not verified in every environment yet, and the ones verified everywhere that nobody used. Without the file the view is hidden; the map never shows a missing file as zero use. The view ships as a plug-in point in the first version: the data file contract is published so an organization with its own usage aggregates can light it up.

## To confirm against the package

- The sector layout for more than four environments, and the legend's wording.
- Whether the usage view's page code ships in the first version or only its data file contract.
