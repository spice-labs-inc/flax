<script lang="ts">
  import Mark from "./Mark.svelte";
  import {
    CODE_COLOR,
    CODE_LABEL,
    ELSEWHERE,
    ENV_LABEL,
    ENVS,
    ENV_ORDER,
    envsProse,
    type EnvChoice,
    type Item,
  } from "./data.ts";
  import type { JourneyFocus } from "./Journeys.svelte";
  import { STATE_LABEL, TYPE_LABEL, type Station } from "./personas.ts";
  import { inPage, type Dest, type Nav } from "./nav.ts";
  import type { ScenarioDetail } from "./scenarios.ts";
  import type { Model } from "./model.ts";
  import { countOf } from "./features/catalog.ts";

  let {
    model,
    focus,
    env,
    snap,
    onfocus,
    nav,
    onitem,
    onorphans,
  }: {
    model: Model;
    focus: JourneyFocus;
    env: EnvChoice;
    snap: number;
    onfocus: (f: JourneyFocus) => void;
    nav: Nav;
    onitem: (it: Item) => void;
    onorphans: () => void;
  } = $props();
  let {
    items,
    status,
    surfaces,
    orphans,
    personas,
    stationState,
    dataset,
    defById,
    personaDefs,
    scenarioState,
    itemDetails,
  } = $derived(model);
  let negatives = $derived(personaDefs.filter((d) => d.type === "negative"));
  const nameOf = (id: string) =>
    defById.get(id)?.name ?? personas.find((p) => p.id === id)?.name ?? id;

  let titles = $derived(new Map(surfaces.map((s) => [s.island, s.title])));
  function goPersona(id: string) {
    const o = personas.find((x) => x.id === id);
    if (o) onfocus({ kind: "persona", persona: o });
  }
  /** Every scenario any run recorded touching one of the station's items, by name. */
  const stationScenarios = (st: Station): ScenarioDetail[] =>
    [...new Set(st.items.flatMap(itemDetails))].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  const scenarioDest = (d: ScenarioDetail): Dest => ({
    view: "map",
    scenario: d.id,
  });

  const alsoOn = (f: JourneyFocus) =>
    f.kind === "station"
      ? personas.filter(
          (p) => p !== f.persona && p.stations.includes(f.station),
        )
      : [];
</script>

