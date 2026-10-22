<script lang="ts">
  import { capped, countOf } from "$lib/features/catalog.ts";
  import { live } from "$lib/live.svelte.ts";
  import { format, type Route } from "$lib/location.ts";
  import type { Model } from "$lib/model.ts";
  import { hrefOf } from "$lib/nav.ts";
  import { USE_WORDS, usedBy, type UseRow } from "$lib/usage.ts";

  let { model, route }: { model: Model; route: Route } = $props();

  let has = $derived(!!model.usage || !!live.usage);
  let used = $derived(model.usedNotVerified(route.snap, live.usage));
  let reached = $derived(model.reachedByOurRuns(route.snap, live.usage));
  const SHOWN = 8;
  let usedOpen = $state(false);
  let reachedOpen = $state(false);
  let usedShown = $derived(capped(used, usedOpen, SHOWN));
  let reachedShown = $derived(capped(reached, reachedOpen, SHOWN));

  const itemHref = (id: string) =>
    hrefOf(
      format(
        {
          view: "map",
          itemId: id,
          env: route.env,
          snap: route.snap,
          lens: "all",
        },
        model,
      ),
    );
</script>

{#snippet rows(
  list: { shown: readonly UseRow[]; hidden: number },
  open: () => void,
  who: boolean,
)}
  <ul>
    {#each list.shown as r (r.item.id)}
      <li>
        <a href={itemHref(r.item.id)}>{r.item.label}</a>
        <span class="why"
          >{who ? `${usedBy(r.use)} ` : ""}{USE_WORDS.envLabel}: {r.verdict.label.toLowerCase()}.</span
        >
      </li>
    {/each}
  </ul>
  {#if list.hidden}
    <button class="more" type="button" onclick={open}>
      Show the other {countOf(list.hidden, "item")}
    </button>
  {/if}
{/snippet}

{#if has}
  <section aria-label={USE_WORDS.usedHeading}>
    <h3>{USE_WORDS.usedHeading}</h3>
    {#if used.length}
      <p class="lead">
        {USE_WORDS.usedLead(countOf(used.length, "item"), used.length === 1)}
      </p>
      {@render rows(usedShown, () => (usedOpen = true), true)}
    {:else}
      <p class="lead">{USE_WORDS.allVerified}</p>
    {/if}
  </section>
  {#if reached.length}
    <section aria-label={USE_WORDS.reachedHeading}>
      <h3>{USE_WORDS.reachedHeading}</h3>
      <p class="lead">
        {USE_WORDS.reachedLead(
          countOf(reached.length, "item"),
          reached.length === 1,
        )}
      </p>
      {@render rows(reachedShown, () => (reachedOpen = true), false)}
    </section>
  {/if}
{/if}

<style>
  section + section {
    margin-top: 20px;
  }
  h3 {
    margin: 0 0 6px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 650;
    font-size: 17.5px;
  }
  .lead {
    margin: 0 0 10px;
    color: var(--ink-2);
    max-width: 75ch;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
    max-width: 90ch;
  }
  a {
    color: var(--ink);
    font-weight: 600;
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  a:hover {
    text-decoration: underline;
  }
  .why {
    display: block;
    color: var(--ink-2);
    font-size: 13px;
  }
  .more {
    margin-top: 10px;
    font: inherit;
    font-size: 13px;
    color: var(--accent);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
</style>
