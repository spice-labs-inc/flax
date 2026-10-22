<script lang="ts">
  import { waitsOn, type PlannedScenario } from "./planned.ts";

  let {
    scenario,
    feature,
    surface,
  }: {
    scenario: PlannedScenario;
    /** The feature file the scenario is written in, when the catalog has it. */
    feature?: { name: string; href: string };
    /** The surface in product words, when the list mixes surfaces. */
    surface?: string;
  } = $props();
</script>

<li class="row">
  <p class="name">
    {scenario.label}
    {#if surface}<span class="surface">{surface}</span>{/if}
  </p>
  <p class="meta">
    {#if feature}
      In <a href={feature.href}>{feature.name}</a>.
    {:else}
      In {scenario.feature}.
    {/if}
    {waitsOn(scenario.waitingOn)}
  </p>
</li>

<style>
  .row {
    padding: 12px 0 12px 26px;
    border-top: 1px solid var(--rule);
  }
  p {
    margin: 0;
  }
  .name {
    font-family: "Newsreader", serif;
    font-style: italic;
    font-optical-sizing: auto;
    font-size: 19px;
    line-height: 1.35;
    color: var(--ink);
  }
  .surface {
    font-family: var(--text);
    font-style: normal;
    font-size: 14px;
    color: var(--ink-3);
    margin-left: 6px;
  }
  .meta {
    margin-top: 3px;
    color: var(--ink-2);
    line-height: 1.6;
    max-width: 70ch;
  }
  a {
    color: var(--ink);
    text-decoration: underline;
    text-decoration-color: var(--rule);
    text-underline-offset: 3px;
    padding: 4px 0;
  }
  a:hover {
    color: var(--accent);
    text-decoration-color: var(--accent);
  }
  @container (max-width: 1023px) {
    .row {
      padding-left: 0;
    }
  }
</style>
