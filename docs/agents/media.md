# Media: narrated videos from record runs

The agents package carries a small media kit that a job's `media.ts` uses to make videos: text to speech with word timing (`src/media/tts.ts`), captions (`captions.ts`), the media manifest (`manifest.ts`), and a renderer that turns a scenario record run into a narrated video (`render.ts`). The kit is generic. Your look and sound (fonts, colors, cards, music, voices) and your stand-in rules live in your workspace and are passed in; flax ships none of them.

## What the renderer reads

A record run is one directory per recorded scenario, as the scenario recorder writes it:

```
open-a-note/
  video.webm              the raw recording (absent when the scenario never opened a page)
  timeline.json           every step with its times, status, flags and actions
  screens/<step>.png      the frame at each step's end
  terminal/<step>.json    the command a step ran (any others in more), with its output, times, display and preface
  terminal/<step>.cast    the same as an asciicast v2 recording
  open-a-note.video.yml   a copy of the sidecar
```

Times in `timeline.json` are milliseconds from the raw video's first frame. The raw video need not have a constant frame rate: a screencast with frames only where the picture changed is fine, as the renderer cuts from a constant-rate copy in which each frame lasts until the next. The timeline says whether the run passed (`status`), which steps are hidden and highlighted, and the recording's `scale`: video pixels per viewport CSS pixel. A step's actions are what the recorder did during it (`click`, `type`, `goto`, `point`, `highlight`), each with a time and, for the ones on an element, its box in viewport CSS pixels. The renderer places boxes (zoom, callouts) by the viewport, so a recording at any scale lines up. Background steps are listed with index 0 and are never filmed.

The sidecar beside a feature file says how a scenario becomes a video. It is `<feature>.video.yml`, or `<feature>.<id>.video.yml` when a feature has several recorded scenarios; the copy in the record directory is matched to the timeline by `scenario`. The fields the renderer reads:

```yaml
scenario: "Open a note from the list"
id: open-a-note
title: "Open a note"
voice: narrator                  # passed to your voice chooser
pace: { typeMsPerChar: 50 }      # terminal typing speed, and the pauses after a command and at the end
intro:                           # a card before the first filmed step
  chapter: Introduction
  heading: "Open a note"
  items: ["Find the note", { label: "Read it", icon: book }]
  text: "Here is how to find a note and read it."   # spoken over the card
narration:
  - at: "When I open the notes list"   # the step's text with its keyword as written, or its 1-based index
    text: "Open the notes list and pick the note you wrote this morning."
  - at: "And I sync my notes"
    text: "Sync your notes from the terminal first."
  - at: "Then I see the note's text"
    text: "The note opens with everything you wrote."
chapters:
  - { at: "When I open the notes list", title: "Find the note" }
highlight: then                  # then | none | a list of steps
hide: [1]                        # default: every Given
terminal:                        # one override, or a list of them
  at: "And I sync my notes"
  display: "notes sync"          # the command line shown in place of the one that ran
  preface: ["export NOTES_TOKEN=nt_0000"]   # typed before it; stand-ins apply
poster: { at: 3, title: "Open a note", kicker: "How-to" }
outro:
  chapter: "Next steps"
  heading: "docs.notes-co.example"
  sub: "Get started"
  text: "Every command is in the quick start."
publish:                         # carried into media.json's entry for the video
  youtube: { title: "Open a note", tags: [notes], playlist: Tutorials }
```

A step named by text matches its keyword as written in the feature (`And`, `But` included) and its text; when the keyword differs, a text that only one step has still matches. Text references survive inserted steps, so they are the better choice.

## What it makes

`renderRecording` writes four files into `out`:

