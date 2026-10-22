<script lang="ts">
  import { byEnv, ENV_LABEL, ENV_ORDER, type Env } from "$lib/data.ts";
  import {
    featureKey,
    LOCAL_LABEL,
    SURFACE_TITLE,
    type Feature,
    type FeatureScenario,
  } from "$lib/features.ts";
  import { format, type Route } from "$lib/location.ts";
  import Mark from "$lib/Mark.svelte";
  import type { MarkKind } from "$lib/data.ts";
  import type { Model } from "$lib/model.ts";
  import { hrefOf } from "$lib/nav.ts";
  import { live } from "$lib/live.svelte.ts";
  import Hex from "$lib/shell/Hex.svelte";
  import type { HexStates } from "$lib/data.ts";
  import {
    capped,
    countOf,
    issueRef,
    neighbors,
    paragraphs,
    plannedNote,
    rowLabel,
    scenarioBlocks,
  } from "./catalog.ts";
  import Steps from "./Steps.svelte";

  let {
    feature: f,
    model,
    route,
  }: { feature: Feature; model: Model; route: Route } = $props();

  let paras = $derived(paragraphs(f.description));
  /** The environments on show: all three, or the one the switch narrows to. */
  let envs = $derived(
    route.env === "all" ? ENV_ORDER : ENV_ORDER.filter((e) => e === route.env),
  );
  let stands = $derived(
    envs.map((e) => ({ env: e, ...model.featureState(f, e, route.snap) })),
  );
  let use = $derived(model.featureLine(f.items, live.usage, live.clock));
  let blocks = $derived(scenarioBlocks(f.scenarios));
  let around = $derived(neighbors(model.featureGroups, f));
  let bugs = $derived(model.featureBugs(f));
  let issues = $derived(
    model
      .featureIssues(f)
      .flatMap((it) =>
        it.planned?.kind === "issue" ? [{ item: it, planned: it.planned }] : [],
      ),
  );
  let itemsOpen = $state(false);
  let items = $derived(capped(f.items, itemsOpen));

  const base = () => ({
    env: route.env,
    snap: route.snap,
    lens: "all" as const,
  });
  let surfaceHref = $derived(
    hrefOf(format({ view: "features", surface: f.surface, ...base() }, model)),
  );
  let allHref = $derived(
    hrefOf(format({ view: "features", ...base() }, model)),
  );
  let gapsHref = $derived(
    hrefOf(format({ view: "personas", gaps: true, ...base() }, model)),
  );
  const scenarioHref = (id: string) =>
    hrefOf(format({ view: "map", scenario: id, ...base() }, model));
  const itemHref = (id: string) =>
    hrefOf(format({ view: "map", itemId: id, ...base() }, model));
  const personaHref = (id: string) =>
    hrefOf(format({ view: "personas", persona: id, ...base() }, model));

  const everywhere = (kind: MarkKind): HexStates => byEnv(() => kind);

  function hexOf(s: FeatureScenario): { states: HexStates; label: string } {
    const d = s.detail;
    if (s.planned) return plannedNote(s.id, model.items);
    if (s.local) return { states: everywhere("never"), label: LOCAL_LABEL };
    if (!d) return { states: everywhere("none"), label: "No run yet" };
    const per = ENV_ORDER.map((e) => model.scenarioState(d, e, route.snap));
    const states = Object.fromEntries(
      ENV_ORDER.map((e, i): [Env, MarkKind] => [e, per[i]!.kind]),
    ) as HexStates;
    const label = ENV_ORDER.flatMap((e, i) =>
      envs.includes(e) ? [`${ENV_LABEL[e]}: ${per[i]!.label}`] : [],
    ).join(", ");
    return { states, label };
  }
  const featureHref = (other: Feature) =>
    hrefOf(
      format(
        { view: "features", feature: featureKey(other), ...base() },
        model,
      ),
    );
  const personaName = (id: string) =>
    model.personaDefs.find((p) => p.id === id)?.name ?? id;
</script>