{#snippet list(title: string, xs: string[] | undefined)}
  {#if xs?.length}
    <section>
      <p class="label">{title}</p>
      <ul>
        {#each xs as x, i (i)}<li>{x}</li>{/each}
      </ul>
    </section>
  {/if}
{/snippet}

{#snippet itemRow(it: Item)}
  {@const codes = status[snap]![it.idx]!}
  <button class="row" type="button" onclick={() => onitem(it)}>
    <span class="name">{it.label}<small>{titles.get(it.island)}</small></span>
    <span class="dots">
      {#each ENV_ORDER as e (e)}
        {@const i = ENVS.indexOf(e)}
        {@const code = codes[i]!}
        <i
          class:never={code === -1}
          style:background={CODE_COLOR[code]}
          title="{ENV_LABEL[ENVS[i]!]}: {CODE_LABEL[code]}"
        ></i>
      {/each}
    </span>
  </button>
{/snippet}

<aside class="side" aria-live="polite">
  {#if focus.kind === "none"}
    <section>
      <h2>Persona journeys</h2>
      <p class="sub">
        Each persona is a line; each station is a step of their journey,
        verified through the surface items behind it.
      </p>
      <p class="note">
        A failing station blocks every journey that passes through it. Stations
        for features not built yet show as dashed rings; behavior verified
        elsewhere shows as a diamond.
      </p>
      <p class="note">
        Personas, stations and journeys come from the workspace dataset at
        commit <code>{dataset.commit.slice(0, 7)}</code>. Each station names the
        surface items that prove it.
      </p>
    </section>
    {#if negatives.length}
      <section>
        <p class="label">Not designed for (negative personas)</p>
        {#each negatives as n (n.id)}
          <p class="note"><b>{n.name}</b>: {n.summary ?? ""}</p>
        {/each}
      </section>
    {/if}
    <section>
      <p class="label">Personas</p>
      <div class="rows">
        {#each personas as p (p.id)}
          <button
            class="row"
            type="button"
            onclick={() => onfocus({ kind: "persona", persona: p })}
            ><span class="name"
              >{p.name}<small>{p.def.journey.name}</small></span
            ></button
          >
        {/each}
      </div>
    </section>
  {:else if focus.kind === "persona"}
    {@const p = focus.persona}
    {@const d = p.def}
    <section>
      <h2>{p.name}</h2>
      <p class="sub">{TYPE_LABEL[p.type]}</p>
      <p class="lead">{d.summary}</p>
      {#if d.who}<p class="note">{d.who}</p>{/if}
      {#if d.titles.length}<p class="note">
          <b>Titles, for example:</b>
          {d.titles.join(", ")}
        </p>{/if}
    </section>
    {#if d.prize?.quote || d.prize?.test}
      <section class="prize">
        <p class="label">Prize</p>
        {#if d.prize.quote}<blockquote>{d.prize.quote}</blockquote>{/if}
        {#if d.prize.test}<p class="note">
            <b>The proof:</b>
            {d.prize.test}
          </p>{/if}
      </section>
    {/if}
    {@render list("Goals", d.goals)}
    {@render list("Needs", d.needs)}
    {#if d.consumes}
      <section>
        <p class="label">How they take in information</p>
        <p class="note">{d.consumes}</p>
      </section>
    {/if}
    {@render list("Friction", d.friction)}
    {@render list("What would make them walk away", d.antiGoals)}
    <section>
      <p class="label">Where they work</p>
      <dl class="kv">
        <dt>Touches</dt>
        <dd>{d.surfaces.join(", ")}</dd>
        {#if d.neverTouches.length}<dt>Never touches</dt>
          <dd>{d.neverTouches.join(", ")}</dd>{/if}
        {#if d.editions.length}<dt>Editions</dt>
          <dd>{d.editions.join(", ")}</dd>{/if}
        {#if d.fixtureRole}<dt>Scenarios sign in as</dt>
          <dd>{d.fixtureRole}</dd>{/if}
      </dl>
    </section>
    {@const forPersona = items.filter(
      (it) =>
        it.planned?.kind === "issue" && it.planned.personas.includes(p.id),
    )}
    {#if forPersona.length}
      <section>
        <p class="label">Open issues for features they need</p>
        <div class="rows">
          {#each forPersona as it (it.id)}
            <button class="row" type="button" onclick={() => onitem(it)}
              ><span class="name"
                >{it.label}<small
                  >{titles.get(it.island)}{it.planned?.kind === "issue"
                    ? `, ${it.planned.board}`
                    : ""}</small
                ></span
              ></button
            >
          {/each}
        </div>
      </section>
    {/if}
    {#if d.tensions.length}
      <section>
        <p class="label">Tensions with other personas</p>
        {#each d.tensions as t, i (i)}
          <div class="tension">
            <button type="button" class="link" onclick={() => goPersona(t.with)}
              >{nameOf(t.with)}</button
            >
            <p class="note">{t.conflict}</p>
            <p class="note"><b>Rule:</b> {t.rule}</p>
          </div>
        {/each}
      </section>
    {/if}
    {#if d.evidence.length}
      <section>
        <p class="label">Evidence</p>
        <ul class="evidence">
          {#each d.evidence as e, i (i)}
            <li class:assumption={e.assumption}>
              {e.claim}<small
                >{e.assumption
                  ? "Assumption, not yet confirmed by a customer conversation"
                  : e.source}{e.date ? ", " + e.date : ""}</small
              >
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    <section>
      <p class="label">Journey: {d.journey.name}</p>
      <div class="rows">
        {#each p.stations as s (s.key)}
          {@const st = stationState(s, snap, env)}
          <button
            class="row"
            type="button"
            onclick={() => onfocus({ kind: "station", station: s, persona: p })}
          >
            <span class="name"
              >{s.name}<small
                >{s.stage}, {countOf(s.items.length, "item")}</small
              ></span
            >
            <span class="state {st}">{STATE_LABEL[st]}</span>
          </button>
        {/each}
      </div>
    </section>
  {:else if focus.kind === "station"}
    {@const s = focus.station}
    {@const st = stationState(s, snap, env)}
    <section>
      <h2>{s.name}</h2>
      <p class="sub">{focus.persona.name}, {s.stage}</p>
      <p class="note"><span class="state {st}">{STATE_LABEL[st]}</span></p>
      {#if s.kind === "planned"}
        <p class="note">
          No surface item proves this step yet: the feature does not exist. It
          becomes a planned scenario, not a silent gap.
        </p>
      {:else if s.kind === "elsewhere"}
        <p class="note">
          {ELSEWHERE}. The scenario library does not repeat that work.
        </p>
      {/if}
      {#if alsoOn(focus).length}
        <p class="note">
          <b>Also on this station:</b>
          {alsoOn(focus)
            .map((p) => p.name)
            .join(", ")}
        </p>
      {/if}
    </section>
    {@const scen = stationScenarios(s)}
    {#if scen.length}
      <section>
        <p class="label">Scenarios that prove it</p>
        <div class="rows">
          {#each scen as d (d.id)}
            <a
              class="row"
              href={nav.href(scenarioDest(d))}
              data-return="station-scenario:{d.id}"
              onclick={(e) =>
                inPage(e) &&
                nav.go(scenarioDest(d), { focus: `station-scenario:${d.id}` })}
            >
              <span class="name">{d.name}<small>{d.feature}</small></span>
              <span class="marks">
                {#each ENV_ORDER as e (e)}
                  {@const st = scenarioState(d, e, snap)}
                  <span title="{ENV_LABEL[e]}: {st.label}"
                    ><Mark kind={st.kind} size={13} /><span class="sr"
                      >{ENV_LABEL[e]}: {st.label}</span
                    ></span
                  >
                {/each}
              </span>
            </a>
          {/each}
        </div>
        <p class="note">
          Each scenario's latest result at this point: {envsProse(
            undefined,
            true,
          )}.
        </p>
      </section>
    {:else if s.kind === "surface"}
      <section>
        <p class="label">Scenarios that prove it</p>
        <p class="note">None yet: no scenario touches the items behind it.</p>
      </section>
    {/if}
    {#if s.items.length}
      <section>
        <p class="label">Surface items behind this step</p>
        <div class="rows">
          {#each s.items as it (it.id)}
            {@render itemRow(it)}
          {/each}
        </div>
      </section>
    {/if}
  {:else}
    <section>
      <h2>No persona</h2>
      <p class="sub">
        {orphans.length} surface items are on no persona's journey
      </p>
      <p class="note">
        Each is either missing from a journey, or surface nobody needs. Both are
        worth a decision.
      </p>
      <button class="cta" type="button" onclick={onorphans}
        >Show them on the map</button
      >
    </section>
    <section>
      <p class="label">Items</p>
      <div class="rows">
        {#each orphans.slice(0, 300) as it (it.id)}
          {@render itemRow(it)}
        {/each}
      </div>
      {#if orphans.length > 300}
        <p class="note">
          And {orphans.length - 300} more; the map shows them all.
        </p>
      {/if}
    </section>
  {/if}
</aside>

<style>
  .side {
    border-left: 1px solid var(--rule);
    background: var(--panel);
    height: 100%;
    box-sizing: border-box;
    overflow: auto;
    padding: 18px 18px 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  section + section {
    border-top: 1px solid var(--rule);
    padding-top: 16px;
  }
  h2 {
    margin: 0 0 2px;
    font-family: var(--display);
    font-stretch: 112%;
    font-size: 18px;
    font-weight: 700;
    text-wrap: balance;
  }
  .sub {
    color: var(--ink-2);
    font-size: 13px;
    margin: 0;
  }
  .note {
    font-size: 12.5px;
    color: var(--ink-2);
    margin: 8px 0 0;
  }
  .label {
    font-size: 12px;
    color: var(--ink-3);
    margin: 0 0 4px;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row {
    appearance: none;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    width: calc(100% + 16px);
    padding: 7px 8px;
    margin: 0 -8px;
    border-radius: var(--r-s);
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 10px;
    align-items: center;
    cursor: pointer;
  }
  .row:hover {
    background: var(--ground-2);
  }
  a.row {
    text-decoration: none;
    box-sizing: border-box;
  }
  .marks {
    display: inline-flex;
    gap: 3px;
    align-items: center;
  }
  .marks > span {
    display: inline-flex;
  }
  .name {
    min-width: 0;
    overflow-wrap: anywhere;
    display: flex;
    flex-direction: column;
  }
  small {
    color: var(--ink-3);
    font-size: 11.5px;
  }
  .dots {
    display: inline-flex;
    gap: 4px;
  }
  .dots i {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    display: inline-block;
  }
  .dots i.never {
    border: 1px dashed var(--land-edge);
    box-sizing: border-box;
  }
  .state {
    font-size: 12px;
    color: var(--ink-2);
    text-align: right;
  }
  .state.pass {
    color: var(--pass);
  }
  .state.fail {
    color: var(--fail);
    font-weight: 600;
  }
  .state.planned {
    color: var(--planned);
  }
  .lead {
    font-size: 14px;
    margin: 10px 0 0;
    text-wrap: pretty;
  }
  ul {
    margin: 0;
    padding-left: 18px;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .prize blockquote {
    margin: 0;
    font-family: Newsreader, Georgia, serif;
    font-style: italic;
    font-size: 17px;
    line-height: 1.35;
    text-wrap: balance;
  }
  .kv {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 12px;
    font-size: 12.5px;
    margin: 0;
  }
  .kv dt {
    color: var(--ink-3);
  }
  .kv dd {
    margin: 0;
  }
  .tension + .tension {
    margin-top: 12px;
  }
  .link {
    appearance: none;
    border: 0;
    background: transparent;
    padding: 0;
    font: inherit;
    font-weight: 600;
    color: var(--accent);
    cursor: pointer;
  }
  .evidence small {
    display: block;
    color: var(--ink-3);
  }
  .evidence li.assumption {
    color: var(--ink-2);
    font-style: italic;
  }
  .cta {
    margin-top: 12px;
    appearance: none;
    border: 0;
    background: var(--accent);
    color: var(--panel);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    padding: 7px 12px;
    border-radius: var(--r-s);
    cursor: pointer;
  }
  @media (max-width: 860px) {
    .side {
      border-left: 0;
      border-top: 1px solid var(--rule);
      height: auto;
      overflow: visible;
    }
  }
</style>
