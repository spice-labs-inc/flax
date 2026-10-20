<script lang="ts">
  import FailureNotes from "./FailureNotes.svelte";
  import Mark from "./Mark.svelte";
  import {
    ELSEWHERE,
    ENV_LABEL,
    ENV_ORDER,
    formatPacific,
    type Env,
    type Item,
  } from "./data.ts";
  import { SURFACE_TITLE, type Feature } from "./features.ts";
  import { TYPE_LABEL, type Persona, type Station } from "./personas.ts";
  import type { EnvState } from "./proof.ts";
  import { copyText, type Dest, type Nav } from "./nav.ts";
  import {
    type FailNote,
    type Proof,
    type ScenarioDetail,
  } from "./scenarios.ts";
  import type { Model } from "./model.ts";
  import { countStations, stationsText } from "./counts.ts";

  let {
    model,
    open = $bindable(false),
    resume = $bindable(null),
    snap,
    nav,
  }: {
    model: Model;
    open?: boolean;
    /** A search to reopen as it was, after closing a scenario opened from it. */
    resume?: { query: string; selected: number } | null;
    snap: number;
    nav: Nav;
  } = $props();
  let {
    islandOf,
    items,
    surfaces,
    personas,
    itemState,
    scenarioState,
    stationEnvState,
    details,
    failureOn,
    itemDetails,
    lastPass,
    features,
    featureState,
    personaCoverage,
  } = $derived(model);

  type Hit =
    | { kind: "item"; it: Item }
    | { kind: "scenario"; d: ScenarioDetail }
    | { kind: "station"; st: Station; on: Persona[] }
    | { kind: "feature"; f: Feature }
    | { kind: "persona"; p: Persona };

  interface Entry {
    hit: Hit;
    key: string;
    label: string;
    sub: string;
    title: string;
    rest: string;
  }

  let titles = $derived(new Map(surfaces.map((s) => [s.island, s.title])));
  const surfaceOf = (id: string) => {
    const s = surfaces.find((x) => id.startsWith(`features/${x.surface}/`));
    return titles.get(s ? islandOf(s.surface, "", id) : "api") ?? "";
  };

  let stations = $derived([...new Set(personas.flatMap((p) => p.stations))]);
  let entries: Entry[] = $derived([
    ...features.map((f): Entry => ({
      hit: { kind: "feature", f },
      key: `f:${f.id}`,
      label: f.name,
      sub: `Feature on ${SURFACE_TITLE[f.surface]}, ${f.scenarios.length} ${f.scenarios.length === 1 ? "scenario" : "scenarios"}`,
      title: f.name.toLowerCase(),
      rest: `${f.description} ${f.area} ${f.scenarios.map((x) => x.name).join(" ")}`.toLowerCase(),
    })),
    ...personas.map((p): Entry => ({
      hit: { kind: "persona", p },
      key: `u:${p.id}`,
      label: p.name,
      sub: TYPE_LABEL[p.type],
      title: p.name.toLowerCase(),
      rest: `${p.def.summary} ${p.def.titles.join(" ")}`.toLowerCase(),
    })),
    ...items.map((it): Entry => {
      const t = titles.get(it.island) ?? it.surface;
      return {
        hit: { kind: "item", it },
        key: `i:${it.id}`,
        label: it.label,
        sub: it.planned
          ? `${it.planned.kind === "issue" ? "Open issue" : "Planned scenario"} on ${t}`
          : `${it.kind} on ${t}, ${it.area}`,
        title: it.label.toLowerCase(),
        rest: `${it.id} ${it.area} ${t}`.toLowerCase(),
      };
    }),
    ...details.map((d): Entry => ({
      hit: { kind: "scenario", d },
      key: `s:${d.id}`,
      label: d.name,
      sub: `Scenario on ${surfaceOf(d.id)}, ${d.feature}`,
      title: d.name.toLowerCase(),
      rest: `${d.feature} ${d.id} ${d.steps.map((s) => s.t).join(" ")}`.toLowerCase(),
    })),
    ...stations.map((st): Entry => {
      const on = personas.filter((p) => p.stations.includes(st));
      return {
        hit: { kind: "station", st, on },
        key: `p:${st.key}`,
        label: st.name,
        sub: `Station on the ${on.map((p) => p.name).join(", ")} ${on.length === 1 ? "journey" : "journeys"}`,
        title: st.name.toLowerCase(),
        rest: `${st.stage} ${on.map((p) => p.name).join(" ")} ${st.key}`.toLowerCase(),
      };
    }),
  ]);

  let dialog: HTMLDialogElement;
  let query = $state("");
  let selected = $state(0);
  let copied = $state<"idle" | "done" | "manual">("idle");
  let manualUrl = $state("");

  let terms = $derived(query.trim().toLowerCase().split(/\s+/).filter(Boolean));
  let results = $derived.by(() => {
    if (!terms.length) return [];
    const scored: { e: Entry; score: number }[] = [];
    for (const e of entries) {
      let score = 0;
      for (const t of terms) {
        if (e.title.includes(t)) score += 3;
        else if (e.rest.includes(t)) score += 1;
        else {
          score = -1;
          break;
        }
      }
      if (score > 0) scored.push({ e, score });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 60)
      .map((x) => x.e);
  });
  let current = $derived(results[selected]);

  $effect(() => {
    if (open && !dialog.open) {
      query = resume?.query ?? "";
      selected = resume?.selected ?? 0;
      resume = null;
      copied = "idle";
      dialog.showModal();
      if (selected)
        requestAnimationFrame(() =>
          dialog
            .querySelector(`[data-i="${selected}"]`)
            ?.scrollIntoView({ block: "nearest" }),
        );
    } else if (!open && dialog.open) dialog.close();
  });

  function destOf(h: Hit): Dest {
    if (h.kind === "item") return { view: "map", itemId: h.it.id };
    if (h.kind === "scenario") return { view: "map", scenario: h.d.id };
    if (h.kind === "feature")
      return { view: "features", feature: `${h.f.surface}/${h.f.stem}` };
    if (h.kind === "persona") return { view: "personas", persona: h.p.id };
    return { view: "personas", persona: h.on[0]?.id, station: h.st.key };
  }

  /** A persona's state in one env: its worst station there, labeled with the one station count. */
  function personaState(p: Persona, env: Env): EnvState {
    const c = personaCoverage(p, snap, env);
    if (!c.stations.length) return { kind: "none", label: "No journey yet" };
    const n = countStations(
      c.stations.map((s) => s.byEnv[env]),
      env,
    );
    if (n.total === 0)
      return { kind: "never", label: "Not in this environment" };
    const label = stationsText(n, false);
    if (n.failing)
      return {
        kind: "fail",
        label: `${label}; ${n.failing} failing`,
      };
    if (n.verified + n.edition === n.total) return { kind: "pass", label };
    if (n.verified || n.partial) return { kind: "partial", label };
    return { kind: "none", label };
  }

  function states(h: Hit): EnvState[] {
    return ENV_ORDER.map((e) =>
      h.kind === "item"
        ? itemState(h.it, e, snap)
        : h.kind === "scenario"
          ? scenarioState(h.d, e, snap)
          : h.kind === "feature"
            ? featureState(h.f, e, snap)
            : h.kind === "persona"
              ? personaState(h.p, e)
              : stationEnvState(h.st, e, snap),
    );
  }

  function detailsOf(h: Hit): ScenarioDetail[] {
    return h.kind === "item"
      ? itemDetails(h.it)
      : h.kind === "scenario"
        ? [h.d]
        : h.kind === "feature"
          ? h.f.scenarios.flatMap((x) => x.detail ?? [])
          : h.kind === "persona"
            ? [
                ...new Set(
                  h.p.stations.flatMap((st) => st.items.flatMap(itemDetails)),
                ),
              ]
            : [...new Set(h.st.items.flatMap(itemDetails))];
  }

  /** The newest passing run that proves it, across every env. */
  function proofOf(h: Hit): Proof | undefined {
    const list = detailsOf(h);
    return ENV_ORDER.map((e) => lastPass(list, e, snap))
      .filter((p) => p !== undefined)
      .sort((a, b) => b.at.localeCompare(a.at))[0];
  }

  /** Per env it fails in, the newest failing scenario behind it. */
  function failuresOf(h: Hit): FailNote[] {
    const list = detailsOf(h);
    return states(h).flatMap((s, ei) =>
      s.kind === "fail" ? (failureOn(list, ENV_ORDER[ei]!, snap) ?? []) : [],
    );
  }

  function unproven(h: Hit): string {
    if (h.kind === "item" && h.it.planned?.kind === "issue")
      return "Not built yet: an open issue on the Engineering Board. Nothing to prove until it ships.";
    if (h.kind === "item" && h.it.planned?.kind === "scenario")
      return `Planned: a scenario is written and waiting to run.${h.it.planned.waitingOn ? ` ${h.it.planned.waitingOn}` : ""}`;
    if (h.kind === "station" && h.st.kind === "planned")
      return "Planned: the feature is not built yet.";
    if (h.kind === "station" && h.st.kind === "elsewhere")
      return `${ELSEWHERE}, not by these scenarios.`;
    if (h.kind === "feature") return "Nothing of this feature is verified yet.";
    if (h.kind === "persona")
      return "No station on this journey is verified yet.";
    return "Not verified yet: no scenario proves it.";
  }

  function pick(i: number) {
    const e = results[i];
    if (!e) return;
    open = false;
    nav.go(destOf(e.hit), { palette: { query, selected: i } });
  }

  async function copy(e: Entry) {
    const url = nav.url(destOf(e.hit));
    if (await copyText(url)) copied = "done";
    else {
      manualUrl = url;
      copied = "manual";
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(
        0,
        Math.min(
          results.length - 1,
          selected + (e.key === "ArrowDown" ? 1 : -1),
        ),
      );
      copied = "idle";
      dialog
        .querySelector(`[data-i="${selected}"]`)
        ?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      if (current) void copy(current);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(selected);
    }
  }

  const KIND_WORD = {
    feature: "Feature",
    persona: "Persona",
    item: "Item",
    scenario: "Scenario",
    station: "Station",
  };