- `video.mp4`: 2560 by 1440, H.264 and AAC, 30 frames a second. The recording is fitted into the picture above a caption band (160 pixels by default, `captionBand: 0` for none).
- `captions.vtt`: the narration's words, the intro's, the outro's and every card's included, grouped into readable cues; each piece of narration starts a new cue.
- `poster.png`: the poster step's screen (or its terminal scene's last frame) fitted into the frame; with a poster `title` or `kicker`, those over it; or what your `assets.poster` draws. A poster over the delivery's 2 MB thumbnail limit is redrawn at 1920 by 1080, and when that is still over, written as `poster.jpg` at the best JPEG quality that fits.
- `media.json`: the manifest listing the three files, with the video's entry in `data.scenarios.<id>` (the sidecar's `id`), the shape the YouTube output and its delivery read: `video`, `captions`, `poster`, `duration`, `chapters`, and `title`, `description`, `tags` and `playlist` from the sidecar's `publish.youtube`, else from `publish`, else the sidecar's `title` and `description`. The rest of `publish` is carried into the entry as is.

The entry's chapters follow YouTube's rules: whole seconds, the first at 0, a chapter starting less than 10 seconds after the one before it folded into that one (the last too when it starts less than 10 seconds before the end), and none at all when fewer than three remain. `chapters: { minSeconds }` changes the 10; the kit's YouTube check refuses chapters shorter than 10 seconds. The result's `media.chapters` keeps every chapter at its exact time, the intro's and outro's included.

The result also carries the entry, the edit plan and, for each terminal scene, the plain text it shows. A job that makes several videos renders each into its own folder with `manifest: false` and writes one media.json whose `data.scenarios` holds each result's `entry`, its paths prefixed with the folder.

```ts
import { renderRecording } from "@flax/agents/media/render";
import { elevenLabsVoice } from "@flax/agents/media/tts";

await renderRecording({
  recordDir: "runs/2026-01-14/open-a-note",
  tts: (voice) =>
    elevenLabsVoice(voice ?? "narrator", undefined, undefined, {
      pronunciations: { SQL: "sequel" },
    }),
  out: process.env.FLAX_AGENTS_MEDIA_DIR!,
  standIns: rulesByName[sidecar.standIns ?? "default"],
  assets: {
    css: brandCss, // @font-face rules and --media-* colors
    background: "0x101828",
    cardHtml: (card, kind) => brandCard(card, kind),
    music: { file: "brand/music/bed.mp3" },
  },
  production: { zoom: true, callouts: [{ at: 3, text: "Your note" }] },
});
```

`elevenLabsVoice` speaks each written token as `pronunciations` says, while the captions keep the written words. Without the option it reads `src/media/brand/pronunciations.json` in the workspace when the file is there, and pronounces everything as written when it is not.

A recording of a failed run is refused: when the timeline is marked failed or any step did not pass, nothing is rendered, so a video never shows a flow that the checks did not prove.

## How the edit works

The edit is pure arithmetic (`src/media/edit.ts`, `planEdit`), done before any encoding:

1. Hidden steps are cut: Background steps, then what the recorder marked, else the sidecar's `hide` list, else every Given. Steps that ran back to back stay one stretch of the raw video; a cut falls only where a hidden step or a terminal scene was.
2. A visible step that ran commands is a terminal scene (below) in place of its browser frames, as long as its replay.
3. The visible steps fall into scenes. A scene starts at each step a narration block names (a block on a hidden step moves to the next visible one) and runs to the next one.
4. Each block starts at its scene's start (plus `leadIn`, default 0). When the block and its `tail` (default 0.5 seconds) are longer than the scene, the scene's last frame holds until they are done. A scene longer than its narration plays at its own pace; `maxSpeed` (default 1) lets its browser frames play faster to fit, and `maxTail` cuts the scene's picture that many seconds after the block's last word (steps cut whole keep their place at the cut, so chapters on them still land).
5. Long waits are sped up: when the part of a step that no narration is spoken over (the step's time after its scene's block and tail are done, or the whole step in a scene without one) lasts more than `idle.after` seconds (default 10), that part plays in `idle.seconds` (default 4), as fast as it takes, with a badge such as `×40` at the picture's top right while it lasts. Terminal scenes are sped up the same way. Narration is never sped up; `idle: false` plays every step at its own pace, and `idle.badge: false` leaves the badge out.
6. Cards inside the video (below) go before their step's scene or in place of its picture; a step with a card starts a scene, as a narrated step does. The recap goes after the last scene.
7. The intro and outro cards go before and after: each at least its `seconds` (default 3), longer when its narration needs it.

