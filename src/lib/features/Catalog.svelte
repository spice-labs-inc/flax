<script lang="ts">
  import { goto } from "$app/navigation";
  import { SURFACE_TITLE, type FeatureSurface } from "$lib/features.ts";
  import { format, type Route } from "$lib/location.ts";
  import type { Model } from "$lib/model.ts";
  import { hrefOf } from "$lib/nav.ts";
  import { countOf, groupBySurface } from "./catalog.ts";
  import FeatureEntry from "./FeatureEntry.svelte";

  let {
    model,
    route,
    surface,
  }: { model: Model; route: Route; surface?: FeatureSurface } = $props();

  /** What the person has typed and the URL has not caught up with yet. */
  let typed = $state<string | null>(null);
  let q = $derived(typed ?? route.q ?? "");
  let timer: ReturnType<typeof setTimeout> | undefined;

  function routeWith(query: string): Route {
    const next: Route = { ...route };
    delete next.q;
    const trimmed = query.trim();
    if (trimmed) next.q = trimmed;
    return next;
  }

  function onInput(e: Event & { currentTarget: HTMLInputElement }) {
    const value = e.currentTarget.value;
    typed = value;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await goto(hrefOf(format(routeWith(value), model)), {
        replaceState: true,
        keepFocus: true,
        noScroll: true,
      });
      if (typed === value) typed = null;
    }, 200);
  }

  let found = $derived(model.searchFeatures(q));
  let groups = $derived(
    groupBySurface(model.featureGroups, found).filter(
      (g) => !surface || g.surface === surface,
    ),
  );
  let total = $derived(groups.reduce((n, g) => n + g.features.length, 0));
  let title = $derived(surface ? SURFACE_TITLE[surface] : "Features");
  let allHref = $derived(
    hrefOf(
      format(
        { ...routeWith(q), surface: undefined, feature: undefined },
        model,
      ),
    ),
  );
  let mapHref = $derived(
    hrefOf(
      format(
        {
          view: "map",
          env: route.env,
          snap: route.snap,
          lens: "all",
        },
        model,
      ),
    ),
  );
  const surfaceHref = (s: FeatureSurface) =>
    hrefOf(format({ ...routeWith(q), surface: s, feature: undefined }, model));
  /** On the catalog the rail jumps within the page; the single-file page owns the hash, so there it opens the surface. */
  const jumpHref = (s: FeatureSurface) =>
    __EXPLORER_SINGLE_FILE__ ? surfaceHref(s) : `#${s}`;
</script>

<main class="catalog" class:one={!!surface}>
  <header class="head">
    {#if surface}
      <p class="up"><a href={allHref}>All features</a></p>
    {/if}
    <h1>{title}</h1>
    <p class="lede">
      {#if surface}
        {countOf(
          model.featureGroups.find((g) => g.surface === surface)?.features
            .length ?? 0,
          "feature",
        )}
        of the product, in its own words.
      {:else}
        {countOf(model.features.length, "feature")} across {countOf(
          model.featureGroups.length,
          "surface",
        )}, each in the product's own words, with what proves it.
      {/if}
      <a class="map" href={mapHref}
        >Every API operation, page and flag as a hex on the map</a
      >
    </p>
    <label class="search">
      <span class="sr">Search features, scenarios and steps</span>
      <input
        type="search"
        placeholder="Search features, scenarios and steps"
        value={q}
        oninput={onInput}
        autocomplete="off"
      />
    </label>
    {#if q.trim()}
      <p class="count" aria-live="polite">
        {#if total}
          {countOf(total, "feature")} mention every word of "{q.trim()}".
        {:else}
          No feature, scenario or step mentions every word of "{q.trim()}".
          <a href={hrefOf(format(routeWith(""), model))}>Clear the search</a>
        {/if}
      </p>
    {/if}
  </header>

  {#if !surface}
    <nav class="rail" aria-label="Surfaces">
      <ul>
        {#each groups as g (g.surface)}
          <li>
            <a href={jumpHref(g.surface)}
              >{g.title} <span class="n">{g.features.length}</span></a
            >
          </li>
        {/each}
      </ul>
    </nav>
  {/if}

  <div class="list">
    {#each groups as g (g.surface)}
      <section id={g.surface} class="surface">
        {#if !surface}
          <h2>
            <a href={surfaceHref(g.surface)}>{g.title}</a>
            <span class="n">{countOf(g.features.length, "feature")}</span>
          </h2>
        {/if}
        {#each g.features as f (f.id)}
          <FeatureEntry feature={f} {model} {route} />
        {/each}
      </section>
    {/each}
  </div>
</main>

<style>
  .catalog {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "head" "rail" "list";
    padding: 28px 20px 48px;
    column-gap: 40px;
  }
  .head {
    grid-area: head;
    max-width: 70ch;
  }
  .rail {
    grid-area: rail;
  }
  .list {
    grid-area: list;
    min-width: 0;
  }
  .up {
    margin: 0 0 6px;
    font-size: 14px;
  }
  .up a,
  .map,
  .count a {
    color: var(--accent);
    text-decoration: none;
  }
  .up a:hover,
  .map:hover,
  .count a:hover {
    text-decoration: underline;
  }
  h1 {
    margin: 0 0 8px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 27px;
    line-height: 1.05;
    letter-spacing: -0.01em;
  }
  .lede {
    margin: 0 0 16px;
    color: var(--ink-2);
    line-height: 1.5;
  }
  .map {
    display: block;
    margin-top: 4px;
  }
  .search input {
    width: 100%;
    box-sizing: border-box;
    height: 44px;
    padding: 0 14px;
    font: inherit;
    font-size: 15px;
    color: var(--ink);
    background: var(--panel);
    border: 1px solid var(--rule);
    border-radius: 8px;
    transition: border-color 150ms ease;
  }
  .search input::placeholder {
    color: var(--ink-3);
  }
  .search input:focus {
    border-color: var(--accent);
  }
  .count {
    margin: 8px 0 0;
    color: var(--ink-2);
  }
  .rail ul {
    list-style: none;
    margin: 16px 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
  }
  .rail a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 40px;
    color: var(--ink-2);
    text-decoration: none;
    font-weight: 600;
  }
  .rail a:hover {
    color: var(--ink);
  }
  .n {
    color: var(--ink-3);
    font-weight: 500;
    font-size: 14px;
  }
  .surface {
    padding-top: 24px;
  }
  .surface + .surface {
    margin-top: 16px;
    border-top: 1px solid var(--rule);
  }
  h2 {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin: 0 0 4px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 27px;
    line-height: 1.1;
  }
  h2 a {
    color: var(--ink);
    text-decoration: none;
  }
  h2 a:hover {
    color: var(--accent);
  }
  .one .surface {
    padding-top: 8px;
  }
  @container (min-width: 1024px) {
    .catalog {
      grid-template-columns: minmax(0, 72ch) 200px;
      grid-template-areas: "head rail" "list rail";
      justify-content: start;
      padding: 36px 40px 64px;
      font-size: 15px;
      line-height: 1.55;
    }
    .catalog.one {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: "head" "list";
    }
    h1 {
      font-size: 43px;
    }
    .rail {
      position: sticky;
      top: 36px;
      align-self: start;
    }
    .rail ul {
      flex-direction: column;
      gap: 0;
      margin: 0;
    }
    .rail a {
      width: 100%;
      justify-content: space-between;
      min-height: 36px;
    }
  }
</style>
