<script lang="ts">
  import { ENV_LABEL } from "./data.ts";
  import type { ScenarioRun } from "./live.svelte.ts";
  import {
    STEP_LABEL,
    formatMs,
    type GherkinStep,
    type StepCode,
  } from "./scenarios.ts";

  let {
    runs,
    steps,
  }: {
    /** This scenario in each env's live run. */
    runs: ScenarioRun[];
    /** The scenario's steps as the data has them; a live run may run a newer version. */
    steps: GherkinStep[];
  } = $props();

  const isCode = (c: string): c is StepCode => c in STEP_LABEL;
  const label = (c: string) => (isCode(c) ? STEP_LABEL[c] : "Not run yet");
</script>

{#each runs as r (r.env)}
  {@const s = r.scenario}
  {@const at = s.codes.indexOf(".")}
  <section class="live" aria-label="{ENV_LABEL[r.env]} run in progress">
    <p class="head">
      <span class="env">{ENV_LABEL[r.env]}, the run in progress:</span>
      {#if s.status === "running" || s.status === "retrying"}
        <span class="dot" aria-hidden="true"></span>
        running{s.status === "retrying" || s.attempt > 0 ? " again" : ""}, step {Math.min(
          at < 0 ? s.codes.length : at + 1,
          s.codes.length,
        )} of {s.codes.length}{at >= 0 && steps[at] ? `: ${steps[at].t}` : ""}
      {:else if s.status === "passed"}
        verified{s.durationMs !== undefined
          ? ` in ${formatMs(s.durationMs)}`
          : ""}
      {:else}
        {s.status === "failed"
          ? "failed"
          : `did not finish (${s.status})`}{s.failure ? `: ${s.failure}` : ""}
      {/if}
    </p>
    <ol class="codes" aria-label="Steps so far">
      {#each [...s.codes] as c, i (i)}
        <li
          class="c {c === '.' ? 'wait' : c}"
          title="{i + 1}. {steps[i]?.t ?? ''}: {label(c)}"
        >
          <span class="sr">Step {i + 1}: {label(c)}</span>
        </li>
      {/each}
    </ol>
  </section>
{/each}

<style>
  .live {
    margin: 0 0 12px;
    padding: 8px 12px;
    border: 1px solid var(--rule);
    border-radius: var(--r-s);
    background: var(--panel);
    font-size: 13px;
  }
  .head {
    margin: 0 0 6px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
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
  .codes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }
  .c {
    width: 14px;
    height: 8px;
    border-radius: 2px;
    background: var(--none);
  }
  .c.p {
    background: var(--pass);
  }
  .c.f {
    background: var(--fail);
  }
  .c.s,
  .c.u,
  .c.n,
  .c.a {
    background: var(--ink-3);
  }
  .c.wait {
    background: transparent;
    border: 1px solid var(--land-edge);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
