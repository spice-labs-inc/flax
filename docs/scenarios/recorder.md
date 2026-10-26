# The recorder

Scenarios tagged `@local` run a command-line product on this machine, in a real shell, with no services, and the same scenario can be recorded as a terminal cast a manual embeds. Scenarios that drive a web app can be filmed the same way, for a video, and can supply a manual's screenshots. The test and the recording are one file, so they cannot drift apart. This page describes how local scenarios run, what a recording contains, how the recordings are checked on another operating system, the browser record mode and capture runs.

## Local scenarios

`flax scenarios local --image <image> --edition <name> --editions <file> --wrapper <path>` runs the `@local` features (`features/cli/local/`) against one product image. Each scenario runs in a real shell (bash, zsh or PowerShell) in its own terminal multiplexer server, with a sandbox home where the product's command is the wrapper given, pointed at the image, and tab completion set up from the image the way the installers set it up. Steps type commands as a person does; a prompt hook in each shell records every command's exit status without printing anything, so a step knows when its command finished and how. Docker, the multiplexer and the shells are needed; recording also needs a terminal recorder with a headless mode.

Products are described in an editions file the workspace points at: what each product variant has. A scenario says what it needs with tags, never by naming a product: `@feature:<f>` and `@without:<f>` (a feature from the editions file), `@online` or `@airgapped`, `@licensed` or `@unlicensed`. A step whose output differs between products asks the product (`this.has("search")`), so the feature files read the same in every variant. Licensed variants need the license in the environment; airgapped ones run with no network.

Given steps are setup and type nothing; When steps are what the reader does; Then steps are what they see. A `Given I use <shell> as my shell` step makes the shell part of the recording's name, so an outline over shells records one per shell.

```gherkin
Feature: Listing notes from the terminal

  @local @id:list-notes @feature:search
  Scenario Outline: List notes and search them
    Given I use <shell> as my shell
    And a folder with three notes
    When I run `notes list`
    Then I see three titles
    When I run `notes search plan`
    Then I see the note titled "Weekly plan"

    Examples:
      | shell |
      | bash  |
      | zsh   |
```

## Recordings

With `--record <dir>`, each passing scenario tagged `@id:<name>` is recorded as `<dir>/<product>/<name>[@shell=<s>].cast` (asciicast v2), with a transcript (`.txt`, one segment per stop) and a description (`.json`: id, title, variant, and the actions of each stop with the commands they ran, for a reader to copy). A recorded scenario runs in a fixed path under the system temp directory, since the tool's output shows its paths. The recording starts with the first action, out of sight of the setup; typing is paced like a person's and every key is an input event; after each group of actions and their checks the player stops, at a marker labelled with the group's first action. A scenario that fails writes no recording. `@rows:<n>` and `@cols:<n>` size the terminal.

What went to docker is recorded too: a recorded scenario's shell finds a docker shim first on its path, which runs the real docker and keeps each call's arguments (without secret values), working directory, the product's variable names, exit status and, where docker did not write to the terminal, its output. Each recording gets a `.docker.ndjson` beside it, one line per command; its `.json` also says the shell, the home, the files the setup made and what was typed before Tab. A manual that embeds the cast can show the exact docker command line a wrapper built, and a reviewer can diff two releases' recordings for what changed under the hood.

## The Windows check

PowerShell recordings are made in a Linux PowerShell, but readers on Windows run a Windows wrapper that builds its own docker command line, and a hosted Windows runner cannot run Linux containers. So the check runs the wrapper against a mock docker, under both PowerShell 7 and Windows PowerShell 5.1:

- `flax scenarios windows plan --recordings <dir> --ps1 <wrapper> --out <dir>` writes, for each edition with PowerShell recordings, a plan, a check script and the wrapper. With `--docs <dir>`, it also collects every PowerShell code block of the documentation pages, which are only parsed.
- On a Windows runner, the check script parses every command a recording typed with the PowerShell parser, makes the files the scenario's setup made, runs every product command through the wrapper with a mock docker that logs the command line and replays what docker printed on Linux, and tries every completion the recording shows.
- `flax scenarios windows gate --plan <dir> --results <dir>` prints every problem and exits 1 on any: a command that does not parse, exits differently from Linux, or whose docker run differs from the Linux wrapper's (image, arguments, mount targets and variable names, paths compared without drive letters or the home), and a completion that offers nothing.

It does not cover a real Linux container under a desktop docker on Windows.

## Browser recordings

The same scenarios that check a web app can film it. `flax scenarios run --env <env> --record <dir> [--record-all] [feature paths...]` runs the scenarios of the selection that have a video sidecar (every selected scenario with `--record-all`), one at a time, paced for a viewer, and writes a recording per scenario. The rest of the run is the ordinary one: the same steps, the same tag policy (except that cadence tags leave nothing out), the same results directory. With `--dry-run` it checks the sidecars against their scenarios and every step's definition, and writes nothing. A recording is made in a run that passes as much as in one that fails; a failed one is marked so, and a renderer refuses it.

