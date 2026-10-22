<script lang="ts">
  import { ENV_ORDER, type Env } from "$lib/data.ts";
  import { featureKey, type Feature } from "$lib/features.ts";
  import type { Route } from "$lib/location.ts";
  import { format } from "$lib/location.ts";
  import type { MarkKind } from "$lib/data.ts";
  import type { Model } from "$lib/model.ts";
  import { hrefOf } from "$lib/nav.ts";
  import Mark from "$lib/Mark.svelte";
  import Hex from "$lib/shell/Hex.svelte";
  import type { HexStates } from "$lib/data.ts";
  import { countOf, paragraphs } from "./catalog.ts";

  let {
    feature: f,
    model,
    route,
  }: { feature: Feature; model: Model; route: Route } = $props();

  let states = $derived(
    Object.fromEntries(
      ENV_ORDER.map((e): [Env, MarkKind] => [
        e,
        model.featureState(f, e, route.snap).kind,
      ]),
    ) as HexStates,
  );
  let summary = $derived(model.featureSummary(f, route.env, route.snap));
  let paras = $derived(paragraphs(f.description));
  let href = $derived(
    hrefOf(
      format(
        {
          view: "features",
          feature: featureKey(f),
          env: route.env,
          snap: route.snap,
          lens: "all",
        },
        model,
      ),
    ),
  );
  const personaHref = (id: string) =>
    hrefOf(
      format(
        {
          view: "personas",
          persona: id,
          env: route.env,
          snap: route.snap,
          lens: "all",
        },
        model,
      ),
    );
</script>

<article class="entry">
  <h3><a {href}>{f.name}</a></h3>
  <div class="desc">
    {#each paras as p, i (i)}
      <p>{p}</p>
    {/each}
  </div>
  <p class="stands">
    {#if route.env === "all"}
      <Hex {states} size={16} label={summary.label} />
    {:else}
      <span class="one" role="img" aria-label={summary.label}
        ><Mark kind={summary.kind} size={14} /></span
      >
    {/if}
    <span>{summary.label}. {countOf(f.scenarios.length, "scenario")}.</span>
  </p>
  {#if f.personas.length && !model.everyoneSignedIn(f.personas)}
    <p class="personas">
      <span class="who">Who needs it</span>
      {#each f.personas as p (p.id)}
        <a href={personaHref(p.id)}>{p.name}</a>
      {/each}
    </p>
  {/if}
</article>

<style>
  .entry {
    padding: 18px 0 20px;
    max-width: 70ch;
  }
  h3 {
    margin: 0 0 6px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 650;
    font-size: 22px;
    line-height: 1.15;
  }
  h3 a {
    color: var(--ink);
    text-decoration: none;
  }
  h3 a:hover {
    color: var(--accent);
  }
  .desc p {
    margin: 0 0 6px;
    font-family: "Newsreader", serif;
    font-style: italic;
    font-optical-sizing: auto;
    font-size: 17.5px;
    line-height: 1.45;
    color: var(--ink);
  }
  .stands {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0 0;
    color: var(--ink-2);
  }
  .one {
    display: inline-flex;
  }
  .personas {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 12px;
    margin: 6px 0 0;
    font-size: 14px;
  }
  .who {
    color: var(--ink-3);
  }
  .personas a {
    color: var(--accent);
    text-decoration: none;
    padding: 4px 0;
  }
  .personas a:hover {
    text-decoration: underline;
  }
</style>
