<script lang="ts">
  import { onMount } from "svelte";
  import {
    ENV_LABEL,
    ENV_ORDER,
    formatPacific,
    formatPacificTime,
    type Env,
  } from "./data.ts";
  import { live, type LiveRun, type RunningWorkflow } from "./live.svelte.ts";
  import type { Model } from "./model.ts";
  import { inPage, type Nav } from "./nav.ts";

  let { model, nav }: { model: Model; nav: Nav } = $props();

  let now = $state(Date.now());
  onMount(() => {
    const t = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(t);
  });

  const minutes = (from: string, to = now) =>
    Math.max(0, Math.round((to - Date.parse(from)) / 60_000));

  interface Row {
    env: Env;
    /** The env's run while it runs, and after it ends until the map has its results. */
    run?: LiveRun;
    finished: number;
    passed: number;
    failed: number;
    failing: { id: string; name: string; failure?: string }[];
    /** A workflow run in progress that pushes no live detail. */
    other?: RunningWorkflow;
    /** When the env's newest run in the data finished, for a quiet row. */
    last?: string;
  }

  /** One row per env, always, so the strip never changes height as runs start and end. */
  let rows = $derived(
    ENV_ORDER.map((env): Row => {
      const current = live.current(env);
      const inData = current
        ? model.runs.some((r) => r.id === current.runId)
        : false;
      const run =
        current && (current.state === "running" || !inData)
          ? current
          : undefined;
      const c = run
        ? live.counts(run.runId)
        : { finished: 0, passed: 0, failed: 0 };
      const failing = run
        ? Object.values(live.scenarios[run.runId] ?? {})
            .filter(
              (s) =>
                s.status !== "running" &&
                s.status !== "retrying" &&
                s.status !== "passed" &&
                s.status !== "skipped",
            )
            .slice(0, 3)
        : [];
      const other = run ? undefined : live.running.find((w) => w.env === env);
      let last: string | undefined;
      for (const r of model.runs)
        if (r.env === env && (!last || r.finishedAt > last))
          last = r.finishedAt;
      return { env, run, ...c, failing, other, last };
    }),
  );
  let byHand = $derived(live.running.filter((w) => !w.env));
  let paused = $derived(live.errored && !live.connected);
</script>

{#if __EXPLORER_LIVE__}
  <section class="live" aria-label="Scheduled runs" aria-live="polite">
    {#each rows as r (r.env)}
      <div
        class="row"
        class:done={!!r.run && r.run.state !== "running"}
        class:quiet={!r.run && !r.other}
      >
        <span class="env">{ENV_LABEL[r.env]}</span>
        {#if r.run?.state === "running"}
          <span class="dot" aria-hidden="true"></span>
          <span
            >Run in progress: {r.finished} of {r.run.total || "?"} scenarios, {r.passed}
            verified, {r.failed} failed, {minutes(r.run.startedAt)} min</span
          >
        {:else if r.run?.state === "finished"}
          <span
            >Run finished at {formatPacificTime(
              r.run.finishedAt ?? r.run.lastMessageAt,
            )}: {r.passed} verified, {r.failed} failed; the map updates when its results
            are built</span
          >
        {:else if r.run}
          <span
            >The run stopped reporting at {formatPacificTime(
              r.run.lastMessageAt,
            )}; its results arrive with the run's artifact</span
          >
        {:else if r.other}
          <span class="dot" aria-hidden="true"></span>
          <span
            >Run in progress since {formatPacificTime(r.other.startedAt)}; live
            detail unavailable, results arrive when it ends</span
          >
          <a class="gh" href={r.other.url}>Workflow run</a>
        {:else}
          <span
            >No run in progress{r.last
              ? `; the last one finished ${formatPacific(r.last)}`
              : ""}</span
          >
        {/if}
        {#if r.run}
          {#if r.run.gap}<span class="note">Some live detail was lost</span
            >{/if}
          {#each r.failing as f (f.id)}
            <a
              class="fail"
              href={nav.href({ scenario: f.id })}
              title={f.failure}
              onclick={(e) => inPage(e) && nav.go({ scenario: f.id })}
              >{f.name}</a
            >
          {/each}
          {#if r.run.github}
            <a
              class="gh"
              href="https://github.com/{r.run.github.repository}/actions/runs/{r
                .run.github.runId}">Workflow run</a
            >
          {/if}
        {/if}
      </div>
    {/each}
    {#each byHand as w (w.id)}
      <div class="row">
        <span class="env">A run started by hand</span>
        <span class="dot" aria-hidden="true"></span>
        <span
          >Run in progress since {formatPacificTime(w.startedAt)}; live detail
          unavailable, results arrive when it ends</span
        >
        <a class="gh" href={w.url}>Workflow run</a>
      </div>
    {/each}
    {#if paused}
      <div class="row paused">Live updates paused, reconnecting</div>
    {/if}
  </section>
{/if}

<style>
  .live {
    grid-area: live;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 20px;
    border-bottom: 1px solid var(--rule);
    background: var(--panel);
    font-size: 13px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    min-width: 0;
  }
  .env {
    font-weight: 700;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    animation: beat 1.6s ease-in-out infinite;
  }
  @keyframes beat {
    50% {
      opacity: 0.25;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }
  .done,
  .quiet {
    color: var(--ink-2);
  }
  .note {
    color: var(--ink-2);
    font-style: italic;
  }
  .fail {
    color: var(--fail);
    max-width: 32ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: inline-block;
  }
  .gh {
    color: var(--accent);
  }
  .paused {
    color: var(--ink-2);
  }
  @media (max-width: 860px) {
    .live {
      padding-inline: 16px;
    }
  }
</style>
