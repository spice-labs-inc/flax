<script lang="ts">
  import type { Route } from "$lib/location.ts";
  import type { Model } from "$lib/model.ts";
  import Brief from "$lib/personas/Brief.svelte";
  import Gaps from "$lib/personas/Gaps.svelte";
  import Overview from "$lib/personas/Overview.svelte";

  let { model, route }: { model: Model; route: Route } = $props();
</script>

{#if route.gaps}
  <Gaps {model} {route} />
{:else if route.persona}
  <Brief {model} {route} />
{:else}
  <Overview {model} {route} />
{/if}
