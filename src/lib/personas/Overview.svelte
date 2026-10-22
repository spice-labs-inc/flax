<script lang="ts">
  import type { Route } from "$lib/location.ts";
  import Mark from "$lib/Mark.svelte";
  import type { Model } from "$lib/model.ts";
  import {
    STAGES,
    STATE_LABEL,
    TYPE_LABEL,
    type StationState,
  } from "$lib/personas.ts";
  import { ENV_LABEL, REFERENCE_ENV } from "$lib/data.ts";
  import { stationsSentence } from "$lib/counts.ts";
  import type { Block } from "$lib/planning.ts";
  import { cellTitle } from "./copy.ts";
  import { personaLinks } from "./links.ts";

  let { model, route }: { model: Model; route: Route } = $props();

  let links = $derived(personaLinks(route, model));
  let matrix = $derived(model.matrix(route.snap, route.env));
  let served = $derived(model.worstServed(route.snap, route.env));

  const BLOCK_HEAD: Partial<Record<StationState, string>> = {
    fail: "Blocked at",
    none: "Blocked at",
    planned: "Waiting at",
    unchecked: "Not checked at",
    partial: "Partly verified at",
  };
  const names = (xs: string[]) =>
    xs.length <= 1
      ? (xs[0] ?? "")
      : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  function reach(b: Block): string {
    if (b.personas.length <= 1) return "It blocks only this persona.";
    return `This gap blocks ${b.personas.length} personas: ${names(b.personas.map((p) => p.name))}.`;
  }
  let withJourney = $derived(new Set(model.personas.map((p) => p.id)));
  let unwritten = $derived(
    model.personaDefs.filter(
      (d) => d.type !== "negative" && !withJourney.has(d.id),
    ),
  );
  let negatives = $derived(
    model.personaDefs.filter((d) => d.type === "negative"),
  );

  const LEGEND_ORDER: StationState[] = [
    "pass",
    "partial",
    "fail",
    "none",
    "unchecked",
    "planned",
    "elsewhere",
    "never",
  ];
  let legend = $derived.by(() => {
    const present = new Set<StationState>();
    for (const row of matrix)
      for (const c of row) if (c.state !== "empty") present.add(c.state);
    return LEGEND_ORDER.filter((k) => present.has(k));
  });

  const cellStates = (cell: (typeof matrix)[number][number]) =>
    cell.stations.map((st) => ({
      station: st,
      state: model.stationState(st, route.snap, route.env),
    }));
</script>

