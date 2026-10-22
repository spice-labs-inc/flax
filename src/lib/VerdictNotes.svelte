<script lang="ts">
  import { homesOf, type EnvChoice, type Item } from "./data.ts";
  import type { Model } from "./model.ts";
  import { inPage, type Dest, type Nav } from "./nav.ts";
  import { asOfText, type LaterFailure } from "./verdict.ts";

  let {
    model,
    item,
    env,
    snap,
    nav,
  }: {
    model: Model;
    item: Item;
    env: EnvChoice;
    snap: number;
    nav: Nav;
  } = $props();

  let rows = $derived(
    homesOf(item).flatMap((h) => {
      if (env !== "all" && h.env !== env) return [];
      const v = model.verdict(item, h.env, snap);
      const age = v.stale ? asOfText(v, h.env, model.runGaps[h.env]) : "";
      return v.laterFailed.length || v.reason || age ? [{ ...h, v, age }] : [];
    }),
  );

  const dest = (f: LaterFailure): Dest => ({
    view: "map",
    itemId: item.id,
    scenario: f.scenario.id,
    ...(f.step ? { step: f.step } : {}),
  });
</script>

{#if rows.length}
  <ul class="notes">
    {#each rows as r (r.env)}
      <li class:muted={r.v.laterFailed.length > 0}>
        <b>{r.label}</b>
        {#if r.v.laterFailed.length}
          Verified here; a later step of {#each r.v.laterFailed as f, i (f.scenario.id)}{i
              ? i === r.v.laterFailed.length - 1
                ? " and "
                : ", "
              : ""}<a
              href={nav.href(dest(f))}
              onclick={(e) => inPage(e) && nav.go(dest(f))}>{f.scenario.name}</a
            >{/each} failed.
        {/if}
        {#if r.v.reason}{r.v.reason}{/if}
        {#if r.age}{r.age}{/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .notes {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: grid;
    gap: 4px;
    font-size: 12.5px;
    color: var(--ink-2);
  }
  .notes b {
    color: var(--ink);
    font-weight: 600;
    margin-right: 2px;
  }
  .muted {
    color: var(--ink-3);
  }
  a {
    color: var(--accent);
  }
</style>