### The video sidecar

A sidecar sits beside its feature file: `<name>.video.yml` for one recorded scenario, or `<name>.<id>.video.yml` for each of several (a file may also hold several YAML documents). It is matched on `scenario`, the scenario's exact name (an outline's name after its example values are filled in, so put an example column in it). The schema is `@flax/scenarios/record/video-sidecar.schema.json`; the runner checks every sidecar before it runs anything and names the file and key of each problem.

```yaml
scenario: Add a note # the scenario's exact name
id: add-a-note # the media id: the recording's directory, stable across re-recordings
title: Adding a note
description: How to add a note. # optional
voice: narrator-1 # optional; a voice id the renderer interprets
pace: { typeMsPerChar: 60, afterActionMs: 600, readMs: 1200 } # optional; overrides flax.yml's recorder.pace
viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } # optional; overrides recorder.viewport and recorder.scale
intro: # optional title card before the first filmed step; text is spoken over it
  chapter: Introduction
  heading: Adding a note
  sub: Notes in two steps
  items: [Type a title, { label: Save it, icon: disk }]
  text: This is how to add a note.
outro: { heading: Next steps, text: Notes can also be shared. } # optional closing card, same keys
narration: # each block starts at its step and runs until the next block's
  - at: 2 # a step: its number among the scenario's own steps (Background not counted),
    text: Type a title. # or its exact text with its keyword as written
  - at: Then the list shows "Weekly plan"
    text: The note appears in the list.
chapters:
  - { at: 2, title: Add a note }
highlight: then # then (every filmed Then, the default), none, or a list of steps
hide: [1] # steps that run but are not filmed; every Given by default
poster: { at: 4, title: Adding a note, kicker: How-to }
terminal: # optional; one override or a list: what a terminal scene shows
  at: When I list the notes from the terminal
  display: notes list --all # the command line shown in place of the one the step ran
  preface: ["export NOTES_TOKEN=example"] # lines typed before it
standIns: default # optional; the name of a stand-in rule set the workspace supplies
publish: {} # passed through untouched to whatever delivers the video
```

Step references are checked against the scenario: a number out of range, a text no step reads (or that two steps read), narration, chapters, a poster or a terminal override at a hidden step, and narration or chapters out of order (each block runs until the next one, so two at one step would overlap) are all refused. Text references survive steps inserted above them; numbers do not.

### What steps tell the recording

A step tells the recording what it acts on and checks through `this.media` on the base World:

| call                                                                | in a recorded scenario                                                                                                   | anywhere else |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `media.click(locator)`                                              | the cursor moves to the element (eased, 350 to 800 ms by distance), the element is clicked, then the after-action pause  | a click       |
| `media.type(locator, text)`                                         | the cursor moves to the field, clicks it and types a character at a time at `typeMsPerChar`, then the after-action pause | a fill        |
| `media.pointAt(locator)`                                            | the cursor moves to the element                                                                                          | nothing       |
| `media.highlight(locator)`                                          | in a step the sidecar highlights: the cursor moves to the element and a box is drawn around it until the step ends       | nothing       |
| `media.terminal({ command, output, cwd?, exitCode?, durationMs? })` | keeps the command for the step's terminal scene; `output` is a string or chunks `{ afterMs, text }`                      | nothing       |

`media.recording` says which it is. `this.media` is always present, so `this.media?.pointAt(...)` and `this.media.pointAt(...)` both typecheck. Each step ends with a pause: a Then is held for `readMs` (with its highlight on screen), any other filmed step for `afterActionMs` unless its last action already paused. Hidden steps are never paced, and their clicks and typing are plain. A navigation is noted on its own. Steps that do not call the hooks still run and are filmed; they only lack the cursor and the boxes.

The cursor is drawn in the page (a screencast shows none) and every press leaves a ripple; the ripple and the highlight box take `recorder.highlightColor`. Anything else a workspace wants on screen while filming, such as stand-in text for run-specific values, it hands the base hooks as a script for every document of the filmed page, added before the page's first load:

```ts
installBaseHooks({
  recordInitScript: (sidecar) =>
    sidecar.standIns ? standInScript(rules[sidecar.standIns]) : undefined,
});
```

A step or hook can also call `this.recording?.addInitScript(script)` before the scenario opens its page.

### What a recording holds

Each recording goes in `<dir>/<id>/`:

