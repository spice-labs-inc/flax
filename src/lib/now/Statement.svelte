<script lang="ts">
  import Mark from "$lib/Mark.svelte";
  import type { MarkKind } from "$lib/data.ts";
  import type { EnvNow } from "$lib/now.ts";
  import { ago, notCheckedText, statement } from "./copy.ts";

  let { now, ref }: { now: EnvNow; ref: number } = $props();

  let kind: MarkKind = $derived(
    !now.run || now.ran === 0
      ? "none"
      : now.failing.length > 0
        ? "fail"
        : now.unreachable.length > 0
          ? "other"
          : now.passed > 0
            ? "pass"
            : "other",
  );
  let unchecked = $derived(notCheckedText(now));
</script>

<section class="env" aria-label={`${now.env} now`}>
  <p class="say">
    <span class="mark"><Mark {kind} size={18} /></span>
    {statement(now, ref)}
  </p>
  {#if now.run}
    <p class="under">
      Finished {ago(now.run.finishedAt, ref)}.
      {#if now.other > 0}
        {now.other} of {now.ran}
        {now.other === 1 ? "scenario" : "scenarios"} did not finish.
      {/if}
    </p>
    {#if unchecked}
      <p class="under">{unchecked}</p>
    {/if}
  {/if}
</section>

<style>
  .env {
    margin: 0 0 22px;
  }
  .say {
    position: relative;
    padding-left: 26px;
    margin: 0;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 650;
    font-size: 22px;
    line-height: 1.15;
    letter-spacing: -0.005em;
    text-wrap: balance;
    max-width: 70ch;
  }
  .mark {
    position: absolute;
    left: 0;
    top: 0.3em;
    line-height: 0;
  }
  .under {
    margin: 6px 0 0 26px;
    color: var(--ink-2);
    max-width: 70ch;
  }
  @container (min-width: 700px) {
    .say {
      font-size: 27px;
      padding-left: 30px;
    }
    .under {
      margin-left: 30px;
    }
  }
  @container (min-width: 1024px) {
    .say {
      font-size: 34px;
      line-height: 1.1;
      padding-left: 32px;
    }
    .under {
      margin-left: 32px;
    }
  }
</style>
