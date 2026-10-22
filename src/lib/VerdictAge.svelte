<script lang="ts">
  import { formatPacific, type Env, type Item } from "./data.ts";
  import type { Model } from "./model.ts";

  let {
    model,
    item,
    env,
    snap,
  }: { model: Model; item: Item; env: Env; snap: number } = $props();
  let v = $derived(model.verdict(item, env, snap));
</script>

{#if v.asOf || v.stale}
  <small class="age" class:stale={v.stale}
    >{v.asOf ? `As of ${formatPacific(v.asOf)}` : "As of an older run"}{v.stale
      ? ", older than usual"
      : ""}</small
  >
{/if}

<style>
  .age {
    color: var(--ink-3);
    font-size: 11px;
    line-height: 1.3;
  }
  .stale {
    color: var(--ink-2);
    font-style: italic;
  }
</style>