- `video.webm`: the raw video, at the viewport times the device scale factor, from the scenario's first page to its end.
- `timeline.json`: below.
- `screens/<step>.png`: the frame at each step's end, at the video's pixels.
- `terminal/<step>.json` and `terminal/<step>.cast`: for a step that reported commands, its command (`command`, `cwd`, `exitCode`, `startMs`, `endMs`, `output` as chunks `{ atMs, text }`, any others in `more`) with the sidecar's `display` and `preface`, and the same scene as an asciicast v2 recording typed at the pace.
- `<id>.video.yml`: the sidecar as written, and `sidecar.json`: the sidecar resolved, every step reference a number and every default filled in.

```json
{
  "id": "add-a-note",
  "scenario": "Add a note",
  "feature": "features/notes/add-note.feature",
  "startedAt": "2026-10-22T01:51:03.570Z",
  "status": "passed",
  "video": "video.webm",
  "viewport": { "width": 800, "height": 600 },
  "scale": 1.5,
  "steps": [
    {
      "index": 1,
      "keyword": "Given",
      "text": "the list starts empty",
      "hidden": true,
      "highlight": false,
      "startMs": 11,
      "endMs": 28,
      "status": "passed",
      "actions": [],
      "screen": "screens/1.png",
      "terminal": null
    },
    {
      "index": 2,
      "keyword": "When",
      "text": "I type \"Weekly plan\" as the title",
      "hidden": false,
      "highlight": false,
      "startMs": 53,
      "endMs": 882,
      "status": "passed",
      "actions": [
        {
          "kind": "type",
          "atMs": 577,
          "box": { "x": 40, "y": 113, "width": 284, "height": 40 }
        }
      ],
      "screen": "screens/2.png",
      "terminal": null
    }
  ],
  "background": [
    {
      "index": 0,
      "keyword": "Given",
      "text": "the notes page is open",
      "hidden": true,
      "highlight": false,
      "startMs": -291,
      "endMs": 10,
      "status": "passed",
      "actions": [{ "kind": "goto", "atMs": 5 }],
      "screen": null,
      "terminal": null
    }
  ]
}
```

`steps` are the scenario's own steps, numbered as a sidecar numbers them; the Background's steps, which run first and are never filmed, are in `background`. A step that never ran (one after a failure) has `"status": "skipped"` and null times; a failed one has its error's first line. Boxes are in the viewport's CSS pixels; `scale` turns them into the video's. `video` is null when the scenario never opened a page.

### Timing

Every time is in milliseconds from the raw video's first frame. The recording asks the browser for its screencast frames beside the video it writes; both come from one screencast, and the first frame's timestamp, which the browser stamps with the wall clock when it draws the frame, is time zero. Everything else (step starts and ends, actions, commands) is read from Node's monotonic clock anchored to the wall clock (`performance.timeOrigin + performance.now()`), the same clock on the same machine, so times line up with frames to within a frame. Steps before the page opened (setup) come out negative. The video holds a frame until the page changes, so a pause is a held picture. A step's end is taken after its pause and before its screen is captured. The video runs on about a second past the last step, the encoder holding the last frame.

The device scale factor is the filming browser's own (a launch flag): a screencast captures CSS pixels, so a context's scale factor would only pad the video. A record run therefore films in a Chromium per scale factor, with scrollbars hidden, beside the run's usual one.

### flax.yml

The `recorder:` key of the `scenarios:` section holds the defaults every sidecar starts from: `pace` (`typeMsPerChar` 60, `afterActionMs` 600, `readMs` 1200), `viewport` (1440 by 900), `scale` (1, up to 4) and `highlightColor` (`#2f6fed`).

## Screenshots

A manual's screenshots go stale the same way its terminal examples do. A capture run takes them from the scenarios that check those screens, so a flow that stops working fails its check before a stale picture is published. `flax scenarios run --env <env> --capture <dir> [feature paths...]` runs the scenarios of the selection that carry the capture tag (`@capture` by default), and each screenshot their steps ask for is written to `<dir>`. The rest is an ordinary run: the same steps and assertions, the same results directory, the environment's tag policy. Cadence tags do not keep a scenario out of a capture run (a heavy scenario that reaches a screen can still supply it); `--cadence <name>` narrows the run to one cadence's scenarios. With `--dry-run` it lists the scenarios it would run and writes nothing. `--capture` and `--record` are separate runs.

### Asking for a screenshot

A step asks for a screenshot by name through `this.media`:

```ts
Then(
  "the list shows {string}",
  async function (this: ScenarioWorld, title: string) {
    const page = await this.page();
    await page.locator("#notes li").filter({ hasText: title }).waitFor();
    await this.media.capture("notes-page");
    await this.media.capture("notes-list", { target: page.locator("#notes") });
  },
);
```

Outside a capture run, or in a scenario its tags do not select for that name, `capture` does nothing, so the step runs the same everywhere. A name is letters, digits, dots, dashes and underscores; it is the file name.

