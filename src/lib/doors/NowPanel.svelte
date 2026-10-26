<script lang="ts">
  import { ENV_LABEL, formatPacific } from "$lib/data.ts";
  import type { Route } from "$lib/location.ts";
  import type { Model } from "$lib/model.ts";
  import ErrorFold from "$lib/now/ErrorFold.svelte";
  import FailingPanel from "$lib/now/FailingPanel.svelte";
  import Flips from "$lib/now/Flips.svelte";
  import InUse from "$lib/now/InUse.svelte";
  import Statement from "$lib/now/Statement.svelte";
  import Unreached from "$lib/now/Unreached.svelte";
  import { USAGE_ON } from "$lib/usage.ts";
  import { gapWords } from "$lib/verdict.ts";

  let { model, route }: { model: Model; route: Route } = $props();
  const ref = Date.now();

  let view = $derived(model.nowView(route.snap, route.env));
</script>

<div class="panel">
  {#each view.envs as e (e.env)}
    {@const age = model.runAge(e.env, route.snap, ref)}
    <section class="env" aria-label={ENV_LABEL[e.env]}>
      <Statement now={e} {ref} />
      {#if age?.overdue && age.gap !== undefined}
        <p class="overdue">
          {ENV_LABEL[e.env]} is overdue: it usually runs every {gapWords(
            age.gap,
          )}, and its newest run finished {formatPacific(age.last)}.
        </p>
      {/if}
    </section>
  {/each}
  {#if view.unreached.length || view.groups.length}
    <section class="failing" aria-label="Failing scenarios">
      {#each view.unreached as u (u.env)}
        <Unreached unreached={u} {model} {route} />
      {/each}
      {#each view.groups as g (g.cards[0]!.scenario.id)}
        {#if g.cards.length > 1}
          <section
            class="group"
            aria-label="Scenarios failing with the same error"
          >
            <p class="ghead">
              {g.cards.length} scenarios fail with the same error.
            </p>
            <ErrorFold message={g.message} more={g.cards[0]!.envs[0]!.more} />
            {#each g.cards as c (c.scenario.id)}
              <FailingPanel card={c} {model} {route} groupMessage={g.message} />
            {/each}
          </section>
        {:else}
          <FailingPanel card={g.cards[0]!} {model} {route} />
        {/if}
      {/each}
    </section>
  {/if}
  {#each view.envs as e (e.env)}
    {#if e.broke.length || e.fixed.length}
      <section class="flips" aria-label="Changes on {ENV_LABEL[e.env]}">
        <Flips now={e} {model} {route} />
      </section>
    {/if}
  {/each}
  {#if USAGE_ON}
    <div class="use"><InUse {model} {route} /></div>
  {/if}
</div>

<style>
  .panel {
    padding: 18px 20px 24px;
    font-size: 14px;
    line-height: 1.5;
    display: grid;
    gap: 28px;
  }
  .group {
    background: var(--panel);
    border-radius: 10px;
    padding: 16px 18px;
    margin: 0 0 12px;
    max-width: 90ch;
  }
  .ghead {
    margin: 0;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 650;
    font-size: 17.5px;
  }
  .overdue {
    margin: -14px 0 0;
    font-weight: 600;
    color: var(--fail);
  }
</style>
