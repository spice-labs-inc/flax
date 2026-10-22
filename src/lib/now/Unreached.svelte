<script lang="ts">
  import Mark from "$lib/Mark.svelte";
  import { ENV_LABEL } from "$lib/data.ts";
  import { reachClause } from "$lib/failureKind.ts";
  import { format, type Route } from "$lib/location.ts";
  import type { Model } from "$lib/model.ts";
  import { hrefOf } from "$lib/nav.ts";
  import type { Unreached } from "$lib/now.ts";
  import ErrorFold from "./ErrorFold.svelte";
  import { sentence } from "./copy.ts";

  let {
    unreached,
    model,
    route,
  }: { unreached: Unreached; model: Model; route: Route } = $props();

  /** The most common way the runs could not reach the env. */
  let clause = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const f of unreached.failing) {
      const c = reachClause(`${f.message}\n${f.more}`);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  });
  let n = $derived(unreached.failing.length);
  let first = $derived(unreached.failing[0]!);
  const href = (id: string) =>
    hrefOf(
      format(
        {
          view: "map",
          scenario: id,
          env: route.env,
          snap: route.snap,
          lens: "all",
        },
        model,
      ),
    );
</script>

<section
  class="unreached"
  aria-label="Could not reach {ENV_LABEL[unreached.env]}"
>
  <p class="head">
    <span class="mark"><Mark kind="other" size={16} /></span>
    <span>
      <b>Could not reach {ENV_LABEL[unreached.env]}.</b>
      {n === 1 ? "1 scenario" : `${n} scenarios`} failed before
      {n === 1 ? "it" : "they"} reached {ENV_LABEL[unreached.env]}: {clause}.
    </span>
  </p>
  <ErrorFold message={first.message} more={first.more} hollow />
  <details class="list">
    <summary>{n === 1 ? "The scenario" : `The ${n} scenarios`}</summary>
    <ul>
      {#each unreached.failing as f (f.scenario.id)}
        <li><a href={href(f.scenario.id)}>{sentence(f.scenario.name)}</a></li>
      {/each}
    </ul>
  </details>
</section>

<style>
  .unreached {
    padding: 12px 16px;
    margin: 0 0 12px;
    max-width: 90ch;
    border: 1.5px dashed var(--land-edge);
    border-radius: 10px;
  }
  p {
    margin: 0;
  }
  .head {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .mark {
    line-height: 0;
    position: relative;
    top: 2px;
  }
  .list {
    margin-top: 8px;
    color: var(--ink-2);
  }
  summary {
    cursor: pointer;
  }
  ul {
    margin: 6px 0 0;
    padding-left: 18px;
    display: grid;
    gap: 3px;
  }
  a {
    color: var(--ink);
  }
</style>
