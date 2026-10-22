<script lang="ts">
  import type { Model } from "$lib/model.ts";
  import { hrefOf } from "$lib/nav.ts";
  import Mark from "$lib/Mark.svelte";
  import {
    glossaryRuns,
    glossarySections,
    PROJECT_SECTION,
  } from "$lib/glossary.ts";
  import {
    CONFIG,
    ELSEWHERE,
    ENVS,
    envLabel,
    envsProse,
    PIPELINE,
    REFERENCE_ENV,
  } from "$lib/data.ts";

  let { model }: { model: Model } = $props();
  let surfaceNames = $derived(model.surfaces.map((s) => s.title).join(", "));
  const reference = envLabel(REFERENCE_ENV).toLowerCase();
  const hexOrder =
    ENVS.length === 1
      ? `the whole hex is ${reference}`
      : `${envLabel(REFERENCE_ENV)} on top, then ${envsProse(PIPELINE)} clockwise`;
  const pipelineProse = PIPELINE.length
    ? `${envsProse(PIPELINE)} ${PIPELINE.length === 1 ? "follows" : "follow"} as the way to ${reference}.`
    : "";
  const editionTitles = CONFIG.vocabulary.editions.map(
    (e) => CONFIG.vocabulary.editionTitles[e] ?? e,
  );
  const editionsProse = editionTitles.length
    ? `: ${editionTitles.length === 1 ? editionTitles[0] : `${editionTitles.slice(0, -1).join(", ")} and ${editionTitles[editionTitles.length - 1]}`}`
    : "";
  const HEADINGS = ["Product", "People", "Marks"];
  const own = glossarySections(CONFIG.glossary, HEADINGS);
</script>

