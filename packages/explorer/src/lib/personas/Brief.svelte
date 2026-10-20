<script lang="ts">
  import type { Feature } from "$lib/features.ts";
  import type { Route } from "$lib/location.ts";
  import type { Model } from "$lib/model.ts";
  import { STAGES, STATE_LABEL, TYPE_LABEL } from "$lib/personas.ts";
  import type { PersonaDef } from "$lib/personaDefs.ts";
  import type { StationCoverage } from "$lib/planning.ts";
  import type { ScenarioDetail } from "$lib/scenarios.ts";
  import Hex from "$lib/shell/Hex.svelte";
  import Mark from "$lib/Mark.svelte";
  import {
    cellTitle,
    editionName,
    groupByStage,
    hexLabel,
    isHttp,
    plural,
  } from "./copy.ts";
  import { personaLinks } from "./links.ts";
  import { stationParts, stationsSentence } from "$lib/counts.ts";
  import { ELSEWHERE, ENV_LABEL } from "$lib/data.ts";

  let { model, route }: { model: Model; route: Route } = $props();

  let links = $derived(personaLinks(route, model));
  let def = $derived(
    route.persona ? model.defById.get(route.persona) : undefined,
  );
  let persona = $derived(model.personas.find((p) => p.id === route.persona));
  let cov = $derived(
    persona ? model.personaCoverage(persona, route.snap, route.env) : undefined,
  );
  let groups = $derived(cov ? groupByStage(cov.stations) : []);
  /** This persona's row of the journey matrix: one mark per stage, the worst of its stations there. */
  let stages = $derived(
    persona
      ? (model
          .matrix(route.snap, route.env)
          .find((row) => row[0]?.persona === persona) ?? [])
      : [],
  );

  /** Every persona page in reading order: journeys first, then the rest of the files, the negatives last. */
  let order = $derived.by((): PersonaDef[] => {
    const seen = new Set(model.personas.map((p) => p.id));
    const rest = model.personaDefs.filter((d) => !seen.has(d.id));
    return [
      ...model.personas.map((p) => p.def),
      ...rest.filter((d) => d.type !== "negative"),
      ...rest.filter((d) => d.type === "negative"),
    ];
  });
  let at = $derived(order.findIndex((d) => d.id === def?.id));
  let prev = $derived(at > 0 ? order[at - 1] : undefined);
  let next = $derived(at >= 0 ? order[at + 1] : undefined);

  /** The plan against reality reads each station in the env the count leads with, so its lists and the count agree. */
  const leadState = (s: StationCoverage) => (cov ? s.byEnv[cov.lead] : s.state);
  let exists = $derived(
    cov?.stations.filter((s) => leadState(s) === "pass") ?? [],
  );
  let edition = $derived(
    cov?.stations.filter((s) => leadState(s) === "elsewhere") ?? [],
  );
  let shaky = $derived(
    cov?.stations.filter(
      (s) => leadState(s) === "fail" || leadState(s) === "partial",
    ) ?? [],
  );
  let missing = $derived(
    cov?.stations.filter(
      (s) => leadState(s) === "none" || leadState(s) === "unchecked",
    ) ?? [],
  );
  let waiting = $derived(
    cov?.stations.filter((s) => leadState(s) === "planned") ?? [],
  );
  let planned = $derived(cov?.planned ?? []);

  const nameOf = (id: string) => model.defById.get(id)?.name ?? id;
  const stationId = (key: string) => `station-${key}`;

  /** A station's scenarios under the feature each belongs to, in the order the station lists them. */
  const byFeature = (list: ScenarioDetail[]) => {
    const groups: { feature?: Feature; scenarios: ScenarioDetail[] }[] = [];
    for (const d of list) {
      const feature = model.featureOf(d.id);
      const g = groups.find((x) => x.feature === feature);
      if (g) g.scenarios.push(d);
      else groups.push({ ...(feature ? { feature } : {}), scenarios: [d] });
    }
    return groups;
  };

  $effect(() => {
    if (!route.station || !cov) return;
    const el = document.getElementById(stationId(route.station));
    if (!el) return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  });
