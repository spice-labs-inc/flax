# Delivery

How the kit delivers a job's answer: a pull request (with revisions) or
a Slack message. YouTube delivery is in [media.md](media.md#youtube-delivery).

## Pull request delivery

A job with `output.kind: pr` answers with a patch set
(`schema/patch-set.schema.json`): per page, no change or a unified diff with
the evidence for every changed line. After the answer passes its schema
(the first answer, or the one the
[repair turn](runtime.md#repair-turn) corrected) and its quotes, the
job's `publish.ts`, when it has one, turns the answer into the patch set,
or into nothing, and then the run delivers nothing and passes (see
[adding-a-job.md](adding-a-job.md)); with `output.notify` it may post a
short analysis instead (see [Analysis of a run that publishes
nothing](#analysis-of-a-run-that-publishes-nothing)). A run whose
`collect.ts` printed `nothing_to_do` never gets this far: it calls no
model and passes. Then `flax agents run-job`
(`src/run-job/pr-output.ts`), after reading the pages a patch names
that the input did not give, for a job with `output.pages_on_demand`
(with the reader app, at the commit of the input's other pages of that
repository or the head of its default branch; kept in
`pages-on-demand.json` and checked like given pages):

1. runs the PR checker against the pages and sources in the run's input
   (`pr-check.json`); a page with a problem is left out and the rest goes
   on, named in the pull request and under `delivery.dropped` in
   `status.json`; a problem with the answer as a whole, a page problem in
   a revision, or no page with a patch left fails the run;
2. plans the change: per repository, the pages with their patch applied,
   all read at one commit, on the branch `agent/<job>/<YYYY-MM-DD>` (or
   `agent/<job>/<key>` for a job with `output.branch_key`), with
   the input's `stamps` set (frontmatter values `collect.ts` computed for
   keys in the output's `stamp_keys`: on a page the answer lists, or on a
   page the model was not given at all);
3. **untrusted-input gate:** every tool result carries its tool's
   `source` tag from `tool.yml`, and the report records whether the model
   saw untrusted text (a result of an untrusted tool, for the model or for
   `collect.ts`, since that can reach the model through the input). With
   `untrusted_input: report_only` in the job's `output`, such a run keeps
   the plan in the report and opens nothing; `open_pr` opens it anyway and
   says so in the pull request;
4. **citation check:** before any model judges the plan, code reads every
   file a change cites by path at the cited commit (with the reader app)
   and leaves out each page that cites a file not there at that commit or
   a line past the file's end, with that reason (`by: citation-check` in
   `status.json`'s left-out pages). It also leaves out a page with a
   claim about code that only cited documentation shows: a sentence or
   `;` clause of an added line that quotes code (a backtick identifier
   other than a file path, or a literal of a quoted command line, as
   below) found in a cited documentation file (a README, CHANGELOG, a
   `.md`, `.mdx`, `.rst`, `.adoc` or `.txt` file, or anything under
   `docs/`, `doc/`, `adr/`, `adrs/` or `plans/`) and in none of the cited code
   files. Code is the evidence for what code does: a README can be wrong
   about which part does the work. The rule is conservative: it judges a
   change only when every code file it cites was read whole and it cites
   no commit without a path (whose diff could show the claim), and it
   skips a clause the page's removed lines already make and a clause about
   what a document says (one naming a documentation file followed by
   "says", "states", "still", "lists" or the like). Prose with no quoted
   code is left to the second check. A plan with no page left goes no
   further. Then, for a job whose output sets `attribution_check: true`,
   the **attribution check** (`src/run-job/attribution.ts`): code reads
   from GitHub, with the reader app and through the same requests as the
   second check's credited commits (each read once per run), every
   commit and pull request a changed line credits: `#N`, `PR #N`,
   `repo#N`, `name #N` (a hyphenated repository name), `merge <sha>`, a
   bare 7 to 40 character sha with a digit, and each number of a range
   such as `#17-#20`. A `## recent`-style line (one starting with a date)
   is one claim; any other line is a claim per sentence or `;` clause. A
   claim the page's removed lines already make word for word is not new
   and is skipped, and so are commit ranges (`a..b`) and a commit named
   as a state (`at <sha>`, `to <sha>`, `repo@<sha>`). A page is left out
   (`by: attribution-check`) when a claim:
   - credits a pull request that is not merged, or merged into a branch
     other than the repository's default branch, or a commit no merged
     pull request brought to the default branch and not pushed there
     (`compare` shows it behind or identical), or a number or sha (with
     a letter) GitHub does not have;
   - gives `merge <sha>` for a pull request whose merge commit is another;
   - carries a date that is not the day the credit landed (the pull
     request's merge, or a direct commit's own date) in
     America/Los_Angeles: the line's or clause's leading date (a list
     such as `2026-09-15/2026-10-07` or a range such as `2026-07-20..2026-07-21`
     allows each day it names) for every credit in the claim, and a
     date with at most three words between it and a credit for that
     credit;
   - quotes in backticks a code identifier (one token with a letter, no
     spaces, placeholders, globs or shas) that is on no added or removed
     line, and is no changed file's path or name, in the diff of any
     credit in the claim (a merge commit's diff against its first
     parent: the whole pull request). Unchanged lines never count. A
     one-word lowercase identifier (`image`) counts only where the diff
     line uses it as code: right after `.`, `$`, `-`, `/`, `@`, `:`, a
     quote or an opening bracket, or right before `.`, `(`, `[`, a quote,
     `:` or `=`; never as a prose word or inside Markdown backticks. When
     the claim says nothing was added, introduced, created, removed,
     deleted, dropped or renamed, an identifier also counts as a YAML or
     JSON key (`image:`, `"image":`) with an added or removed line inside
     its block, as when a pull request changes what an existing input
     does. A file or folder path (`README_llm.md`, `.github/workflows/`)
     is never checked: it says where something is, and only shas and pull
     request numbers credit. A `group:artifact` coordinate counts when
     each part does. When the identifier is not found and GitHub cut a
     credited diff short (a file listed with changes but no diff, or the
     300-file limit), the reason says the credit is unverifiable, and the
     page is left out all the same;
   - quotes in backticks a command line or argument form (text with a
     space or a `<placeholder>`, such as `[subject] docker://<image>`)
     none of whose literal tokens is on an added or removed line, or is a
     changed file's path or name, in the diff of any credit in the claim,
     under the same rules as an identifier. Its literal tokens are what
     only code could have written: a URL scheme or URL (`docker://`), a
     flag (`--subject`, `--log-level` of `--log-level=...`), a path
     (`~/.local/bin/notes`) and a name with a dot, underscore, colon,
     slash, `$`, `=`, `@` or an inner capital (`NOTES_PASS`,
     `inputs.image`). Placeholders, brackets, quotes, plain and
     hyphenated words and file paths are not; a form with none
     (`<subject> <input>`, `notes survey inventory`) is not checked;
   - names a credit GitHub could not be read for.

   The reasons quote the claim and name the credit and the identifier,
   argument form or date. A plan with no page left goes no further. A job that does not
   opt in, and a run without the reader app (a stub run), skips it;

5. **second check:** a second model call through the same runner path, in a
   fresh box and data directory, with no tools and no shell, sees only the
   proposed patches, the evidence each change cites (resolved against the
   run's sources, plus the content of every file a change cites by path,
   read with the reader app at the cited commit: whole when it fits, else
   the lines around what the change names, within per-file caps and a
   budget per page, and every commit and pull request the changed lines
   credit, by sha or number or as a commit cited with no path: its subject,
   its own date, the pull request that landed it and when that merged, and
   its diff against its first parent, within per-commit caps; a page that
   credits many gets fewer diff lines per file, never fewer credits)
   and the rules (the job's paths and limits, fixed kit
   rules, the job's `prompt.md`), never the pages or anything else of the
   run's input. Each source appears once in the input, however many changes
   cite it. An input over 600 KB with several pages gets one review per page,
   so no page loses evidence to another. A page still over 600 KB that
   credits several commits is reviewed in parts by its credits: each part
   gets the whole page change, its cited files and sources (shortened
   first when they would take more than half the room) and its share of
   the credited commits, none cut, and lists the credits checked in the
   page's other parts (`part.credits.elsewhere`); the page goes on only
   when every part approves. `review/split.json` names each review's
   pages, credit part and input file (`review/input.json` for the first,
   `review/<n>/input.json` for the others, with that call's answer and
   transcript). A page with one credited commit or none is cut down in
   steps, each noted in its `trimmed` list: cited file content first (largest files
   shortened to the lines around what the changes name), credited commits'
   diffs cut to 20 lines per file, cited files left out, source excerpts
   (shortened, then dropped), and last the credited commits' diffs (their
   subjects, dates and file lists stay); a page too big even then is left
   out as unproven. A line that credits a change to a commit or pull
   request is rejected when that commit's diff does not show the change,
   and a date on it is judged by when the change landed (the pull
   request's merge), never by a commit's own date. A job with
   `output.code_fix` gets a prompt and kit rules of its own
   (`codeFixRules` in `src/run-job/review.ts`): only what fixes, guards,
   tests or adds diagnostics for the failure, each line supported by the
   code it changes at the cited commit or the failure's quoted log lines,
   no change to behavior for inputs that did not fail, tests on synthetic
   input only, no suspicion stated as fact; its input also carries the
   pull request body sections `publish.ts` wrote (`body`), and a body that
   states a cause as proven that the evidence does not prove rejects the
   whole proposal. It answers approve or reject with reasons
   (`review/verdict.json`), each reason naming the page and the change
   (its number on the page in the review input) it is about when it is
   about one. A rejection whose every reason names a
   proposed page leaves those pages out and the rest goes on; any other
   rejection keeps the plan as a report; no verdict fails the run. A job
   with `drop_refused_changes: true` (and a `publish.ts`) gets one more
   try: when the first rejection's every reason names a change, the kit
   runs `publish.ts` again with those changes as `refused`, and it prints
   the answer without them (or nothing). That answer goes through the PR
   checker, the citation and attribution checks and the second check once
   more (`recheck/publish.json`, `recheck/pr-check.json`,
   `recheck/verdict.json`; the call itself under `review/<n>/`), and
   is delivered when that approves. The retry runs only while the run's key
   has at least as much left as the run has spent so far; a second
   rejection, a reason that names no change, or `publish.ts` printing
   nothing keeps the run as a report, as without the key. `status.json`
   lists the changes left out (`droppedChanges`), and the pull request
   body and check run name each with the second check's reasons. A plan whose only changes are stamps has no
   second check, since the model changed nothing. It runs on the run's own
   model, or on the output's `review_model` (`model` and `thinking`; a
   model of another family than every model the job may write with, so
   one model's blind spot is not checked by itself), and uses the run's
   forwarder socket and gateway key (issued for both models), so it
   counts against the same per-run budget, reserved at the dearer of the
   two models' prices, and has 10
   minutes (the key lives 10 minutes longer and the workflow timeout grows
   by 10 for a pull request job);
6. in shadow mode, or a stub run, stops there: `delivery/plan.json` and
   `delivery/<owner>-<repo>.md` hold what it would open;
7. live, it makes an installation token of the `agents-writer` GitHub
   App for those repositories only (contents and pull requests write,
   metadata read; a token granted more is revoked and refused), checks each
   page on GitHub at the base commit is exactly the page the run checked,
   commits the patched pages with a fixed author to the day's branch, opens
   one pull request (a draft for a job with `output.draft`; or, on a
   second run the same day, updates the one
   open on that branch), then closes the job's earlier open pull requests
   in that repository with a comment naming the new one and deletes their
   branches. A job with `output.branch_key` writes `agent/<job>/<key>`,
   updates the open pull request of that key, and closes, updates or
   deletes nothing of its other keys. A file a patch creates
   (`output.new_files`) must still be absent at the base, and is
   committed with mode 100644. The token is revoked when delivery ends;
8. with `output.notify` (a channel from the `post` list of
   `channels.yml`), it posts one notice there naming each pull request it
   opened, never one it only updated: "<job> opened <repo>#<n> for review"
   with the link, or "opened and merged" for one `auto_merge` merged.
   The notice keeps the [Slack message rules](#slack-delivery) and is kept
   in `delivery/pr-notice.json`; a post that fails is a problem in the
   report and never fails the run or undoes the pull request. A shadow run
   posts the notice it would post to the shadow channel, under the shadow
   line, or nothing when the shadow channel has no id.

Since delivery closes a job's earlier open pull request, a job whose pull
requests can wait longer for review than its schedule allows waits
instead: internal-docs-watch's, public-docs-watch's and atlas-doc-refresh's
`collect.ts` give no pages while the job's own pull request is open (see
[docs/internal-docs-watch.md](internal-docs-watch.md#the-waiting-rule)).

A job with `output.branch_key` keeps one pull request per key, so the
waiting rule is per key too: its `collect.ts` calls `openAgentPull`
with the key, and only that key's open pull request holds a run back.

The writer (`src/deliver/`) has no call that merges, approves or writes any
branch but `agent/<job>/<YYYY-MM-DD>` and `agent/<job>/<key>` (a key
being two to eight groups of lowercase letters and digits joined by
hyphens, never a date).
The pull request body is short and written by the kit: one line on what
the pull request does; **What changed and why**, one bullet per page
linking the file on the branch, the model's reason and its sources (a
cited commit as `repo#123` when its title names its pull request, else
`repo@sha`); left-out pages with their first problem; **Preview**, when
`repos.yml` gives the repository a `preview` (the commands to run in a
checkout of the branch and each changed page's local address);
the sections the job's `publish.ts` wrote, in order, each a bold title
over paragraphs, items and links, every piece of text escaped like model
text and every link's URL on the `links` list of `channels.yml` (a
link off it fails the run); **Reviewing**; and a collapsed **Run
details** block with the run, model,
base, untrusted input, checks and the second check's reasons. Text a
model wrote (reasons, replies, the second check's reasons, left-out
problems) is plain wrapped prose, never a code block, escaped by one
helper (`plainText` in `src/deliver/pr-text.ts`): HTML, markdown links
and images, layout markers, @mentions and #123 references do not render,
and only links to the organization's own places stay links. The patched
pages may gain no images or URL-loading HTML, and links only to hosts in
`link-hosts.yml` or ones the page already links to (see
[docs/guardrails.md](guardrails.md#added-lines-carry-no-images-and-link-only-to-allowlisted-hosts)). `status.json`
and `summary.md` record the untrusted input and the delivery outcome
(`nothing`, `report_only`, `shadow` or `delivered`).

A job can set `output.auto_merge.paths`: a live run then squash-merges its
own pull request right after opening it and writing its check run, and
deletes the branch, when every changed path matches one of those globs
(generated data only, such as the architecture explorer's `viz/data/**`
and `viz/cache/**`). A change outside them leaves the pull request open
for review, and its body says which paths kept it open; a merge GitHub
refuses (a conflict, a protected branch) leaves it open with a comment
saying why. Shadow runs never merge. The summary says "merged
automatically" or "left open" with the reason. `flax agents check` refuses a
glob that does not start with a folder inside the job's output paths,
covers `.github/`, `dist/`, `jobs/`, `schema/`, `scripts/`, `src/`,
`test/`, `tests/` or `tools/`, or names a prompt.

### Analysis of a run that publishes nothing

A pull request job's `publish.ts` that publishes nothing may give a
`message`: a short analysis as `render.ts` prints one, or `"render"`
for the message the job's `render.ts` made of the answer
(`src/run-job/analysis-output.ts`). The kit adds the footer, scrubs
every string as tool results are scrubbed (the run's secrets,
secret-shaped text, signed URL queries, UUIDs to `:id`), turns links off
the `links` list of `channels.yml` into text and breaks mentions as for
a [Slack message](#slack-delivery), and keeps the body in
`delivery/analysis.json`. A live run posts it to `output.notify`, a
shadow run to the shadow channel under the shadow line, and a stub run
nothing. Without `notify`, or when the model saw untrusted text and the
job has `untrusted_input: report_only`, it stays in the report. A
message over Slack's limits or a post that fails fails the run, since
the analysis is all it delivers. `status.json` records it under
`analysis`. When `publish.ts` also gives `sections`, the full
analysis, the kit writes them as Markdown to `analysis.md` in the
report and adds them to the run's summary page.

Not built yet: closing unmerged agent pull requests after 14 days, dropping
a job back to shadow when more than half of its last 10 pull requests closed
unmerged, and the kill switch.

### Revisions

A person can ask the Notes Agent to change its own pull request. On a pull
request a live job opened (branch `agent/<job>/<day>`), either:

- submit a review with **Request changes** (its text and its line
  comments, including suggested changes, are the request), or
- write a comment, or a line comment, whose first line starts with
  `/agent`, followed by what to change.

Only people GitHub marks as an owner, member or collaborator of the
repository count; anyone else's comments are ignored. A request older than
the latest approval is left alone.

The Revision poller workflow (`revise-poll.yml`, generated only while a
live job has `output.kind: pr`) runs every 10 minutes on the agents pool.
It reads the open agent pull requests with the reader app, and for each
job starts at most one revision run per poll, oldest request first, by
starting the job's workflow with the `revise` input set to
`owner/name#number`. Nothing starts while a run of the job is waiting, and
a pull request whose last revision run failed is left alone until someone
asks again. Expect an answer 10 to 20 minutes after asking, plus the run.
The pull request's `Notes Agent / <job>` check shows where the round is:
queued once the poller starts the run, in progress with a link to it, then
completed with how it ended.
Revision runs are named `job-<name> revise owner/name#number`.

A revision run (`flax agents run-job <name> --revise owner/name#number`,
`src/revise/`):

1. reads the pull request with the writer app's token and decides: nothing
   to do (closed, not this job's, no request waiting), the round limit (5
   rounds; one comment says a person needs to take it from here), or a
   round;
2. reads the input of the run that opened the pull request (named in its
   body) from that run's report artifact with the reader app; past the 90
   day artifact retention a pull request cannot be revised;
3. gives the model that input with the pages as they are at the pull
   request's head, the requests as review sources it may cite
   (`review/<request id>`), no stamps, and a revision section after the
   job's prompt; the answer adds `revision_replies`, one per request;
4. checks the answer like any run: schema, quotes, the PR checker against
   the head pages, the untrusted-input gate (requests from trusted
   reviewers are not untrusted input; tools the model calls still count),
   the second check;
5. commits the patches onto the pull request's branch with its head as
   parent, forward only: if anyone pushed to the branch meanwhile, nothing
   is written. No pull request is opened, updated or closed;
6. answers each line comment with a reply in its own review thread, then
   posts one short summary comment, written by the kit: one line on what
   happened ("Revision 1 of 5 ...: pushed abc1234, changed 1 page; replied
   in each thread."), the answers to requests without a thread (a review's
   text, an `/agent` comment, or a line comment whose thread reply GitHub
   refused, which is recorded and never fails the round), and a hidden
   marker naming the round and every request it answered. The poller
   reads answered requests from that marker only. Replies are escaped
   plain prose like the body. A round that fails, or that a check
   refuses, still answers its requests with the reason, so it is never
   repeated by itself; ask again with `/agent` and more detail.

A job with a `publish.ts` is revised the same way: its writer answers in
the job's own schema, `publish.ts` turns the answer into the patch against
the head pages, and its body sections are not rewritten (the pull request
is not updated). release-notes is one: its writer answers the whole digest
again, video details included, and publish.ts rewrites the digest's
section (docs/release-notes.md, Revisions). A revision never drops the
changes a second check refuses (`drop_refused_changes` is for the first
run only): a refusal rejects the round.

`status.json` and `summary.md` record the pull request, the round, the
requests and the reply; `revision/` in the report holds the thread as
read, the replies and the comment.

### Replays and another second check model

To compare models on the same work, a pull request job's workflow takes
three more inputs when started by hand:

- `replay_run`: an earlier run id of the job. The run reads that run's
  input from its report artifact with the reader app (within the 90 day
  artifact retention) instead of collecting, always runs in shadow, and
  records `replayOf` and an input source of `replay`. It does not go
  with `revise`.
- `review_model` and `review_thinking`: the second check's model and
  level for this run, overriding the output's `review_model`; the same
  family rule applies to the run's own model. `auto` keeps the job's
  setting.

With `model` and `thinking`, that reruns one past input with any writer
and checker pair, and the report's summary names both
(`flax agents run-job <name> --replay <run id> --review-model <id>` locally).

## Slack delivery

A job with `output.kind: slack` names a channel from the `post` list of
`channels.yml`. Its message is what `render.ts` prints, with the footer
linking the run; a slack job without `render.ts` gets a plain one-line
message instead, like the release notifications: `*<job>*: <line>`, the
line taken from the answer's `headline`, `summary`, `title`, `text` or
`message`. After the answer passes its schema and its quotes,
`flax agents run-job` (`src/run-job/slack-output.ts`):

1. holds the message to the kit's rules, changing only what breaks them, so
   a message that keeps them looks exactly as rendered: a link whose URL
   does not start with a prefix in the `links` list of `channels.yml`
   becomes its label, every mention or special token (`<!here>`,
   `<!channel>`, `<!everyone>`, `<@user>`, `<#channel>`, groups) is
   shown as text, and bare `@here`, `@channel` and `@everyone` are
   broken with a word joiner. Every `mrkdwn` text gets `verbatim: true`,
   so Slack makes no link of its own from a bare URL, domain or name
   (write links as `<url|label>`), and the fallback text loses bare URLs
   off the list. Every change is listed in `status.json`. The message
   is a run's only way out, so it may link only to our own hosts, never
   carries an image and is never unfurled (guardrails: "A posted message
   cannot carry data out");
2. checks it fits one post: at most 50 blocks within Slack's text limits, a
   fallback text of at most 3,000 characters, at most 40,000 bytes of JSON.
   A message that does not fails the run and posts nothing. `render.ts`
   may print at most 48 blocks and 2,900 characters of fallback text, so
   the footer and a shadow run's line always fit;
3. **untrusted-input gate:** with `untrusted_input: report_only` in the
   job's `output`, a run whose model saw untrusted text posts nothing.
   The default is `post`: a health report reads log lines and alert
   messages on every run, so `report_only` would stop every post, and what
   a misled run can put in a message is already bounded by `render.ts`'s
   layout and the rules in step 1;
4. a stub run stops there, and so does a shadow run when the shadow
   channel has no id: `delivery/slack.json` holds the exact
   `chat.postMessage` body it would send. Otherwise a shadow run posts
   to the shadow channel (`shadow` in `channels.yml`, #agents-shadow)
   in place of the job's own: the same message under one context line,
   "Shadow run of <job>, not a live post. Live, it posts to #<channel>.",
   with the same words leading the fallback text, so it can be read next
   to the post it would replace and is never taken for a live one;
5. it checks the posting token (`SLACK_AGENTS_POST_TOKEN`) with
   `auth.test`, refusing it unless Slack reports a bot token with exactly
   `chat:write`, then posts once (live, to the job's channel; in shadow,
   to the shadow channel), by the channel's id from `channels.yml`,
   as the app's own bot (no username or icon), with name linking and
   unfurling off. A rate-limited post is retried after Slack's
   `Retry-After` (3 tries at most); no other failure is retried, since the
   message may have been posted. `status.json` and `summary.md` record
   the message's `ts` and permalink.

A channel in the `post` list needs its `id` before a live job may post
there (`flax agents check` refuses a live job naming a channel without one), and
the posting app must be invited to it. The shadow channel is not in the
`post` list and no job names it; without its `id`, `flax agents check` warns
that shadow posting is off and shadow runs post nothing. A run with
`--preflight` never posts. Going live changes only where the message
goes: `mode: live` posts to the job's own channel and nowhere else. The
posting token reaches every run of a slack job, shadow or live, in the
runner process alone, never lbx, the box, `collect.ts` or `render.ts`,
and is scrubbed from every report file.