</script>

<dialog
  bind:this={dialog}
  aria-label="Search features, personas, items, scenarios and stations"
  onclose={() => (open = false)}
  onclick={(e) => e.target === dialog && (open = false)}
>
  <div class="palette">
    <input
      id="palette-search"
      type="search"
      placeholder="Search items, scenarios and persona stations, or a claim"
      autocomplete="off"
      role="combobox"
      aria-expanded={results.length > 0}
      aria-controls="palette-list"
      aria-activedescendant={results.length
        ? `palette-opt-${selected}`
        : undefined}
      bind:value={query}
      oninput={() => {
        selected = 0;
        copied = "idle";
      }}
      {onkeydown}
    />
    <div class="body">
      <ul id="palette-list" role="listbox" aria-label="Matches">
        {#if !terms.length}
          <li class="empty">
            Try a claim such as "creates an API token", or "survey", "pricing",
            "Consumer".
          </li>
        {:else if !results.length}
          <li class="empty">
            Nothing matches "{query.trim()}". Search reads feature names and
            descriptions, persona names, item names, paths and ids, scenario
            names and steps, and persona stations.
          </li>
        {:else}
          {#each results as e, i (e.key)}
            {@const st = states(e.hit)}
            <li role="presentation">
              <button
                type="button"
                tabindex="-1"
                role="option"
                id="palette-opt-{i}"
                data-i={i}
                aria-selected={i === selected}
                onclick={() => pick(i)}
                onmouseenter={() => {
                  if (selected !== i) copied = "idle";
                  selected = i;
                }}
              >
                <span class="l"
                  ><span class="k">{KIND_WORD[e.hit.kind]}</span>{e.label}</span
                >
                <span class="envs" aria-hidden="true">
                  {#each st as s, ei (ei)}<Mark
                      kind={s.kind}
                      size={12}
                    />{/each}
                </span>
                <span class="s">{e.sub}</span>
              </button>
            </li>
          {/each}
        {/if}
      </ul>
      {#if current}
        {@const h = current.hit}
        {@const proof = proofOf(h)}
        {@const fails = failuresOf(h)}
        <section class="preview" aria-label="Proof for the selected match">
          <p class="ptitle">{current.label}</p>
          <p class="psub">{current.sub}</p>
          <ul class="penvs">
            {#each states(h) as s, ei (ei)}
              <li>
                <Mark kind={s.kind} size={14} /><b
                  >{ENV_LABEL[ENV_ORDER[ei]!]}</b
                ><span>{s.label}</span>
              </li>
            {/each}
          </ul>
          {#if fails.length}
            <FailureNotes
              notes={fails}
              {nav}
              dest={(n) => ({ view: "map", scenario: n.scenario.id })}
              from={() => ({ palette: { query, selected } })}
              onleave={() => (open = false)}
            />
          {/if}
          <p class="proof" class:after={fails.length > 0}>
            {#if proof}
              Verified
              <b>{formatPacific(proof.at)}</b>
              on {ENV_LABEL[proof.env]}{h.kind === "scenario"
                ? "."
                : ", proved by"}
              {#if h.kind !== "scenario"}
                <a
                  href={nav.href({ view: "map", scenario: proof.scenario.id })}
                  onclick={(ev) => {
                    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey) return;
                    ev.preventDefault();
                    open = false;
                    nav.go(
                      { view: "map", scenario: proof.scenario.id },
                      { palette: { query, selected } },
                    );
                  }}>{proof.scenario.name}</a
                >
              {/if}
            {:else}
              {unproven(h)}
            {/if}
          </p>
          <div class="actions">
            <button type="button" class="btn" onclick={() => pick(selected)}
              >Open <kbd>Enter</kbd></button
            >
            <button type="button" class="btn" onclick={() => copy(current)}
              >Copy link <kbd>Shift Enter</kbd></button
            >
            <span class="copied" aria-live="polite"
              >{copied === "done" ? "Link copied" : ""}</span
            >
          </div>
          {#if copied === "manual"}
            <label class="manual"
              >The page cannot reach the clipboard here; copy this link:
              <input
                readonly
                value={manualUrl}
                onfocus={(ev) => ev.currentTarget.select()}
              /></label
            >
          {/if}
        </section>
      {/if}
    </div>
    <p class="keys">
      <span><kbd>&uarr;</kbd><kbd>&darr;</kbd> choose</span>
      <span><kbd>Enter</kbd> open</span>
      <span><kbd>Shift Enter</kbd> copy link</span>
      <span><kbd>Esc</kbd> close</span>
    </p>
  </div>
</dialog>

<style>
  dialog {
    border: 0;
    padding: 0;
    background: transparent;
    width: min(880px, calc(100% - 32px));
    max-width: none;
    margin: 10vh auto auto;
  }
  dialog::backdrop {
    background: color-mix(in srgb, var(--ink) 30%, transparent);
  }
  .palette {
    background: var(--panel);
    color: var(--ink);
    border: 1px solid var(--rule);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 20px 60px color-mix(in srgb, var(--ink) 25%, transparent);
  }
  input[type="search"] {
    width: 100%;
    box-sizing: border-box;
    border: 0;
    border-bottom: 1px solid var(--rule);
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: 16px;
    padding: 14px 16px;
  }
  .body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 320px);
  }
  ul[role="listbox"] {
    list-style: none;
    margin: 0;
    padding: 6px;
    max-height: 56vh;
    overflow: auto;
  }
  li button {
    appearance: none;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    width: 100%;
    padding: 8px 10px;
    border-radius: var(--r-s);
    cursor: pointer;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 2px 10px;
  }
  li button[aria-selected="true"] {
    background: var(--accent-soft);
  }
  .l {
    overflow-wrap: anywhere;
  }
  .k {
    font-size: 11.5px;
    color: var(--ink-2);
    border: 1px solid var(--rule);
    border-radius: 999px;
    padding: 0 6px;
    margin-right: 8px;
    vertical-align: 1px;
  }
  .envs {
    display: inline-flex;
    gap: 3px;
    align-items: center;
  }
  .s {
    grid-column: 1 / -1;
    color: var(--ink-2);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .empty {
    color: var(--ink-2);
    padding: 8px 10px;
  }
  .preview {
    border-left: 1px solid var(--rule);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    max-height: 56vh;
    overflow: auto;
  }
  .ptitle {
    margin: 0;
    font-family: var(--display);
    font-stretch: 112%;
    font-weight: 700;
    font-size: 16px;
    overflow-wrap: anywhere;
  }
  .psub {
    margin: 0;
    color: var(--ink-2);
    font-size: 12.5px;
    overflow-wrap: anywhere;
  }
  .penvs {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
  }
  .penvs li {
    display: grid;
    grid-template-columns: auto 5.4em minmax(0, 1fr);
    gap: 8px;
    align-items: center;
  }
  .penvs span {
    color: var(--ink-2);
  }
  .proof {
    margin: 4px 0 0;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .proof a {
    color: var(--accent);
  }
  .proof.after {
    color: var(--ink-2);
    font-size: 12.5px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-top: 4px;
  }
  .btn {
    appearance: none;
    border: 1px solid var(--rule);
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    border-radius: var(--r-s);
    padding: 4px 10px;
    cursor: pointer;
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .btn:hover {
    background: var(--ground-2);
  }
  .copied {
    font-size: 12.5px;
    color: var(--ink);
    font-weight: 600;
  }
  .manual {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
    color: var(--ink-2);
  }
  .manual input {
    font: inherit;
    font-size: 12.5px;
    padding: 5px 8px;
    border: 1px solid var(--rule);
    border-radius: var(--r-s);
    background: var(--panel);
    color: var(--ink);
  }
  .keys {
    margin: 0;
    border-top: 1px solid var(--rule);
    padding: 8px 14px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    font-size: 12px;
    color: var(--ink-2);
  }
  .keys span {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  @media (max-width: 720px) {
    dialog {
      margin-top: 16px;
    }
    .body {
      grid-template-columns: minmax(0, 1fr);
    }
    ul[role="listbox"] {
      max-height: 34vh;
    }
    .preview {
      border-left: 0;
      border-top: 1px solid var(--rule);
      max-height: none;
    }
    .keys {
      display: none;
    }
  }
</style>
