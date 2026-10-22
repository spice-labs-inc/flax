<script lang="ts">
  import Catalog from "$lib/features/Catalog.svelte";
  import FeaturePage from "$lib/features/FeaturePage.svelte";
  import { isSurface } from "$lib/features/catalog.ts";
  import { format, type Route } from "$lib/location.ts";
  import type { Model } from "$lib/model.ts";
  import { hrefOf } from "$lib/nav.ts";

  let { model, route }: { model: Model; route: Route } = $props();
  let feature = $derived(
    route.feature ? model.featureAt(route.feature) : undefined,
  );
  let surface = $derived(
    route.surface && isSurface(model.featureGroups, route.surface)
      ? route.surface
      : undefined,
  );
  let allHref = $derived(
    hrefOf(format({ ...route, surface: undefined, feature: undefined }, model)),
  );
</script>

{#if route.feature || (route.surface && !surface)}
  {#if feature}
    <FeaturePage {feature} {model} {route} />
  {:else}
    <div class="missing">
      <h2>No feature at this address</h2>
      <p><a href={allHref}>All features</a></p>
    </div>
  {/if}
{:else}
  <Catalog {model} {route} {surface} />
{/if}

<style>
  .missing {
    padding: 20px;
  }
  h2 {
    margin: 0 0 8px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 22px;
  }
  a {
    color: var(--accent);
  }
</style>
