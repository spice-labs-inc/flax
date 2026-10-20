<script lang="ts">
  import { SITE } from "$lib/title.ts";
  import { ENV_LABEL, ENV_ORDER, type EnvChoice } from "$lib/data.ts";
  import { live } from "$lib/live.svelte.ts";
  import {
    DOORS,
    doorOf,
    doorRoute,
    format,
    type Route,
  } from "$lib/location.ts";
  import type { Model } from "$lib/model.ts";
  import { hrefOf } from "$lib/nav.ts";
  import { search } from "./search.svelte.ts";

  let {
    model,
    route,
    glossary = false,
  }: { model: Model; route: Route; glossary?: boolean } = $props();
  let current = $derived(doorOf(route.view));
  let running = $derived(live.runningScenarios("all").length > 0);

  const ENV_OPTS: { key: EnvChoice; label: string }[] = [
    { key: "all", label: "All" },
    ...ENV_ORDER.map((e) => ({ key: e, label: ENV_LABEL[e] })),
  ];
  const envHref = (env: EnvChoice) => hrefOf(format({ ...route, env }, model));
</script>

<header class="top">
  <a class="brand" href={hrefOf(format(doorRoute(route, "now"), model))}>
    <span class="dot" class:running aria-hidden="true"></span>
    {SITE}
  </a>
  <nav class="doors" aria-label="Sections">
    {#each DOORS as d (d.view)}
      <a
        href={hrefOf(format(doorRoute(route, d.view), model))}
        aria-current={current === d.view && !glossary ? "page" : undefined}
        >{d.label}</a
      >
    {/each}
  </nav>
  <nav class="envs" aria-label="Environment">
    {#each ENV_OPTS as o (o.key)}
      <a
        href={envHref(o.key)}
        aria-current={route.env === o.key ? "true" : undefined}>{o.label}</a
      >
    {/each}
  </nav>
  <button
    class="search"
    type="button"
    aria-keyshortcuts="/"
    onclick={() => (search.open = true)}>Search <kbd>/</kbd></button
  >
  <a
    class="glossary"
    href={hrefOf("/glossary")}
    aria-current={glossary ? "page" : undefined}>Glossary</a
  >
</header>

<style>
  .top {
    display: flex;
    align-items: center;
    gap: 8px 28px;
    padding: 0 20px;
    height: 52px;
    border-bottom: 1px solid var(--rule);
    background: var(--ground);
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    color: var(--ink);
    text-decoration: none;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 19px;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--pass);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--pass) 45%, transparent);
  }
  .dot.running {
    background: var(--accent);
    animation: breathe 2.4s ease-in-out infinite;
  }
  @keyframes breathe {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent);
    }
    50% {
      box-shadow: 0 0 0 7px color-mix(in srgb, var(--accent) 0%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.running {
      animation: none;
    }
  }
  nav {
    display: flex;
    gap: 2px;
  }
  .doors {
    gap: 4px;
  }
  .doors a,
  .envs a {
    color: var(--ink-2);
    text-decoration: none;
    padding: 6px 10px;
    border-radius: var(--r-s);
    font-size: 14px;
  }
  .doors a {
    font-weight: 600;
    font-size: 15px;
  }
  .doors a:hover,
  .envs a:hover {
    color: var(--ink);
    background: var(--ground-2);
  }
  .doors a[aria-current="page"] {
    color: var(--ink);
    background: var(--panel);
    box-shadow: inset 0 -2px 0 var(--ink);
  }
  .search {
    appearance: none;
    border: 1px solid var(--rule);
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    border-radius: 8px;
    padding: 6px 10px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .search:hover {
    background: var(--ground-2);
  }
  .glossary {
    color: var(--ink-2);
    text-decoration: none;
    font-size: 13px;
    padding: 6px 8px;
    border-radius: var(--r-s);
    white-space: nowrap;
  }
  .glossary:hover,
  .glossary[aria-current="page"] {
    color: var(--ink);
    background: var(--ground-2);
  }
  .envs {
    margin-left: auto;
    padding: 2px;
    border: 1px solid var(--rule);
    border-radius: 8px;
  }
  .envs a {
    font-size: 13px;
  }
  .envs a[aria-current="true"] {
    color: var(--ink);
    background: var(--panel);
    box-shadow: 0 1px 0 var(--rule);
  }
  @media (max-width: 860px) {
    .top {
      flex-wrap: wrap;
      height: auto;
      padding: 10px 16px;
      gap: 8px 16px;
    }
    .doors {
      order: 3;
      width: 100%;
      justify-content: space-between;
    }
    .doors a {
      flex: 1;
      text-align: center;
    }
  }
</style>
