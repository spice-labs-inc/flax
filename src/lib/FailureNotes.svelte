<script lang="ts">
  import Mark from "./Mark.svelte";
  import { ENV_LABEL, formatPacific } from "./data.ts";
  import { inPage, type Dest, type Nav, type Opener } from "./nav.ts";
  import type { FailNote } from "./scenarios.ts";

  let {
    notes,
    nav,
    dest,
    from,
    onleave,
  }: {
    notes: FailNote[];
    nav: Nav;
    /** Where a failure's links go: its scenario, opened at the failed step. */
    dest: (n: FailNote) => Dest;
    from?: (n: FailNote, what: "scenario" | "shot") => Opener;
    /** Called before a link navigates inside the page. */
    onleave?: () => void;
  } = $props();

  const at = (n: FailNote): Dest => ({ ...dest(n), step: n.stepNo });

  function go(e: MouseEvent, n: FailNote, what: "scenario" | "shot") {
    if (!inPage(e)) return;
    onleave?.();
    nav.go(at(n), from?.(n, what));
  }
</script>

<div class="fails">
  {#each notes as n (n.env)}
    <div class="fail">
      <p class="fhead">
        <Mark kind="fail" size={13} /><b>Failed on {ENV_LABEL[n.env]}</b><span
          class="when">{formatPacific(n.at)}</span
        >
      </p>
      <p class="what">
        <a
          href={nav.href(at(n))}
          data-return="fail-scenario:{n.env}"
          onclick={(e) => go(e, n, "scenario")}>{n.scenario.name}</a
        >{n.more
          ? `, and ${n.more} more ${n.more === 1 ? "scenario" : "scenarios"} failing there`
          : ""}
      </p>
      <p class="step"><span>Failed step</span> {n.step}</p>
      {#if n.message}<pre class="msg">{n.message}</pre>{/if}
      {#if n.shot}
        <a
          class="shot"
          href={nav.href(at(n))}
          data-return="fail-shot:{n.env}"
          onclick={(e) => go(e, n, "shot")}>Screenshot from when it failed</a
        >
      {/if}
    </div>
  {/each}
</div>

<style>
  .fails {
    display: grid;
    gap: 12px;
    margin: 12px 0 0;
  }
  .fail {
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .fail p {
    margin: 0;
  }
  .fhead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    column-gap: 6px;
  }
  .fhead b {
    color: var(--fail);
  }
  .when {
    color: var(--ink-3);
    font-size: 12px;
  }
  .what {
    margin-top: 2px;
  }
  a {
    color: var(--accent);
  }
  .step {
    margin-top: 4px;
    color: var(--ink-2);
  }
  .step span {
    color: var(--ink-3);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-right: 4px;
  }
  .msg {
    margin: 6px 0 0;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--fail) 8%, var(--panel));
    border: 1px solid color-mix(in srgb, var(--fail) 25%, transparent);
    border-radius: var(--r-s);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .shot {
    display: inline-block;
    margin-top: 6px;
    font-size: 12.5px;
  }
</style>