{#snippet entries(section: string)}
  {#each own[section] ?? [] as entry (entry.term)}
    <dt>{entry.term}</dt>
    <dd>
      {#each glossaryRuns(entry.text) as run, i (i)}
        {#if "href" in run}
          <a href={run.href}>{run.text}</a>
        {:else}
          {run.text}
        {/if}
      {/each}
    </dd>
  {/each}
{/snippet}

<main class="page">
  <p class="statement">Glossary</p>

  <section>
    <h2>Product</h2>
    <dl>
      <dt>Surface</dt>
      <dd>
        A place a customer touches the product. There are {model.surfaces
          .length}: {surfaceNames}. On the <a href={hrefOf("/map")}>map</a> a surface
        is an island.
      </dd>
      <dt>Item</dt>
      <dd>
        One thing a customer can touch on a surface: a dashboard page, an API
        operation, a CLI command, a docs page, an email. On the map an item is a
        hex. Each hex shows its state in every environment: {hexOrder}.
      </dd>
      <dt>Part</dt>
      <dd>
        An item inside another item: an option of a command, a button in an
        email, an element on a page. An item that holds parts opens as a map of
        its own.
      </dd>
      <dt>Feature</dt>
      <dd>
        A group of items on one surface that belong together, such as Teams on
        the Public API or Sign in and sign up on the Dashboard. The map names a
        feature on its island, and the <a href={hrefOf("/features")}>Features</a
        > door lists scenarios by feature.
      </dd>
      <dt>Scenario</dt>
      <dd>
        One check that exercises some items in an environment, such as "Every
        page of the documentation loads". A scenario's latest run is what makes
        an item verified or failing. A planned scenario is written and waiting
        to run. The <a href={hrefOf("/now")}>Now</a> door shows the latest runs.
      </dd>
      <dt>Environment</dt>
      <dd>
        Where a scenario runs: {envsProse(undefined, true)}. A surface with a
        single home, such as a public website, is the same everywhere instead.
        The switch in the top bar narrows every page to one environment.
      </dd>
      <dt>Verified</dt>
      <dd>
        An item is verified in an environment when the steps that reach it
        succeeded in the newest run there. Failing means the step that reached
        it failed. No scenario yet means no scenario reaches it.
      </dd>
      <dt>Counts</dt>
      <dd>
        Every count names what it counts and where, {reference} first: "159 of 312
        items verified on {reference}" counts the items that exist on {reference}.
        {pipelineProse} A persona counts its journey's stations the same way, and
        a station verified elsewhere is not counted as verified here.
      </dd>
      <dt>Planned</dt>
      <dd>
        An open Engineering Board issue for a feature not built yet, drawn as a
        dotted hex. The <a href={hrefOf("/planned")}>Planned</a> door lists them with
        the personas they serve.
      </dd>
      <dt>Edition</dt>
      <dd>
        A licensed variant of the product{editionsProse}. The same command
        appears once per edition that offers it, named by its edition.
      </dd>
      {@render entries("Product")}
    </dl>
  </section>

  <section>
    <h2>People</h2>
    <dl>
      <dt>Persona</dt>
      <dd>
        A person we build for, with a brief: who they are, what they want, how
        they would know the product worked. {model.personas.length} of them have a
        journey. The <a href={hrefOf("/personas")}>Personas</a> door lists them.
      </dd>
      <dt>Journey</dt>
      <dd>
        That persona's path through the product, in order. It is the line on the
        Personas door.
      </dd>
      <dt>Station</dt>
      <dd>
        One step on a journey, such as "Install the CLI". A station names the
        items that prove it, so its state comes from their scenarios. A persona
        is blocked at the first station that fails.
      </dd>
      <dt>Stage</dt>
      <dd>
        Which part of the customer's path a station belongs to: Discover, Start,
        Survey, Understand, Act, Prove. The columns of the stage table.
      </dd>
      <dt>No persona</dt>
      <dd>
        Items no journey names yet. They are real and may be verified, but
        nobody's path runs through them.
      </dd>
      {@render entries("People")}
    </dl>
  </section>

  <section>
    <h2>Marks</h2>
    <dl class="marks">
      <dt><Mark kind="pass" size={14} /></dt>
      <dd>Verified</dd>
      <dt><Mark kind="partial" size={14} /></dt>
      <dd>Partly verified: some of the station's items are verified</dd>
      <dt><Mark kind="fail" size={14} /></dt>
      <dd>Failing</dd>
      <dt><Mark kind="unchecked" size={14} /></dt>
      <dd>
        Not checked here: scenarios reach it in another environment, but none
        checks it in this one, and its panel says why. On the map its face is
        hatched.
      </dd>
      <dt><Mark kind="none" size={14} /></dt>
      <dd>No scenario yet</dd>
      <dt><Mark kind="planned" size={14} /></dt>
      <dd>Feature not built yet</dd>
      <dt><Mark kind="elsewhere" size={14} /></dt>
      <dd>{ELSEWHERE}, rather than here</dd>
      {@render entries("Marks")}
    </dl>
  </section>

  {#if own[PROJECT_SECTION]?.length}
    <section>
      <h2>{PROJECT_SECTION}</h2>
      <dl>
        {@render entries(PROJECT_SECTION)}
      </dl>
    </section>
  {/if}
</main>

<style>
  .page {
    padding: 28px 20px 48px;
  }
  .statement {
    margin: 0 0 10px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 34px;
    line-height: 1.08;
    letter-spacing: -0.01em;
  }
  section {
    margin: 0 0 32px;
  }
  h2 {
    margin: 0 0 12px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 21px;
  }
  dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 62ch);
    gap: 12px 24px;
    margin: 0;
  }
  dt {
    font-weight: 600;
  }
  dd {
    margin: 0;
    color: var(--ink-2);
    line-height: 1.45;
  }
  dd a {
    color: var(--accent);
  }
  .marks {
    gap: 8px 14px;
  }
  .marks dt {
    display: flex;
    align-items: center;
    min-height: 1.45em;
  }
  @media (max-width: 640px) {
    dl {
      grid-template-columns: 1fr;
      gap: 4px 0;
    }
    dd {
      margin-bottom: 10px;
    }
    .marks {
      grid-template-columns: max-content 1fr;
      gap: 8px 14px;
    }
  }
</style>
