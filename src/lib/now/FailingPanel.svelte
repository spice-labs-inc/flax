<script lang="ts">
  import { ENV_LABEL, type Env, byEnv, ENVS } from "$lib/data.ts";
  import type { NowCard } from "$lib/now.ts";
  import type { Model } from "$lib/model.ts";
  import type { Route } from "$lib/location.ts";
  import { format } from "$lib/location.ts";
  import { hrefOf } from "$lib/nav.ts";
  import Hex from "$lib/shell/Hex.svelte";
  import ErrorFold from "./ErrorFold.svelte";
  import {
    cardBlocks,
    cardBuilds,
    envList,
    kindLines,
    sentence,
  } from "./copy.ts";

  let {
    card,
    model,
    route,
    groupMessage,
  }: {
    card: NowCard;
    model: Model;
    route: Route;
    /** The error a group of cards shares and shows once, so the card leaves it out. */
    groupMessage?: string;
  } = $props();

  let first = $derived(card.envs[0]!);
  let scenarioHref = $derived(
    hrefOf(
      format(
        {
          view: "map",
          scenario: card.scenario.id,
          ...(first.stepNo ? { step: first.stepNo } : {}),
          env: route.env,
          snap: route.snap,
          lens: "all",
        },
        model,
      ),
    ),
  );
  let featureHref = $derived(
    card.feature
      ? hrefOf(
          format(
            {
              view: "features",
              feature: `${card.feature.surface}/${card.feature.stem}`,
              env: route.env,
              snap: route.snap,
              lens: "all",
            },
            model,
          ),
        )
      : undefined,
  );
  let states = $derived(
    byEnv((e) => model.scenarioState(card.scenario, e, route.snap).kind),
  );
  let hexLabel = $derived(
    ENVS.map((e) => `${ENV_LABEL[e]} ${states[e]}`).join(", "),
  );
  let shotOf = $derived(card.envs.find((f) => f.shot));
  let shot = $derived(shotOf?.shot ? model.shots[shotOf.shot] : undefined);
  let kinds = $derived(kindLines(card.envs));
  let blocks = $derived(cardBlocks(card.envs));
  let builds = $derived(cardBuilds(card.envs));
  /** Each distinct error with the envs it came from, but the one the group already shows. */
  let errors = $derived.by(() => {
    const out: { message: string; more: string; envs: Env[] }[] = [];
    for (const f of card.envs) {
      if (!f.message || f.message === groupMessage) continue;
      const e = out.find((x) => x.message === f.message);
      if (e) e.envs.push(f.env);
      else out.push({ message: f.message, more: f.more, envs: [f.env] });
    }
    return out;
  });
  let inGroup = $derived(groupMessage !== undefined);
  let blocksNothing = $derived(
    card.envs.every((f) => !f.blocks.stations.length),
  );
</script>

<article class="panel" class:withShot={!!shot} class:inGroup>
  <div class="text">
    <p class="feature">
      <Hex {states} size={14} label={hexLabel} />
      {#if card.feature && featureHref}
        <a href={featureHref}>{card.feature.name}</a>
      {:else}
        <span>{card.scenario.feature}</span>
      {/if}
      <span class="env">fails on {envList(card.envs.map((f) => f.env))}</span>
    </p>
    <p class="name">
      <a href={scenarioHref}>{sentence(card.scenario.name)}</a>
    </p>
    {#each kinds as k (k.kind)}
      <p class="kind">
        <b class="badge {k.kind}">{k.label}</b>
        {k.texts.join(" ")}
      </p>
    {/each}
    {#each blocks as b, i (i)}
      <p class="blocks" class:nothing={blocksNothing}>{b}</p>
    {/each}
    <p class="step"><span class="lbl">Failed step</span> {first.step}</p>
    {#each errors as e (e.envs.join())}
      {#if card.envs.length > 1 && (errors.length > 1 || inGroup)}
        <p class="errenv">On {envList(e.envs)}:</p>
      {/if}
      <ErrorFold message={e.message} more={e.more} />
    {/each}
    {#each builds as b, i (i)}
      <p class="since">{b}</p>
    {/each}
  </div>
  {#if shot && shotOf}
    <a class="shot" href={scenarioHref}>
      <img
        src={shot}
        alt={`Screenshot where ${sentence(card.scenario.name)} failed in ${ENV_LABEL[shotOf.env]}`}
        loading="lazy"
      />
    </a>
  {/if}
</article>

<style>
  .panel {
    background: var(--panel);
    border-radius: 10px;
    padding: 16px 18px;
    margin: 0 0 12px;
    max-width: 90ch;
    display: grid;
    gap: 14px 20px;
    grid-template-columns: minmax(0, 1fr);
  }
  .text {
    min-width: 0;
  }
  p {
    margin: 0;
  }
  .feature {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 650;
    font-size: 17.5px;
    line-height: 1.2;
  }
  .feature a {
    color: var(--ink);
    text-decoration: none;
  }
  .feature a:hover {
    text-decoration: underline;
  }
  .feature .env {
    font-family: var(--text);
    font-stretch: normal;
    font-weight: 400;
    font-size: 14px;
    color: var(--ink-2);
  }
  .name {
    margin-top: 6px;
    font-family: "Newsreader", serif;
    font-style: italic;
    font-optical-sizing: auto;
    font-size: 22px;
    line-height: 1.25;
    max-width: 60ch;
  }
  .name a {
    color: var(--ink);
    text-decoration: none;
  }
  .name a:hover {
    text-decoration: underline;
    text-decoration-color: var(--accent);
  }
  .step {
    margin-top: 10px;
    max-width: 70ch;
  }
  .lbl {
    color: var(--ink-3);
    margin-right: 4px;
  }
  .kind {
    margin-top: 10px;
    max-width: 75ch;
  }
  .badge {
    display: inline-block;
    margin-right: 4px;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 12.5px;
    font-weight: 650;
    color: var(--fail);
    background: color-mix(in srgb, var(--fail) 12%, transparent);
  }
  .badge.intermittent,
  .badge.once {
    color: var(--ink);
    background: color-mix(in srgb, var(--ink-3) 18%, transparent);
  }
  .badge.new {
    color: var(--ink);
    background: color-mix(in srgb, var(--planned) 22%, transparent);
  }
  .blocks {
    margin-top: 8px;
    max-width: 75ch;
    font-weight: 600;
  }
  .blocks.nothing {
    font-weight: 400;
    color: var(--ink-2);
  }
  .errenv {
    margin-top: 8px;
    color: var(--ink-3);
  }
  .panel.inGroup {
    background: transparent;
    border-top: 1px solid var(--rule);
    border-radius: 0;
    padding: 14px 0 0;
    margin: 14px 0 0;
  }
  .since {
    margin-top: 10px;
    color: var(--ink-2);
  }
  .shot {
    display: block;
    width: 100%;
    max-width: 220px;
    border-radius: var(--r-s);
    overflow: hidden;
    border: 1px solid var(--rule);
    align-self: start;
  }
  .shot img {
    display: block;
    width: 100%;
    height: auto;
  }
  @container (min-width: 700px) {
    .panel.withShot {
      grid-template-columns: minmax(0, 1fr) 220px;
    }
  }
</style>