`trim` cuts seconds from the start or end of a step's raw video, the step named by index or text as in the sidecar: `trim: [{ at: "When I open the notes list", start: 1.5 }]`. It is a render option, so the sidecar stays as it is; a trim on a terminal scene is refused.

Every length is a whole number of frames, so the narration, the captions, the chapters and the picture agree to the frame. Two blocks on one step, a block with no visible step at or after it, and a scenario with every step hidden are refused.

Chapters start at their step's place in the output, or at the first card placed before that step; the intro's chapter starts at 0, the outro's at its card, and a card's or the recap's `chapter` at that card. Without a `poster` step, the poster is the last highlighted visible step, else the last visible step.

## Terminal scenes

A visible step with commands is drawn as a terminal by xterm in Chromium, frame by frame, so the scene is the same on every render:

- From `terminal/<step>.json`: each command typed after a `$` prompt at the sidecar's `pace.typeMsPerChar` (default 60 ms), a pause (`afterActionMs`, default 600 ms), the command's recorded run time (at most 2 seconds), its output scrolled out, and the last prompt held for reading (`readMs`, default 1200 ms).
- The sidecar's `terminal` override for the step: `display` shows another command line (a list replaces the step's commands in order), `preface` types lines before them, and `cast` replays an asciicast v2 file instead (relative to the record directory, absolute, `recording:<edition>/<id>` from `FLAX_RECORDINGS_ROOT`, or `docs:<path>` from the docs checkout the `docsRoot` option names, `FLAX_DOCS_ROOT` by default).
- Without a transcript, `terminal/<step>.cast` is replayed, idle gaps capped at 2 seconds, at the grid it was recorded at.

Stand-ins (`standIns`) apply to every command, output and preface line shown, so an export line can show a placeholder in place of a real secret. `terminal` in the render options overrides the pace and the font size (18 layout pixels, 36 in the frame). The terminal's look reads `--media-terminal-backdrop`, `--media-terminal-bg`, `--media-terminal-bar`, `--media-terminal-text`, `--media-terminal-cursor` and `--media-mono-font` (see `TERMINAL_DEFAULTS` in `src/media/terminal.ts`).

## Cards, the recap and transitions

Three render options shape a video beyond the intro and outro; the sidecar stays as it is.

`cards` puts cards inside the video. Each is an `image` or a whole `html` document, like `assets.titleCard`, with `at` naming a step (by index or text, as in the sidecar):

- By default the card goes before the step's scene (a hidden step's card goes before the next visible step). With `replace: true` it is shown in place of the step's picture, its browser frames or its terminal scene, and the step's narration block is spoken over it.
- `narration` is spoken over the card and captioned like a block; the card lasts at least `seconds` (default 3) and holds until its narration and the tail are done. A card that replaces a step holds until that step's block is done too. A card with narration cannot replace a step where a sidecar block starts.
- `chapter` starts a chapter at the card. A sidecar chapter on a step with a card before it starts at the card.
- `at: "start"` puts the card before the title card, for an opening sting.
- `animate: { seconds }` draws the html once per frame for that long, and the last frame holds after. At each frame the page's CSS animations and transitions are paused at the frame's time, and `window.mediaFrame(seconds, frame)` is called (and awaited) when the page defines it, so a script can draw the frame itself. `assets.titleCard` and `assets.endCard` take `animate` too.

`recap` is a closing card before the outro: a `heading` and `lines`, each line appearing as its narration starts. A line's narration is its `text` unless `narration` gives other words; `""` leaves it unspoken. Lines are spoken one after another, `gap` seconds apart (default 0.5); the card lasts at least `seconds` (default 3) and until the last line and the tail are done. `assets.recapHtml(recap, shown)` draws it with the first `shown` lines visible; the default `recapHtml` keeps the hidden lines' places so nothing moves as lines appear.

