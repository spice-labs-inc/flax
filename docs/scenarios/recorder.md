# The recorder

Scenarios tagged `@local` run a command-line product on this machine, in a real shell, with no services, and the same scenario can be recorded as a terminal cast a manual embeds. The test and the recording are one file, so they cannot drift apart. This page describes how local scenarios run, what a recording contains, and how the recordings are checked on another operating system.

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

## Why this shape

A manual's terminal examples are usually screenshots or pasted text that nobody re-runs; they go wrong at the first release that changes a flag. Here the example is a scenario: it runs on every image build as a test, it is recorded at a release for the manual, and a reader of the manual can copy the exact commands from the description file. The Windows check closes the last gap, where the reader's platform differs from the recorder's.

## To confirm against the package

- `flax scenarios local` and `windows` are planned: the package publishes `run`, `coverage` and `dataset` today; the terminal driver and the recorder are in the package, the local world's product-specific half (the docker shim, the completion generator) stays workspace code.