</script>

{#snippet proof(groups: { feature?: Feature; scenarios: ScenarioDetail[] }[])}
  <ul class="features">
    {#each groups as g, i (g.feature?.id ?? i)}
      <li>
        {#if g.feature}
          <a href={links.feature(g.feature)}>{g.feature.name}</a>
        {:else}
          <span class="meta">Scenarios without a feature file</span>
        {/if}
        <ul class="scenarios">
          {#each g.scenarios as d (d.id)}
            <li><a href={links.scenario(d.id)}>{d.name}</a></li>
          {/each}
        </ul>
      </li>
    {/each}
  </ul>
{/snippet}

{#if !def}
  <main class="page">
    <p class="statement">No persona called {route.persona}.</p>
    <p><a href={links.overview}>All personas</a></p>
  </main>
{:else}
  <main class="page">
    <div class="columns">
      <article class="brief">
        <header>
          <h1>{def.name}</h1>
          <p class="type">{TYPE_LABEL[def.type]}</p>
          {#if stages.length}
            <ol class="stages">
              {#each stages as cell, i (cell.stage)}
                {@const first = cell.stations[0]}
                {@const title = cellTitle(
                  def.name,
                  cell.stage,
                  cell.stations.map((st) => ({
                    station: st,
                    state: model.stationState(st, route.snap, route.env),
                  })),
                )}
                <li>
                  <span class="stage"
                    ><span class="num">{i + 1}</span>{cell.stage}</span
                  >
                  {#if cell.state !== "empty" && first}
                    <a
                      class="cell"
                      href={links.persona(def.id, first.key)}
                      {title}
                      aria-label={title}><Mark kind={cell.state} size={16} /></a
                    >
                  {:else}
                    <span class="cell empty" {title} aria-label={title}></span>
                  {/if}
                </li>
              {/each}
            </ol>
          {/if}
          <p class="summary">{def.summary}</p>
          <blockquote class="prize">
            {def.prize.quote ?? def.prize.test}
          </blockquote>
          {#if def.prize.quote}
            <p class="test">
              <span class="label">The proof:</span>
              {def.prize.test}
            </p>
          {/if}
        </header>

        <dl class="facts">
          <dt>Who</dt>
          <dd>{def.who}</dd>
          {#if def.titles.length}
            <dt>Titles</dt>
            <dd>{def.titles.join(", ")}</dd>
          {/if}
          {#if def.goals.length}
            <dt>Goals</dt>
            <dd>
              <ul>
                {#each def.goals as g, i (i)}<li>{g}</li>{/each}
              </ul>
            </dd>
          {/if}
          {#if def.needs.length}
            <dt>Needs</dt>
            <dd>
              <ul>
                {#each def.needs as n, i (i)}<li>{n}</li>{/each}
              </ul>
            </dd>
          {/if}
          {#if def.consumes}
            <dt>Consumes</dt>
            <dd>{def.consumes}</dd>
          {/if}
          {#if def.friction.length}
            <dt>Friction</dt>
            <dd>
              <ul>
                {#each def.friction as f, i (i)}<li>{f}</li>{/each}
              </ul>
            </dd>
          {/if}
          {#if def.antiGoals.length}
            <dt>Anti-goals</dt>
            <dd>
              <ul>
                {#each def.antiGoals as a, i (i)}<li>{a}</li>{/each}
              </ul>
            </dd>
          {/if}
          {#if def.editions.length}
            <dt>Editions</dt>
            <dd>{def.editions.map(editionName).join(", ")}</dd>
          {/if}
          {#if def.surfaces.length}
            <dt>Surfaces</dt>
            <dd>{def.surfaces.join("; ")}</dd>
          {/if}
          {#if def.neverTouches.length}
            <dt>Never touches</dt>
            <dd>{def.neverTouches.join(", ")}</dd>
          {/if}
        </dl>

        <section id="journey">
          <h2>The journey</h2>
          {#if def.journey.steps.length}
            <h3 class="journey-name">{def.journey.name}</h3>
            <ol class="narrative">
              {#each def.journey.steps as step, i (i)}<li>{step}</li>{/each}
            </ol>
          {/if}
          {#if !cov}
            <p class="quiet">No journey written for this persona yet.</p>
          {:else}
            {#each groups as g (g.start)}
              <h3 class="stage">
                <span class="stage-num">{STAGES.indexOf(g.stage) + 1}</span
                >{g.stage}
              </h3>
              <ol class="stations" start={g.start}>
                {#each g.stations as s (s.station.key)}
                  {@const current = route.station === s.station.key}
                  {@const proved = model.stationProof(
                    s.station,
                    route.snap,
                    route.env,
                  )}
                  {@const rest = s.scenarios.filter(
                    (d) => !proved?.rows.some((r) => r.scenario === d),
                  )}
                  <li
                    id={stationId(s.station.key)}
                    class="station"
                    class:current
                    aria-current={current ? "true" : undefined}
                  >
                    <div class="st-head">
                      <Hex
                        states={s.byEnv}
                        size={16}
                        label={hexLabel(s.station.name, s.byEnv)}
                      />
                      <span class="st-name">{s.station.name}</span>
                      <span class="st-state">{STATE_LABEL[s.state]}</span>
                    </div>
                    {#if s.pipeline}
                      <p class="pipeline">{s.pipeline}</p>
                    {/if}
                    {#if proved}
                      <p class="proved-head">
                        {route.env === "all" || proved.env !== route.env
                          ? `Proved on ${ENV_LABEL[proved.env].toLowerCase()} by`
                          : "Proved by"}
                      </p>
                      <ul class="proved">
                        {#each proved.rows as r (r.scenario.id)}
                          {@const f = model.featureOf(r.scenario.id)}
                          <li>
                            <a href={links.scenario(r.scenario.id)}
                              >{r.scenario.name}</a
                            >
                            <span class="meta"
                              >{r.step
                                ? `Step ${r.step.n}: ${r.step.text}. `
                                : ""}{#if f}<a href={links.feature(f)}
                                  >{f.name}</a
                                >.{/if}</span
                            >
                          </li>
                        {/each}
                      </ul>
                    {/if}
                    {#if rest.length}
                      <details class="proof">
                        <summary
                          >Reached by {plural(
                            rest.length,
                            proved ? "more scenario" : "scenario",
                            proved ? "more scenarios" : "scenarios",
                          )} on the way</summary
                        >
                        {@render proof(byFeature(rest))}
                      </details>
                    {/if}
                    {#if s.planned.length}
                      <ul class="issues">
                        {#each s.planned as i (i.item.id)}
                          <li>
                            {i.item.label}
                            <span class="meta"
                              >{i.board},
                              <a href={i.url} target="_blank" rel="noreferrer"
                                >the issue</a
                              ></span
                            >
                          </li>
                        {/each}
                      </ul>
                    {/if}
                    {#if !s.scenarios.length && !s.planned.length && s.state !== "elsewhere"}
                      <p class="nothing">Nothing proves this yet.</p>
                    {/if}
                  </li>
                {/each}
              </ol>
            {/each}
            <p class="quiet">
              <a href={links.lines(def.id)}>Journey line</a>
            </p>
          {/if}
        </section>

        {#if cov}
          <section id="plan">
            <h2>Plan against reality</h2>
            <p class="quiet">
              {stationsSentence(cov.count, cov.planned.length)}
            </p>
            <div class="plan">
              <div>
                <h3>Verified</h3>
                {#if exists.length}
                  <ul>
                    {#each exists as s (s.station.key)}
                      <li>
                        <a href={links.persona(def.id, s.station.key)}
                          >{s.station.name}</a
                        >
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class="quiet">No station is verified yet.</p>
                {/if}
                {#if edition.length}
                  <p class="quiet">
                    {ELSEWHERE}, not counted here: {edition
                      .map((s) => s.station.name)
                      .join(", ")}.
                  </p>
                {/if}
              </div>
              <div>
                <h3>Failing or partly verified</h3>
                {#if shaky.length}
                  <ul>
                    {#each shaky as s (s.station.key)}
                      <li>
                        <a href={links.persona(def.id, s.station.key)}
                          >{s.station.name}</a
                        >
                        <span class="meta">{STATE_LABEL[leadState(s)]}</span>
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class="quiet">Nothing fails or is only partly verified.</p>
                {/if}
              </div>
              <div>
                <h3>Planned</h3>
                {#if planned.length || waiting.length}
                  <ul>
                    {#each waiting as s (s.station.key)}
                      <li>
                        <a href={links.persona(def.id, s.station.key)}
                          >{s.station.name}</a
                        >
                        <span class="meta">{STATE_LABEL[leadState(s)]}</span>
                      </li>
                    {/each}
                    {#each planned as i (i.item.id)}
                      <li>
                        {i.item.label}
                        <span class="meta"
                          >{i.board},
                          <a href={i.url} target="_blank" rel="noreferrer"
                            >the issue</a
                          ></span
                        >
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class="quiet">No board issue names this persona.</p>
                {/if}
              </div>
              <div>
                <h3>Not checked or no scenario</h3>
                {#if missing.length}
                  <ul>
                    {#each missing as s (s.station.key)}
                      <li>
                        <a href={links.persona(def.id, s.station.key)}
                          >{s.station.name}</a
                        >
                        <span class="meta">{STATE_LABEL[leadState(s)]}</span>
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class="quiet">Every station is checked by a scenario.</p>
                {/if}
              </div>
            </div>
          </section>
        {/if}

        {#if def.tensions.length}
          <section>
            <h2>Tensions</h2>
            <ul class="tensions">
              {#each def.tensions as t (t.with)}
                <li>
                  <p class="conflict">
                    With <a href={links.persona(t.with)}>{nameOf(t.with)}</a>:
                    {t.conflict}
                  </p>
                  <p class="rule">
                    <span class="label">The rule:</span>
                    {t.rule}
                  </p>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if def.evidence.length}
          <section>
            <h2>Evidence</h2>
            <ul class="evidence">
              {#each def.evidence as e, i (i)}
                <li>
                  <p>{e.claim}</p>
                  <span class="meta">
                    {e.source}, {e.date}{#if e.assumption}, still an assumption{/if}
                  </span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if def.sources.length}
          <section>
            <h2>Sources</h2>
            <ul class="sources">
              {#each def.sources as s, i (i)}
                <li>
                  {#if isHttp(s.where)}
                    <a href={s.where} target="_blank" rel="noreferrer"
                      >{s.title}</a
                    >
                  {:else}
                    {s.title}
                  {/if}
                  <span class="meta">{s.where}, {s.date}</span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <nav class="prevnext" aria-label="Other personas">
          {#if prev}
            <a href={links.persona(prev.id)}>Previous: {prev.name}</a>
          {/if}
          {#if next}
            <a href={links.persona(next.id)}>Next: {next.name}</a>
          {/if}
          <a href={links.overview}>All personas</a>
        </nav>
      </article>

      {#if cov}
        <aside class="rail" aria-label="On this page">
          <h2>Stations</h2>
          <ol class="rail-stations">
            {#each cov.stations as s (s.station.key)}
              <li>
                <a
                  href={links.persona(def.id, s.station.key)}
                  aria-current={route.station === s.station.key
                    ? "true"
                    : undefined}
                >
                  <Hex states={s.byEnv} size={12} />
                  {s.station.name}
                </a>
              </li>
            {/each}
          </ol>
          <h2><a href="#plan">Plan against reality</a></h2>
          <ul class="rail-counts">
            {#each stationParts(cov.count) as part, i (i)}
              <li>{part}</li>
            {/each}
            <li>{plural(planned.length, "issue")} planned</li>
          </ul>
        </aside>
      {/if}
    </div>
  </main>
{/if}

<style>
  .page {
    padding: 28px 20px 48px;
  }
  a {
    color: var(--accent);
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
  .statement {
    margin: 0 0 10px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 27px;
  }
  .brief {
    max-width: 70ch;
    min-width: 0;
  }
  h1 {
    margin: 0 0 4px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 34px;
    line-height: 1.05;
    letter-spacing: -0.01em;
  }
  .type {
    margin: 0 0 14px;
    font-size: 14px;
    color: var(--ink-3);
  }
  /* How far this persona gets, stage by stage, before the words. */
  .stages {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 0 4px;
    margin: 0 0 18px;
    padding: 0 0 10px;
    border-bottom: 1px solid var(--rule);
  }
  .stages li {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .stage {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-2);
    white-space: nowrap;
  }
  .stage .num {
    display: inline-block;
    margin-right: 3px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 14px;
    color: var(--ink);
  }
  .cell {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 30px;
    width: 100%;
    border-radius: var(--r-s);
  }
  a.cell:hover {
    background: var(--ground-2);
  }
  .summary {
    margin: 0 0 18px;
    font-size: 17.5px;
    line-height: 1.45;
    color: var(--ink-2);
  }
  .prize {
    margin: 0 0 12px;
    font-family: "Newsreader", serif;
    font-style: italic;
    font-optical-sizing: auto;
    font-size: 22px;
    line-height: 1.35;
    color: var(--ink);
  }
  .test {
    margin: 0 0 24px;
    font-size: 14px;
    color: var(--ink-2);
    line-height: 1.5;
  }
  .label {
    font-weight: 600;
    color: var(--ink);
  }
  .facts {
    margin: 0 0 40px;
    padding: 0;
    display: grid;
    grid-template-columns: 1fr;
    gap: 0;
    border-top: 1px solid var(--rule);
  }
  .facts dt {
    padding: 12px 0 2px;
    font-weight: 600;
    font-size: 13px;
    color: var(--ink-3);
  }
  .facts dd {
    margin: 0;
    padding: 0 0 12px;
    border-bottom: 1px solid var(--rule);
    line-height: 1.5;
  }
  .facts ul,
  .narrative,
  .plan ul,
  .tensions,
  .evidence,
  .sources,
  .scenarios,
  .issues,
  .rail-stations,
  .rail-counts {
    margin: 0;
    padding-left: 1.2em;
  }
  .facts li,
  .narrative li {
    margin: 2px 0;
  }
  section {
    margin-bottom: 40px;
  }
  h2 {
    margin: 0 0 10px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 650;
    font-size: 27px;
  }
  h3 {
    margin: 18px 0 6px;
    font-size: 15px;
    font-weight: 600;
  }
  .journey-name {
    margin-top: 0;
    font-family: "Newsreader", serif;
    font-style: italic;
    font-optical-sizing: auto;
    font-weight: 400;
    font-size: 17.5px;
  }
  .narrative {
    margin-bottom: 20px;
    color: var(--ink-2);
    line-height: 1.5;
  }
  .stage-num {
    display: inline-block;
    min-width: 1.4em;
    color: var(--ink);
  }
  .stage {
    margin: 22px 0 4px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 650;
    font-size: 17.5px;
    color: var(--ink-2);
  }
  .stations {
    margin: 0;
    padding-left: 2em;
  }
  .station {
    padding: 10px 12px 10px 6px;
    margin: 0 -12px 0 -6px;
    border-radius: var(--r-s);
    scroll-margin-top: 16px;
  }
  .station::marker {
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    color: var(--ink-3);
  }
  .station.current {
    background: var(--panel);
  }
  .st-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .st-name {
    font-weight: 600;
    font-size: 15px;
  }
  .st-state {
    font-size: 13px;
    color: var(--ink-2);
  }
  .proved-head {
    margin: 6px 0 0;
    font-size: 12.5px;
    color: var(--ink-3);
  }
  .proved {
    margin: 2px 0 0;
    padding: 0;
    list-style: none;
    font-size: 14px;
  }
  .proved li {
    margin: 3px 0;
  }
  .proved .meta {
    display: block;
    font-size: 12.5px;
  }
  .pipeline {
    margin: 4px 0 0;
    font-size: 13px;
    color: var(--ink-2);
  }
  .features {
    margin: 6px 0 0;
    padding: 0;
    list-style: none;
  }
  .features > li {
    margin: 4px 0;
    font-size: 14px;
  }
  .features > li > a {
    font-weight: 600;
  }
  .proof {
    margin-top: 4px;
  }
  .proof summary {
    cursor: pointer;
    color: var(--ink-2);
    font-size: 14px;
    padding: 4px 0;
  }
  .proof summary:hover {
    color: var(--ink);
  }
  .scenarios {
    margin-top: 2px;
    font-family: "Newsreader", serif;
    font-style: italic;
    font-optical-sizing: auto;
    font-size: 16px;
    line-height: 1.4;
  }
  .scenarios a {
    color: var(--ink);
  }
  .issues {
    margin-top: 4px;
    list-style: none;
    padding: 0;
  }
  .meta {
    font-size: 13px;
    color: var(--ink-3);
  }
  .nothing {
    margin: 4px 0 0;
    color: var(--ink-2);
  }
  .quiet {
    margin: 6px 0 0;
    color: var(--ink-2);
  }
  .plan {
    display: grid;
    grid-template-columns: 1fr;
    gap: 6px 28px;
  }
  .plan h3 {
    margin: 10px 0 4px;
  }
  .plan li {
    margin: 2px 0;
  }
  .tensions li,
  .evidence li,
  .sources li {
    margin: 0 0 12px;
  }
  .tensions p,
  .evidence p {
    margin: 0;
    line-height: 1.5;
  }
  .rule {
    color: var(--ink-2);
  }
  .prevnext {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 24px;
    padding-top: 16px;
    border-top: 1px solid var(--rule);
    font-size: 15px;
  }
  .rail {
    display: none;
  }
  @container (min-width: 640px) {
    .facts {
      grid-template-columns: 11ch minmax(0, 1fr);
    }
    .facts dt {
      padding: 12px 12px 12px 0;
      border-bottom: 1px solid var(--rule);
    }
    .facts dd {
      padding: 12px 0;
    }
    .plan {
      grid-template-columns: 1fr 1fr;
    }
  }
  @container (min-width: 1024px) {
    .page {
      padding: 36px 40px 64px;
      font-size: 15px;
      line-height: 1.55;
    }
    .columns {
      display: grid;
      grid-template-columns: minmax(0, 70ch) 260px;
      gap: 56px;
      align-items: start;
    }
    h1 {
      font-size: 54px;
    }
    .rail {
      display: block;
      position: sticky;
      top: 20px;
      font-size: 14px;
    }
    .rail h2 {
      font-size: 17.5px;
      margin: 0 0 8px;
    }
    .rail h2 a {
      color: var(--ink);
    }
    .rail-stations {
      list-style: none;
      padding: 0;
      margin: 0 0 24px;
    }
    .rail-stations a {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 8px;
      margin-left: -8px;
      border-radius: var(--r-s);
      color: var(--ink-2);
    }
    .rail-stations a:hover {
      color: var(--ink);
      background: var(--ground-2);
      text-decoration: none;
    }
    .rail-stations a[aria-current="true"] {
      color: var(--ink);
      background: var(--panel);
    }
    .rail-counts {
      list-style: none;
      padding: 0;
      color: var(--ink-2);
    }
  }
</style>