`transition` is how the picture changes where it jumps: into and out of every card, between scenes, at a cut where a hidden step was and around a terminal scene. `cut` (the default) changes at once; `fade` dissolves the next stretch in over the previous one's last frame for `seconds` (default 0.5). A fade moves nothing in time, so the narration, the captions and the chapters stay where they were. A stretch that carries on from the one before it in the raw video never fades.

```ts
import { cardHtml } from "@flax/agents/media/paint";

await renderRecording({
  recordDir: "runs/2026-01-14/open-a-note",
  tts: narrator,
  out: process.env.FLAX_AGENTS_MEDIA_DIR!,
  cards: [
    { at: "start", html: stingHtml, animate: { seconds: 2 }, seconds: 2.5 },
    {
      at: "And I sync my notes",
      html: cardHtml(
        { heading: "Sync from the terminal", items: ["Sign in", "Sync"] },
        { width: 2560, height: 1440 },
        brandCss,
      ),
      narration: "Next, sync your notes from the terminal.",
      chapter: "Sync",
    },
  ],
  recap: {
    heading: "What you did",
    lines: [
      { text: "Opened the notes list" },
      { text: "Synced your notes", narration: "You synced your notes from the terminal." },
      { text: "Read the note", narration: "And you read the note you wrote this morning." },
    ],
    chapter: "Recap",
  },
  transition: { kind: "fade", seconds: 0.5 },
});
```

## Production options

Each is off unless asked for, and each takes its look from `assets`:

- Cards: the sidecar's `intro` and `outro` are drawn by `assets.cardHtml` when given, else by the plain `cardHtml` (heading, sub line, numbered items). `assets.titleCard` and `assets.endCard` can give an `image` or a whole `html` document instead, a minimum `seconds`, and `narration` for a card the sidecar does not describe.
- `assets.music`: a music bed, looped to length, at -16 dB between phrases and ducked to -26 dB under the voice (`levels` changes both and the fades). The mix never peaks above 0.97.
- `production.zoom`: the camera eases in to each box the recorder highlighted on a highlighted step, holds to the step's end, and eases back out (`maxZoom` default 2, `move` default 0.8 seconds).
- `production.callouts`: a label pointing at a box during a step, the rest of the picture dimmed. The box is the one given (in viewport CSS pixels), else the step's last highlighted, pointed or clicked box.
- `burnCaptions`: the cues drawn into the caption band as well as written to `captions.vtt`.

Pictures drawn with Chromium (cards, the poster, callouts, burned captions, terminals, the speed badge) read `assets.css`: font faces and the custom properties `--media-font`, `--media-text`, `--media-band`, `--media-accent`, `--media-accent-text` and `--media-dim` (see `PAINT_DEFAULTS` in `src/media/paint.ts` for the neutral defaults).

## Stand-ins

A test run shows run-specific values: a generated account, a test address, an id. Stand-ins replace them with presentable text before anything is captured. A rule set is a list of literal `text` or regular expression `pattern` rules with what each match becomes, applied in order:

```ts
import { applyStandIns, standInText } from "@flax/agents/media/stand-ins";

const rules = {
  name: "default",
  rules: [
    { pattern: "run-[0-9a-f]{8}@test\\.notes-co\\.example", with: "sam@notes-co.example" },
    { text: "Test Workspace", with: "Field Notes" },
  ],
};
await applyStandIns(browserContext, rules); // every page, before it paints
const transcript = standInText(rawOutput, rules); // terminal output, captions
```

`standInScript(rules)` is the page script itself, for a recorder that injects scripts its own way: it rewrites every text node and input value (never the focused input or a password) before the page paints and whenever the page changes, never touches attributes or the URL, and never applies a rule twice to the same text. `standInValue` applies the rules to every string in a JSON value, such as a terminal transcript. Rules are checked when compiled: a pattern that does not parse or matches empty text is refused.

## Testing your own media code

`@flax/agents/test/fake-recording` writes a record directory of solid-color steps with ffmpeg (with terminal transcripts for steps given commands), and `@flax/agents/test/fake-voice` is a voice that says each word as a sine tone with word timing, so a workspace can test its rendering without a browser run or a speech API.
