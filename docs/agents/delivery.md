# Delivery

Delivery is how a job's accepted answer leaves the run: as a pull request on an agent branch (with revisions when a person asks for changes), or as one message to a chat channel. In both cases the code that writes holds the only credential, and the model's words reach the destination as escaped plain text inside a layout the code chose. This page describes both paths and what a reader of a pull request or a message can expect.

## Pull requests

A job with `output.kind: pr` answers with a patch set: per page, no change or a unified diff with the evidence for every changed line. When the job has a `publish.ts`, the model answers in the job's own shape and the script turns it into the patch set, or into nothing. Then the runner:

1. Runs the PR checker against the pages and sources of the run's input. A page with a problem is left out and named; a problem with the answer as a whole fails the run.
2. Plans the change per repository: the pages with their patches applied, all read at one commit, on the branch `agent/<job>/<YYYY-MM-DD>` (or `agent/<job>/<key>` for a job with `branch_key`), with the input's stamps set: frontmatter values `collect.ts` computed for the keys in `stamp_keys`.
3. Applies the untrusted-input gate: a run whose model saw text anyone can write keeps the plan in the report when the job says `report_only`.
4. Runs the citation check and, when the job opts in, the attribution check, both by code reading the cited files and credited commits from the code host (see [checks.md](checks.md)).
5. Runs the second check, a model of another family in a fresh sandbox that sees only the change and its evidence. A plan whose only changes are stamps skips it: the model changed nothing.
6. In shadow mode, or in a stub run, stops here: `delivery/plan.json` and a readable copy per repository hold what it would open.
7. Live, makes an installation token of the writer app for those repositories only (contents and pull requests write, metadata read; a token granted more is revoked and refused), checks each page on the code host at the base commit is exactly the page the run checked, commits the patched pages with a fixed author, opens one pull request ready for review (a draft when the job says `draft`), or updates the one already open on that branch, then closes the job's earlier open pull requests in that repository with a comment naming the new one, and revokes the token.
8. With `notify`, posts one notice naming each pull request it opened, never one it only updated.

Because delivery closes a job's earlier pull request, a job whose pull requests may wait longer for review than its schedule allows waits instead: its `collect.ts` gives no pages while the job's own pull request is open. With `branch_key`, the waiting rule is per key.

### The body a reviewer reads

The pull request body is short and written by code: one line on what the pull request does; a "What changed and why" list with one bullet per page linking the file on the branch, the model's reason and its sources; the pages left out with their first problem; a "Preview" section when the repositories allowlist gives the repository preview commands; the sections the job's `publish.ts` wrote, in order; a "Reviewing" section; and a collapsed "Run details" block with the run, the model, the base commit, whether untrusted input was seen, the checks and the second check's reasons. Text a model wrote is plain wrapped prose, never a code block, escaped by one helper so that HTML, markdown links and images, mentions and issue references do not render and only links to the organization's own places stay links. Every opened or updated pull request also gets a completed check run named for the job on its head commit, summarizing what the run passed.

### Automatic merge, for generated data only

A job may set `auto_merge.paths`. A live run then squash-merges its own pull request right after opening it when every changed path matches one of those globs, and leaves it open for review otherwise, saying which paths kept it open. The check refuses a glob outside the job's output paths, under workflows, jobs, schemas, source, tests or tools, or naming a prompt. The reference job `atlas-map-refresh` uses this for the map's data and cache files.

### Analysis instead of a pull request

A `publish.ts` that publishes nothing may give a short analysis as a message. A live run posts it to the job's `notify` channel, a shadow run to the shadow channel, a stub run keeps it in the report. It goes through the same cleaning and limits as a chat message, and `analysis.md` in the report keeps the long form.

## Revisions

A person can ask the agent to change its own pull request. On a pull request a live job opened, either submit a review with "Request changes" (its text and its line comments are the request), or write a comment, or a line comment, whose first line starts with `/agent`. Only people the code host marks as owner, member or collaborator count; a bot never does; a request older than the latest approval is left alone.

A poller workflow, generated only while a live job has pull request output, runs every ten minutes, reads the open agent pull requests, and starts at most one revision run per job per poll, oldest request first. Expect an answer ten to twenty minutes after asking, plus the run. The pull request's check run shows the round as queued, in progress with a link, then completed.

A revision run reads the input of the run that opened the pull request from that run's report artifact (so a pull request older than the artifact retention cannot be revised), gives the model the pages as they are at the pull request's head, the requests as sources it may cite, no stamps, and a revision section after the job's prompt. The answer adds one reply per request. It goes through every check a first run does, including the second check, then commits onto the pull request's branch with its head as parent, forward only; if anyone pushed meanwhile, nothing is written. It replies to each line comment in its thread and posts one summary comment: one line on what happened, the replies to requests without a thread, and a hidden marker naming the round and the requests it answered, which is the only thing the poller reads. A round that fails still answers its requests with the reason, so it is never repeated by itself. At most five rounds per pull request; after that one comment says a person needs to take it from here.

## Replays and another second check model

To compare models on the same work, a pull request job's workflow takes three more inputs when started by hand: an earlier run id to replay (the run reads that run's input instead of collecting, always in shadow), and a second check model and level for this run. With the run's own model and level, that reruns one past input with any writer and checker pair, and the report's summary names both.

## Chat messages

A job with `output.kind: slack` names a channel from the channels allowlist. Its message is what `render.ts` prints (a fallback text and layout blocks), with a footer the code adds linking the workflow run, the job and the model; a job without `render.ts` gets a one-line message from the answer's headline. After the answer passes its schema and its quotes, the runner:

1. Holds the message to the rules, changing only what breaks them: a link whose URL does not start with a listed prefix becomes its label, every mention and special token is shown as text, bare at-mentions are broken with a word joiner, and every text is marked verbatim so the platform links nothing by itself. Every change is listed in the report.
2. Checks it fits one post: at most 50 blocks, a fallback text of at most 3,000 characters, at most 40,000 bytes of JSON. A message that does not fails the run and posts nothing; `render.ts` may print at most 48 blocks and 2,900 characters so the footer and a shadow line always fit.
3. Applies the untrusted-input gate (`post` is the default; a health report reads log lines on every run, so `report_only` would stop every post, and what a misled run can put in a message is already bounded by the layout and the rules).
4. In a stub run, or a shadow run when the shadow channel has no id, stops: `delivery/slack.json` holds the exact body it would send. Otherwise a shadow run posts to the shadow channel, under one context line saying it is a shadow run and where a live post would go, with the same words leading the fallback text, so it can be read next to the post it would replace.
5. Checks the posting token with the platform (a bot token with exactly the posting scope), posts once, by channel id, with name linking and unfurling off, and records the message's id and permalink. A rate-limited post is retried after the platform's wait, at most three times; no other failure is retried, since the message may have been posted.

The posting token reaches every run of a chat job in the runner process alone, never the sandbox or a job script, and is scrubbed from every report file. Going live changes only where the message goes.

## To confirm against the package

- The chat platform the first public version delivers to, and whether the delivery code is a plug-in point for others.
- The artifact retention the revision poller depends on.
