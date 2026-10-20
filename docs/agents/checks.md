# Checks on the answer

The guardrails before a model runs keep credentials and the network away from it; the guardrails after it answers decide what, if anything, leaves the run. This page is the second half of [guardrails.md](guardrails.md): how the answer is read, the one repair turn, the code checks every pull request passes, the second check by another model, and delivery by code. Every rule here is a runner behavior with its own tests in the agents package.

## The answer is one JSON value, with one repair turn

The runner reads the model's final message as one JSON value (also out of a code fence or after prose that ends in JSON). Two complete values, or prose on both sides, are refused: which one is the answer would be a guess. An answer that is not JSON or fails the schema gets one repair turn: the agent continues its own session in a new box on the same data directory, sockets and key, sees only the exact problems, and must send the complete corrected answer within what is left of the run's time, at most ten minutes. The repaired answer gets every check the first would have. There is never a second repair turn.

## Output checks, by code, before any model judges

A pull request answer passes the PR checker: paths inside the job's `paths`, the line limit, a patch that applies to the page as given, evidence for every changed line that resolves to a source in the input, no frontmatter change beyond the keys the job allows, no added image or URL-loading HTML, and links only to allowlisted hosts. The citation check reads every cited file at the cited commit and leaves out a page that cites a line that is not there, or whose claim about code rests only on documentation. The attribution check, when a job opts in, reads every commit and pull request a changed line credits and leaves out a page whose credit is not merged, names the wrong merge commit, carries a date other than the day it landed, or quotes an identifier that is on no changed line of the credited diff. Quotes of tool results are checked against what the tools returned in this run. A page with a problem is left out and named; the rest goes on.

## The second check

Every pull request is approved by a second model run before it is opened: a fresh sandbox and data directory, read-only tools, no job tools, no shell. It sees only the proposed patches with their reasons, the sources each change cites, the content of every cited file at the cited commit, every credited commit's subject, merge date and diff, the fixed rules and the job's prompt. It never sees the pages, the input, or anything a tool gathered, so the raw inputs that could have misled the writer cannot steer the check. It answers approve or reject with reasons, each naming the page and change it is about; a rejection whose every reason names a page leaves those pages out, any other rejection keeps the plan as a report. A job may name a `review_model` of another model family than the writer's, so one model's blind spot is not checked by itself. The check runs on the same key, in a reserved ten minutes.

## Delivery by code

No model ever holds a write credential. A live pull request run makes a short-lived installation token for the target repositories only, checks each page on the code host is exactly the page the run checked, commits the patched pages with a fixed author to `agent/<job>/<day>`, opens or updates one pull request, closes the job's earlier ones with a comment, and revokes the token. The writer has no call that merges or approves, except `auto_merge.paths` for generated data only. A chat message is posted once, by code, to a listed channel, after link cleaning and mention breaking, with unfurling off; a message is a run's only way out, so it may link only to the organization's own hosts and never carries an image. Stamps in frontmatter are set by the job's code after every check, never by the model. Revisions (a person asking the agent to change its own pull request) go through every check again and write only onto the pull request's own branch, forward only. See [delivery.md](delivery.md).


## To confirm against the package

- The exact wording of the PR checker's and the second check's refusal reasons as the package prints them.
- Whether the attribution check and `code_fix` ship in the first public version.
