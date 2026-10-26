<script lang="ts">
  import { ENV_LABEL, byEnv } from "$lib/data.ts";
  import type { EnvNow, Flip } from "$lib/now.ts";
  import type { Model } from "$lib/model.ts";
  import { format, type Route } from "$lib/location.ts";
  import { hrefOf } from "$lib/nav.ts";
  import Hex from "$lib/shell/Hex.svelte";
  import { sentence } from "./copy.ts";

  let { now, model, route }: { now: EnvNow; model: Model; route: Route } =
    $props();

  const scenarioHref = (f: Flip) =>
    hrefOf(
      format(
        {
          view: "map",
          scenario: f.scenario.id,
          env: route.env,
          snap: route.snap,
          lens: "all",
        },
        model,
      ),
    );
  const statesOf = (f: Flip) =>
    byEnv((e) => model.scenarioState(f.scenario, e, route.snap).kind);
</script>

{#snippet flips(list: Flip[], title: string)}
  {#if list.length}
    <h3>{title}</h3>
    <ul>
      {#each list as f (f.scenario.id)}
        <li>
          <Hex states={statesOf(f)} size={14} />
          <span>
            <a href={scenarioHref(f)}>{sentence(f.scenario.name)}</a>
            {#if f.feature}
              <span class="feat">{f.feature.name}</span>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{@render flips(now.broke, `Broke in the latest ${ENV_LABEL[now.env]} run`)}
{@render flips(now.fixed, `Fixed in the latest ${ENV_LABEL[now.env]} run`)}

<style>
  h3 {
    margin: 14px 0 6px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 650;
    font-size: 15px;
    color: var(--ink-2);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  li {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  a {
    color: var(--ink);
    font-family: "Newsreader", serif;
    font-style: italic;
    font-optical-sizing: auto;
    font-size: 15.5px;
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
  .feat {
    display: block;
    color: var(--ink-3);
    font-size: 12.5px;
  }
</style>