<main class="page">
  <p class="statement">Personas</p>
  <p class="ways">
    <a href={links.lines()}>Journey lines</a>
    <a href={links.gaps}>Gaps</a>
  </p>

  <section class="ranked">
    <h2>Worst served first</h2>
    <p class="quiet">
      {route.env === "all"
        ? `Each persona is counted on ${ENV_LABEL[REFERENCE_ENV].toLowerCase()}, the customer's truth, or where its journey runs when that is not ${ENV_LABEL[REFERENCE_ENV].toLowerCase()}.`
        : `Each persona is counted on ${ENV_LABEL[route.env].toLowerCase()}.`}
    </p>
    <ol class="served">
      {#each served as s (s.coverage.persona.id)}
        {@const p = s.coverage.persona}
        {@const env = ENV_LABEL[s.coverage.lead].toLowerCase()}
        <li>
          <p class="who">
            <a href={links.persona(p.id)}>{p.name}</a>
            <span class="type">{TYPE_LABEL[p.type]}</span>
          </p>
          <p class="count">
            {stationsSentence(s.coverage.count, s.coverage.planned.length)}
          </p>
          {#if s.block}
            <p class="block">
              <span class="mark"><Mark kind={s.block.state} size={14} /></span>
              <span
                >{BLOCK_HEAD[s.block.state]}
                <a href={links.persona(p.id, s.block.station.key)}
                  >{s.block.station.name}</a
                >
                on {env}. {s.block.reason}
                {reach(s.block)}</span
              >
            </p>
          {:else if s.coverage.count.total}
            <p class="block">Nothing blocks it on {env}.</p>
          {/if}
        </li>
      {/each}
    </ol>
  </section>

  <div class="scroll">
    <table class="matrix">
      <thead>
        <tr>
          <th scope="col"><span class="sr">Persona</span></th>
          {#each STAGES as stage, i (stage)}
            <th scope="col"><span class="num">{i + 1}</span>{stage}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each matrix as row, r (row[0]?.persona.id ?? r)}
          {@const p = row[0]?.persona}
          {#if p}
            <tr>
              <th scope="row">
                <a href={links.persona(p.id)}>{p.name}</a>
                <span class="type">{TYPE_LABEL[p.type]}</span>
              </th>
              {#each row as cell (cell.stage)}
                <td>
                  {#if cell.state !== "empty" && cell.stations[0]}
                    {@const title = cellTitle(
                      p.name,
                      cell.stage,
                      cellStates(cell),
                    )}
                    <a
                      class="cell"
                      href={links.persona(p.id, cell.stations[0].key)}
                      {title}
                      aria-label={title}
                    >
                      <Mark kind={cell.state} size={16} />
                    </a>
                  {/if}
                </td>
              {/each}
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>

  <p class="legend">
    {#each legend as k (k)}
      <span class="key"><Mark kind={k} size={14} /> {STATE_LABEL[k]}</span>
    {/each}
    <span class="key"
      >An empty cell means the journey has no station at that stage.</span
    >
  </p>

  <section>
    <h2>No journey yet</h2>
    {#if unwritten.length}
      <ul class="defs">
        {#each unwritten as d (d.id)}
          <li>
            <a href={links.persona(d.id)}>{d.name}</a>
            <span class="type">{TYPE_LABEL[d.type]}</span>
            <p>{d.summary}</p>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="quiet">Every persona has a journey.</p>
    {/if}
  </section>

  <section>
    <h2>Not designed for</h2>
    <p class="quiet">Their needs stay off the plan.</p>
    <ul class="defs">
      {#each negatives as d (d.id)}
        <li>
          <a href={links.persona(d.id)}>{d.name}</a>
          <p>{d.summary}</p>
        </li>
      {/each}
    </ul>
  </section>
</main>

<style>
  .page {
    padding: 28px 20px 48px;
  }
  .statement {
    margin: 0 0 10px;
    max-width: 24ch;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 34px;
    line-height: 1.08;
    letter-spacing: -0.01em;
  }
  .ways {
    margin: 0 0 28px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 22px;
    font-size: 15px;
  }
  a {
    color: var(--accent);
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
  .scroll {
    overflow-x: auto;
    contain: inline-size;
    margin: 0 -20px;
    padding: 0 20px;
    -webkit-overflow-scrolling: touch;
  }
  .matrix {
    border-collapse: collapse;
    min-width: 640px;
    width: 100%;
    max-width: 1100px;
  }
  .matrix th,
  .matrix td {
    text-align: left;
    vertical-align: middle;
    border-bottom: 1px solid var(--rule);
  }
  .matrix thead th {
    padding: 0 8px 10px;
    font-size: 14px;
    font-weight: 600;
    color: var(--ink-2);
    white-space: nowrap;
  }
  .matrix thead th:first-child {
    padding-left: 0;
  }
  .num {
    display: inline-block;
    min-width: 1.4em;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 17.5px;
    color: var(--ink);
  }
  .matrix tbody th {
    padding: 10px 16px 10px 0;
    font-weight: 600;
    font-size: 15px;
    min-width: 200px;
    position: sticky;
    left: 0;
    background: var(--ground);
  }
  .matrix tbody th a {
    color: var(--ink);
  }
  .type {
    display: block;
    font-weight: 400;
    font-size: 13px;
    color: var(--ink-3);
  }
  .matrix td {
    padding: 0;
    width: 100px;
  }
  .cell {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    min-width: 44px;
    border-radius: var(--r-s);
  }
  .cell:hover {
    background: var(--ground-2);
  }
  @container (max-width: 640px) {
    .matrix {
      min-width: 0;
    }
    .matrix thead th {
      padding: 0 4px 8px;
      font-size: 12px;
      text-align: center;
    }
    .num {
      display: block;
      min-width: 0;
      font-size: 15px;
    }
    .matrix tbody th {
      min-width: 150px;
      padding-right: 8px;
      font-size: 14px;
    }
    .matrix td {
      width: 52px;
    }
    .cell {
      min-width: 40px;
    }
  }
  .legend {
    margin: 12px 0 32px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    font-size: 13px;
    color: var(--ink-2);
  }
  .key {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .served {
    list-style: none;
    margin: 0;
    padding: 0;
    counter-reset: served;
  }
  .served li {
    counter-increment: served;
    padding: 12px 0 12px 30px;
    border-top: 1px solid var(--rule);
    position: relative;
  }
  .served li::before {
    content: counter(served);
    position: absolute;
    left: 0;
    top: 11px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 18px;
    color: var(--ink-3);
  }
  .served p {
    margin: 0;
  }
  .who a {
    font-weight: 600;
    font-size: 15.5px;
    color: var(--ink);
  }
  .who .type {
    display: inline;
    margin-left: 6px;
  }
  .served .count {
    color: var(--ink-2);
    font-size: 14px;
    margin-top: 2px;
  }
  .served .block {
    display: flex;
    gap: 6px;
    align-items: baseline;
    font-size: 14px;
    margin-top: 6px;
  }
  .block .mark {
    flex: none;
    position: relative;
    top: 2px;
  }
  section {
    max-width: 70ch;
    margin-bottom: 36px;
  }
  h2 {
    margin: 0 0 8px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 650;
    font-size: 22px;
  }
  .quiet {
    margin: 0 0 10px;
    color: var(--ink-2);
  }
  .defs {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .defs li {
    padding: 10px 0;
    border-top: 1px solid var(--rule);
  }
  .defs li a {
    font-weight: 600;
    font-size: 15px;
  }
  .defs p {
    margin: 4px 0 0;
    color: var(--ink-2);
  }
  @container (min-width: 1024px) {
    .page {
      padding: 36px 40px 64px;
    }
    .scroll {
      margin: 0;
      padding: 0;
    }
    .statement {
      font-size: 43px;
    }
    section {
      font-size: 15px;
    }
  }
</style>
