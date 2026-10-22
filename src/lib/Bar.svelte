<script lang="ts">
  import type { Tally } from "./data.ts";

  let { t }: { t: Tally } = $props();
  let s = $derived(Math.max(1, t.slots));
</script>

<span class="bar" aria-hidden="true">
  <i style:width="{(t.pass / s) * 100}%" style:background="var(--pass)"></i>
  <i style:width="{(t.fail / s) * 100}%" style:background="var(--fail)"></i>
  <i
    style:width="{(t.planned / s) * 100}%"
    style:background="var(--planned)"
    style:opacity="0.55"
  ></i>
</span>

<style>
  .bar {
    grid-column: 1 / -1;
    height: 6px;
    border-radius: 3px;
    background: var(--none);
    display: flex;
    overflow: hidden;
  }
  i {
    display: block;
    height: 100%;
  }
</style>