<main class="feature">
  <header class="head">
    <p class="up">
      <a href={surfaceHref}>{SURFACE_TITLE[f.surface]}</a>
      {#if f.area !== f.surface && f.area !== f.stem}
        <span class="area">{f.area.replaceAll("-", " ")}</span>
      {/if}
    </p>
    <h1>{f.name}</h1>
    <div class="desc">
      {#each paras as p, i (i)}
        <p>{p}</p>
      {/each}
    </div>
  </header>

  <section class="stands">
    <h2>Where it stands</h2>
    <ul>
      {#if f.local}
        <li>
          <Mark kind="never" size={14} />
          <span>{LOCAL_LABEL}.</span>
        </li>
      {:else}
        {#each stands as s (s.env)}
          <li>
            <Mark kind={s.kind} size={14} />
            <span><b>{ENV_LABEL[s.env]}</b> {s.label}.</span>
          </li>
        {/each}
      {/if}
    </ul>
    {#if use}
      <p class="use">{use}</p>
    {/if}
  </section>

  {#snippet glyph(s: FeatureScenario)}
    {@const hex = hexOf(s)}
    {#if route.env === "all"}
      <Hex states={hex.states} size={16} label={hex.label} />
    {:else}
      <span class="one" role="img" aria-label={hex.label}
        ><Mark kind={hex.states[route.env]} size={14} /></span
      >
    {/if}
  {/snippet}

  {#snippet note(s: FeatureScenario)}
    {#if s.planned || (!s.detail && !s.local)}
      <p class="note">{hexOf(s).label}</p>
    {/if}
  {/snippet}

  <section class="scenarios">
    <h2>What proves it</h2>
    {#if !f.scenarios.length}
      <p class="muted">No scenario is written for this feature yet.</p>
    {/if}
    <ol>
      {#each blocks as b (b.kind === "one" ? b.scenario.id : `outline:${b.line}`)}
        {#if b.kind === "one"}
          {@const s = b.scenario}
          <li>
            <p class="name">
              {@render glyph(s)}
              <a href={scenarioHref(s.id)}>{s.name}</a>
            </p>
            {@render note(s)}
            {#if s.detail?.steps.length}
              <details>
                <summary>Read the steps</summary>
                <Steps steps={s.detail.steps} />
              </details>
            {/if}
          </li>
        {:else}
          {@const first = b.rows.find((r) => r.detail?.steps.length)}
          <li>
            <p class="name outline">{b.name}</p>
            <p class="rowcount">
              Checked once for each of {countOf(b.rows.length, "case")}:
            </p>
            <ul class="rows">
              {#each b.rows as s (s.id)}
                <li>
                  <p class="row">
                    {@render glyph(s)}
                    <a href={scenarioHref(s.id)}>{rowLabel(s)}</a>
                  </p>
                  {@render note(s)}
                </li>
              {/each}
            </ul>
            {#if first?.detail}
              <details>
                <summary>Read the steps for "{rowLabel(first)}"</summary>
                <Steps steps={first.detail.steps} />
              </details>
            {/if}
          </li>
        {/if}
      {/each}
    </ol>
  </section>

  <section class="touches">
    <h2>What it touches</h2>
    {#if f.items.length}
      <p class="muted">
        {countOf(f.items.length, "surface item")} a run recorded these scenarios using.
      </p>
      <ul class="items">
        {#each items.shown as it (it.id)}
          <li><a href={itemHref(it.id)}>{it.label}</a></li>
        {/each}
      </ul>
      {#if items.hidden}
        <button class="more" type="button" onclick={() => (itemsOpen = true)}>
          Show the other {countOf(items.hidden, "item")}
        </button>
      {/if}
    {:else}
      <p class="muted">No run has recorded what these scenarios touch yet.</p>
    {/if}
  </section>

  <section class="personas">
    <h2>Who needs it</h2>
    {#if model.everyoneSignedIn(f.personas)}
      <p class="muted">Every persona who signs in.</p>
    {:else if f.personas.length}
      <ul>
        {#each f.personas as p (p.id)}
          <li>
            <a href={personaHref(p.id)}>{p.name}</a>
            <span class="muted">{p.def.summary}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">
        <a href={gapsHref}
          >No persona's journey passes through this feature yet</a
        >.
      </p>
    {/if}
  </section>

  {#if bugs.length}
    <section class="bugs">
      <h2>Open bugs</h2>
      <p class="muted">Filed against {SURFACE_TITLE[f.surface]}.</p>
      <ul>
        {#each bugs as b (b.id)}
          <li>
            <a href={b.url} target="_blank" rel="noreferrer">{b.label}</a>
            <span class="ref">{issueRef(b.id)}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if issues.length}
    <section class="planned">
      <h2>Planned</h2>
      <ul>
        {#each issues as { item, planned } (item.id)}
          <li>
            <a href={planned.url} target="_blank" rel="noreferrer"
              >{item.label}</a
            >
            <span class="ref">{issueRef(item.id)}</span>
            <span class="muted">
              {planned.board}{#if planned.personas.length}, for
                {planned.personas.map(personaName).join(" and ")}{/if}
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <nav class="around" aria-label="Features nearby">
    {#if around.prev}
      <a class="prev" href={featureHref(around.prev)}>
        <span class="muted">Before this</span>
        {around.prev.name}
      </a>
    {/if}
    {#if around.next}
      <a class="next" href={featureHref(around.next)}>
        <span class="muted">After this</span>
        {around.next.name}
      </a>
    {/if}
    <a class="all" href={allHref}>All features</a>
  </nav>
</main>

<style>
  .feature {
    padding: 28px 20px 48px;
  }
  .head,
  section,
  .around {
    max-width: 70ch;
  }
  .up {
    margin: 0 0 8px;
    display: flex;
    gap: 10px;
    font-size: 14px;
  }
  .up a {
    color: var(--accent);
    text-decoration: none;
  }
  .up a:hover {
    text-decoration: underline;
  }
  .area {
    color: var(--ink-3);
  }
  h1 {
    margin: 0 0 12px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 27px;
    line-height: 1.05;
    letter-spacing: -0.01em;
  }
  .desc p {
    margin: 0 0 8px;
    font-family: "Newsreader", serif;
    font-style: italic;
    font-optical-sizing: auto;
    font-size: 19px;
    line-height: 1.45;
  }
  section {
    margin-top: 32px;
  }
  h2 {
    margin: 0 0 10px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 650;
    font-size: 22px;
    line-height: 1.15;
  }
  ul,
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .stands li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
  }
  .stands b {
    font-weight: 600;
    margin-right: 2px;
  }
  .use {
    margin: 10px 0 0;
    max-width: 75ch;
  }
  .scenarios li {
    padding: 8px 0;
  }
  .scenarios li + li {
    border-top: 1px solid var(--rule);
  }
  .name {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0;
    font-family: "Newsreader", serif;
    font-style: italic;
    font-optical-sizing: auto;
    font-size: 17.5px;
    line-height: 1.4;
  }
  .name a {
    color: var(--ink);
    text-decoration: none;
  }
  .name a:hover,
  .row a:hover {
    color: var(--accent);
  }
  .one {
    display: inline-flex;
    align-self: center;
  }
  .rowcount {
    margin: 2px 0 4px 26px;
    color: var(--ink-2);
    font-size: 14px;
  }
  .rows {
    margin-left: 26px;
  }
  .scenarios .rows li {
    padding: 2px 0;
    border: 0;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0;
    font-size: 15px;
    line-height: 1.4;
  }
  .row a {
    color: var(--ink);
    text-decoration: none;
    padding: 3px 0;
  }
  .rows .note {
    margin-left: 26px;
  }
  .note {
    margin: 2px 0 0 26px;
    color: var(--planned);
    font-size: 14px;
  }
  details {
    margin: 4px 0 0 26px;
  }
  summary {
    cursor: pointer;
    color: var(--ink-2);
    font-size: 14px;
    padding: 6px 0;
    list-style: none;
    width: fit-content;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary::before {
    content: "";
    display: inline-block;
    width: 6px;
    height: 6px;
    margin: 0 8px 1px 0;
    border-right: 1.5px solid var(--ink-3);
    border-bottom: 1.5px solid var(--ink-3);
    transform: rotate(-45deg);
    transition: transform 150ms ease;
  }
  details[open] > summary::before {
    transform: rotate(45deg);
  }
  @media (prefers-reduced-motion: reduce) {
    summary::before {
      transition: none;
    }
  }
  details[open] > summary {
    margin-bottom: 4px;
  }
  .muted {
    color: var(--ink-2);
  }
  p.muted {
    margin: 0 0 8px;
  }
  .items {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 14px;
  }
  .items a,
  .personas a,
  .bugs a,
  .planned a,
  .muted a {
    color: var(--accent);
    text-decoration: none;
    display: inline-block;
    padding: 4px 0;
  }
  .items a:hover,
  .personas a:hover,
  .bugs a:hover,
  .planned a:hover,
  .muted a:hover {
    text-decoration: underline;
  }
  .more {
    margin-top: 6px;
    font: inherit;
    color: var(--accent);
    background: none;
    border: 0;
    padding: 8px 0;
    cursor: pointer;
  }
  .more:hover {
    text-decoration: underline;
  }
  .personas li,
  .bugs li,
  .planned li {
    padding: 4px 0;
  }
  .personas li .muted {
    display: block;
  }
  .ref {
    color: var(--ink-3);
    margin-left: 8px;
    font-size: 14px;
  }
  .planned .muted {
    display: block;
    font-size: 14px;
  }
  .around {
    margin-top: 40px;
    padding-top: 16px;
    border-top: 1px solid var(--rule);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 24px;
  }
  .around a {
    color: var(--ink);
    text-decoration: none;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 650;
    font-size: 17.5px;
    line-height: 1.2;
    padding: 4px 0;
  }
  .around a:hover {
    color: var(--accent);
  }
  .around .muted {
    display: block;
    font: inherit;
    font-family: var(--text);
    font-stretch: normal;
    font-weight: 400;
    font-size: 14px;
  }
  .prev {
    grid-column: 1;
  }
  .next {
    grid-column: 2;
    text-align: right;
  }
  .all {
    grid-column: 1 / -1;
    font-family: var(--text);
    font-stretch: normal;
    font-weight: 400;
    font-size: 14px;
    color: var(--accent);
  }
  @container (min-width: 1024px) {
    .feature {
      padding: 36px 40px 64px;
      font-size: 15px;
      line-height: 1.55;
    }
    h1 {
      font-size: 43px;
    }
    .desc p {
      font-size: 22px;
    }
  }
</style>
