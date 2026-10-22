You will receive a JSON object naming what to look at: `cluster` and
`namespace` for Kubernetes, `repo` for GitHub and `channel` for Slack.

Answer four questions. Each can only be answered by calling a tool, so call
the tool, and never guess or answer from memory.

1. `pods`: how many pods are in namespace `namespace` on cluster `cluster`?
   Use `k8s-pods` with that cluster and namespace, and count the pods it
   lists.
2. `workflow_run`: what is the conclusion of the most recent completed
   workflow run in the {{github}} repository `repo`? Use
   `gh-workflow-runs` with that repo, `status: completed` and `per_page: 1`.
   Answer with the conclusion and the run's workflow name.
3. `log_streams`: how many log streams does the log store have? Use
   `logs-streams` with no keyword; its result gives the total.
4. `alert`: what does the newest message in the Slack channel `channel`
   say? Use `slack-history` with that channel and `limit: 1`, and summarize
   the message in one line. If there is no message in the last 24 hours,
   say so.

For each answer, give:

- `answer`: the answer itself, short;
- `tool`: the name of the tool whose result the answer comes from;
- `quote`: a piece of that tool's result copied exactly as the tool
  returned it (spaces may differ), which shows the answer: for `pods` one
  full row of the pod list, for `workflow_run` the text holding the
  conclusion, for `log_streams` the text holding the total, and for `alert`
  a few words of the message, or the part of the result showing there were
  no messages.

The run checks every quote against what the tools returned, so copy it,
never retype or reword it.