| option        | does                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `target`      | a locator: the screenshot is that element at its own size; the viewport by default                 |
| `fullPage`    | the whole scrollable page                                                                          |
| `clip`        | a region `{ x, y, width, height }` in CSS pixels                                                   |
| `style`       | a stylesheet applied while the screenshot is taken, to hide something that changes from run to run |
| `mask`        | locators painted over with a box                                                                   |
| `keepPointer` | leaves the mouse where it is; by default it moves to the top left corner so no hover state shows   |
| `text`        | `false` leaves the entry's `text` null                                                             |

Before it shoots, the capture waits for the network to go quiet (up to 30 seconds) and the fonts to load, finishes animations and hides the text caret. Each scenario's page is opened with the capture settings (below), with reduced motion and, in a browser of its own, no scrollbars.

### Which scenario takes which

The capture tag on a scenario takes every screenshot its steps ask for. `@capture:<name>` takes only that name, and a scenario may carry several; use it when a step that asks for a screenshot is shared by more than one tagged scenario, so each name comes from one place. A run fails when a name is taken twice, when a scenario tagged `@capture:<name>` passes without taking it, and when a selected scenario fails or never runs.

### Stand-ins

Run-specific values (a generated account name, a test address, an id, today's date) would make every screenshot differ from the last. The steps of a capture run are still checks, though, and a check that reads a stand-in instead of the real value fails. So a capture run applies stand-ins only for the moment of each capture: the workspace hands the base hooks the source of a page function `(text) => string`, which is applied to every text node and field value of the page just before the screenshot and its text are taken, and undone right after.

```ts
installBaseHooks({
  captureRewrite: (scenario, world) =>
    `(text) => text.replace(/run-[0-9a-f]{8}@example\.com/g, "alex@example.com")`,
});
```

It is given the scenario (`name`, `uri`, `tags`) and its World; the function's source must use nothing from outside its own body. `captureInitScript` adds a script to every document of a captured scenario's page before its first load, for what must start with the page, such as noting the ids the page's own requests return so the rewrite can replace them; it runs while the steps check the page, so it must leave what they read alone. A step or hook can also call `this.capturing?.addRewrite(source)` and `this.capturing?.addInitScript(script)`; the latter also runs in the document already open.

### What a capture run writes

Into `<dir>`, for each capture, `<name>.png` at the viewport (or element, page or clip) times the scale factor, and then `manifest.json`. Each entry's `text` is what the capture shows: every visible line inside the captured area, a table row's cells joined by `|`, in sections by heading. `formatPageText` from `@flax/core/page-text` writes it as text, `## <heading>` lines with the lines under them indented.

```json
{
  "env": "local",
  "runId": "local-20260101T000000Z",
  "startedAt": "2026-01-01T00:00:00.000Z",
  "finishedAt": "2026-01-01T00:01:00.000Z",
  "status": "passed",
  "captures": [
    {
      "name": "notes-list",
      "file": "notes-list.png",
      "text": [{ "heading": "", "lines": ["Weekly plan"] }],
      "scenario": "Add a note",
      "feature": "features/notes/notes.feature",
      "line": 7,
      "status": "passed",
      "step": {
        "index": 3,
        "keyword": "Then",
        "text": "the list shows \"Weekly plan\""
      },
      "url": "http://127.0.0.1:4173/",
      "target": "element",
      "locator": "locator('#notes')",
      "viewport": { "width": 800, "height": 600 },
      "deviceScaleFactor": 1.5,
      "width": 627,
      "height": 41,
      "capturedAt": "2026-01-01T00:00:31.250Z"
    }
  ],
  "problems": []
}
```

`captures` holds one entry per name, in name order, each with its scenario's status; take only the passed ones. `status` is passed only when every selected scenario passed, took what its tags name and shared no name; `problems` says why it is not. The manifest lists this run's captures only: files an earlier run left in `<dir>` are not in it. A failed capture run also exits non-zero, like a failed check run.

### flax.yml

The `capture:` key of the `scenarios:` section: `tag` (default `@capture`), `viewport` (1440 by 900), `scale` (2, up to 4), `colorScheme` (`light` or `dark`, default `light`), `locale` (`en-US`) and `timezone` (an IANA zone; the machine's own when left out).

## Why this shape

A manual's terminal examples are usually screenshots or pasted text that nobody re-runs; they go wrong at the first release that changes a flag. Here the example is a scenario: it runs on every image build as a test, it is recorded at a release for the manual, and a reader of the manual can copy the exact commands from the description file. The Windows check closes the last gap, where the reader's platform differs from the recorder's.

## To confirm against the package

- `flax scenarios local` and `windows` are planned: the package publishes `run`, `coverage` and `dataset` today; the terminal driver and the recorder are in the package, the local world's product-specific half (the docker shim, the completion generator) stays workspace code.
- Browser recordings are in the package (`run --record`); a terminal step's scene comes from what the step reports through `media.terminal`, and a cast recorded by the local recorder is not attached to a browser recording.
