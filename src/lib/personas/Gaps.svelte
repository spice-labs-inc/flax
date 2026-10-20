<script lang="ts">
  import { SURFACE_TITLE } from "$lib/features.ts";
  import type { Route } from "$lib/location.ts";
  import type { Model } from "$lib/model.ts";
  import { STATE_LABEL, TYPE_LABEL } from "$lib/personas.ts";
  import { plural } from "./copy.ts";
  import { personaLinks } from "./links.ts";

  let { model, route }: { model: Model; route: Route } = $props();

  let links = $derived(personaLinks(route, model));
  let gaps = $derived(model.gaps(route.snap, route.env));

  const sharedBy = (st: (typeof gaps.unproven)[number]) =>
    model.personas.filter(
      (p) => p !== st.persona && p.stations.includes(st.station),
    );
</script>

<main class="page">
  <p class="statement">Gaps</p>
  <p class="ways">
    <a href={links.overview}>All personas</a>
  </p>

  <section>
    <h2>Stations no scenario proves</h2>
    <p class="lead">
      {#if gaps.unproven.length}
        {plural(gaps.unproven.length, "step")} on a journey that nothing verifies:
        each is a promise to a persona with no proof behind it, so the scenario comes
        first and, if the feature is not there, the issue after it.
      {:else}
        Every station on every journey has a scenario behind it.
      {/if}
    </p>
    <ul class="list">
      {#each gaps.unproven as g (g.station.key)}
        <li>
          <a href={links.persona(g.persona.id, g.station.key)}
            >{g.station.name}</a
          >
          <span class="meta">
            {g.persona.name}{#each sharedBy(g) as p (p.id)}, {p.name}{/each}:
            {STATE_LABEL[
              model.stationState(g.station, route.snap, route.env)
            ].toLowerCase()}
          </span>
        </li>
      {/each}
    </ul>
  </section>

  <section>
    <h2>Planned work naming no persona</h2>
    <p class="lead">
      {#if gaps.plannedForNobody.length}
        {plural(gaps.plannedForNobody.length, "board issue")} with no persona on
        {gaps.plannedForNobody.length === 1 ? "it" : "them"}: until one is
        named, nobody can say whose journey the work shortens.
      {:else}
        Every board issue names the persona it serves.
      {/if}
    </p>
    <ul class="list">
      {#each gaps.plannedForNobody as i (i.item.id)}
        <li>
          <a href={i.url} target="_blank" rel="noreferrer">{i.item.label}</a>
          <span class="meta">{i.board}, {i.area}</span>
        </li>
      {/each}
    </ul>
  </section>

  <section>
    <h2>No journey yet</h2>
    <p class="lead">
      {#if gaps.withoutJourney.length}
        {plural(gaps.withoutJourney.length, "persona")} the product is built for without
        a journey yet, so nothing on the map can be checked against their needs.
      {:else}
        Every persona we design for has a journey; a persona we have not written
        shows up below, as surface nobody claims.
      {/if}
    </p>
    <ul class="list">
      {#each gaps.withoutJourney as d (d.id)}
        <li>
          <a href={links.persona(d.id)}>{d.name}</a>
          <span class="meta">{TYPE_LABEL[d.type]}</span>
          <p>{d.summary}</p>
        </li>
      {/each}
    </ul>
  </section>

  <section>
    <h2>Features on no journey</h2>
    <p class="lead">
      {#if gaps.featuresForNobody.length}
        {plural(gaps.featuresForNobody.length, "feature")} with scenarios that touch
        no persona's journey: either a persona is missing a station, or the feature
        serves someone we have not written down.
      {:else}
        Every feature with scenarios sits on some persona's journey.
      {/if}
    </p>
    <ul class="list">
      {#each gaps.featuresForNobody as f (f.id)}
        <li>
          <a href={links.feature(f)}>{f.name}</a>
          <span class="meta"
            >{SURFACE_TITLE[f.surface]}, {plural(
              f.scenarios.length,
              "scenario",
            )}</span
          >
        </li>
      {/each}
    </ul>
  </section>

  <section>
    <h2>Surface on no journey</h2>
    <p class="lead">
      {plural(gaps.unclaimed.length, "surface item")} (API operations, pages, CLI
      flags, docs pages) that no station on any journey touches. The large ones are
      the signal for a persona we have not thought of; the rest are the edges of the
      product nobody is promised.
    </p>
    <p><a href={links.orphans}>See them on the map</a></p>
  </section>
</main>

<style>
  .page {
    padding: 28px 20px 48px;
  }
  .statement {
    margin: 0 0 10px;
    max-width: 24ch;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 34px;
    line-height: 1.08;
    letter-spacing: -0.01em;
  }
  .ways {
    margin: 0 0 28px;
    font-size: 15px;
  }
  a {
    color: var(--accent);
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
  section {
    max-width: 70ch;
    margin-bottom: 40px;
  }
  h2 {
    margin: 0 0 6px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 650;
    font-size: 22px;
  }
  .lead {
    margin: 0 0 10px;
    color: var(--ink-2);
    line-height: 1.5;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .list li {
    padding: 8px 0;
    border-top: 1px solid var(--rule);
    font-size: 15px;
  }
  .list li a {
    font-weight: 600;
  }
  .meta {
    display: block;
    font-size: 13px;
    color: var(--ink-3);
  }
  .list p {
    margin: 4px 0 0;
    color: var(--ink-2);
    font-size: 14px;
  }
  @container (min-width: 1024px) {
    .page {
      padding: 36px 40px 64px;
    }
    .statement {
      font-size: 43px;
    }
    .lead {
      font-size: 15px;
    }
  }
</style>
