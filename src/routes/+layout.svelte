<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import Explorer from "$lib/Explorer.svelte";
  import Glossary from "$lib/Glossary.svelte";
  import Palette from "$lib/Palette.svelte";
  import TopBar from "$lib/shell/TopBar.svelte";
  import { search } from "$lib/shell/search.svelte.ts";
  import { live } from "$lib/live.svelte.ts";
  import { format, parse, type Route } from "$lib/location.ts";
  import {
    GLOSSARY_META,
    pageMeta,
    SITE,
    SITE_DESCRIPTION,
  } from "$lib/title.ts";
  import {
    absoluteOf,
    hrefOf,
    locationOf,
    type Dest,
    type Nav,
  } from "$lib/nav.ts";

  let { data, children } = $props();
  let model = $derived(data.model);
  let location = $derived(locationOf(page.url));
  let route = $derived(model ? parse(location, model) : null);
  let glossary = $derived(location.split("?")[0] === "/glossary");
  let meta = $derived(
    glossary
      ? GLOSSARY_META
      : model && route
        ? pageMeta(route, model)
        : { title: "", description: SITE_DESCRIPTION },
  );

  // The tab, history and bookmarks name the object on show; the static tags in app.html are what link previews read.
  $effect(() => {
    const title = meta.title ? `${meta.title} | ${SITE}` : SITE;
    document.title = title;
    for (const [sel, value] of [
      ['meta[name="description"]', meta.description],
      ['meta[property="og:title"]', title],
      ['meta[property="og:description"]', meta.description],
    ] as const)
      document.querySelector(sel)?.setAttribute("content", value);
  });

  const PATH_KEYS = [
    "view",
    "surface",
    "area",
    "itemId",
    "scenario",
    "feature",
    "persona",
    "station",
    "orphans",
    "gaps",
    "lines",
  ] as const;

  /** Where a search result goes: a new place keeps today's env and timeline point; a modifier keeps the place. */
  function routeFor(d: Dest): Route {
    const r = route!;
    if (!PATH_KEYS.some((k) => k in d)) return { ...r, ...d };
    return {
      view: "map",
      env: r.env,
      snap: r.snap,
      lens: "all",
      ...d,
    };
  }

  const nav: Nav = {
    href: (d) => hrefOf(format(routeFor(d), model!)),
    url: (d) => absoluteOf(format(routeFor(d), model!)),
    go: (d, from) => {
      search.pending = from ?? null;
      void goto(hrefOf(format(routeFor(d), model!)));
    },
  };

  function onkeydown(e: KeyboardEvent) {
    if (search.open || document.querySelector("dialog[open]")) return;
    const t = e.target;
    if (
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLElement && t.isContentEditable)
    )
      return;
    if (e.key === "/" || (e.key === "k" && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      search.open = true;
    }
  }

  onMount(() => {
    if (!__EXPLORER_LIVE__) return;
    live.start(() => page.data.manifest?.version ?? null);
    return () => live.stop();
  });
</script>

<svelte:window {onkeydown} />

{#if page.error}
  {@render children()}
{:else if model && route}
  <div class="shell">
    <TopBar {model} {route} {glossary} />
    <div class="door">
      {#if glossary}
        <Glossary {model} />
      {:else}
        <Explorer {model} {location} />
      {/if}
      {@render children()}
    </div>
  </div>
  <Palette
    {model}
    bind:open={search.open}
    bind:resume={search.resume}
    snap={route.snap}
    {nav}
  />
{:else}
  <main class="nodata">
    <h1>{SITE}</h1>
    <p>{data.problem}</p>
    {#if !__EXPLORER_SINGLE_FILE__}
      <p class="sub">
        This page loads the data as soon as the explorer service has built it.
      </p>
    {/if}
  </main>
{/if}

<style>
  .shell {
    height: 100%;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
  }
  .door {
    min-height: 0;
    min-width: 0;
    overflow: auto;
  }
  .nodata {
    padding: 32px 20px;
    max-width: 60ch;
  }
  h1 {
    margin: 0 0 12px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 650;
    font-size: 22px;
  }
  p {
    margin: 0 0 8px;
  }
  .sub {
    color: var(--ink-2);
  }
  @media (max-width: 860px) {
    .shell {
      height: auto;
      grid-template-rows: auto auto;
    }
    .door {
      overflow: visible;
    }
  }
</style>
