<script lang="ts">
  import { ELSEWHERE, ENV_LABEL, ENV_ORDER, type EnvChoice } from "./data.ts";
  import { countStations, leadEnv, stationsText } from "./counts.ts";
  import {
    STAGES,
    type Persona,
    type Station,
    type StationState,
  } from "./personas.ts";
  import type { Model } from "./model.ts";

  export type JourneyFocus =
    | { kind: "none" }
    | { kind: "persona"; persona: Persona }
    | { kind: "station"; station: Station; persona: Persona }
    | { kind: "orphans" };

  let {
    model,
    env,
    snap,
    focus,
    onfocus,
  }: {
    model: Model;
    env: EnvChoice;
    snap: number;
    focus: JourneyFocus;
    onfocus: (f: JourneyFocus) => void;
  } = $props();
  let { surfaces, orphans, personas, stageSlots, stationState } =
    $derived(model);

  const SLOT_W = 62;
  const ROW_H = 54;
  const TOP = 44;
  const LEFT = 16;
  let stageX = $derived.by(() => {
    const xs: number[] = [];
    let acc = LEFT;
    for (const n of stageSlots) {
      xs.push(acc);
      acc += n * SLOT_W + 10;
    }
    return xs;
  });
  let width = $derived(
    stageSlots.reduce((acc, n) => acc + n * SLOT_W + 10, LEFT),
  );
  let height = $derived(TOP + personas.length * ROW_H + 8);
  const xOf = (s: Station) =>
    stageX[STAGES.indexOf(s.stage)]! + s.slot * SLOT_W + SLOT_W / 2;
  const yOf = (i: number) => TOP + i * ROW_H + ROW_H / 2 - 8;

  const interchanges = (() => {
    const seen = new Map<Station, number[]>();
    personas.forEach((p, i) =>
      p.stations.forEach((s) => seen.set(s, [...(seen.get(s) ?? []), i])),
    );
    return [...seen.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([s, rows]) => ({
        s,
        y0: yOf(Math.min(...rows)),
        y1: yOf(Math.max(...rows)),
      }));
  })();

  interface Row {
    p: Persona;
    y: number;
    ordered: Station[];
    states: StationState[];
    strandedAt: number;
    /** What the name says under it: where it is blocked, or its count in the env it leads with. */
    sub: { text: string; blocked: boolean };
  }

  /** Blocked in the lead env first; on every env, a break nearer the reference env first. */
  function subOf(
    p: Persona,
    ordered: Station[],
  ): { text: string; blocked: boolean } {
    const lead = leadEnv(
      (e) => p.stations.some((s) => stationState(s, snap, e) !== "never"),
      env,
    );
    for (const e of env === "all" ? ENV_ORDER : [lead]) {
      const at = ordered.find((s) => stationState(s, snap, e) === "fail");
      if (at)
        return {
          text: `Blocked at ${at.name} on ${ENV_LABEL[e].toLowerCase()}`,
          blocked: true,
        };
    }
    const text = stationsText(
      countStations(
        p.stations.map((s) => stationState(s, snap, lead)),
        lead,
      ),
    );
    return { text, blocked: false };
  }

  let rows = $derived<Row[]>(
    personas.map((p, i) => {
      const ordered = [...p.stations].sort(
        (a, b) =>
          xOf(a) - xOf(b) || p.stations.indexOf(a) - p.stations.indexOf(b),
      );
      const states = ordered.map((s) => stationState(s, snap, env));
      return {
        p,
        y: yOf(i),
        ordered,
        states,
        strandedAt: states.indexOf("fail"),
        sub: subOf(p, ordered),
      };
    }),
  );

  const LINE_COLORS = [
    "#4c6edb",
    "#8a5fd1",
    "#2b8ea8",
    "#b07a1f",
    "#5d6b7a",
    "#a8558a",
    "#3f7f6a",
    "#9a6248",
    "#4e5bb5",
    "#7a7f2c",
    "#6b5a8e",
  ];

  function wrap(name: string): string[] {
    const words = name.split(" ");
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      if (cur && (cur + " " + w).length > 10) {
        lines.push(cur);
        cur = w;
      } else cur = cur ? cur + " " + w : w;
    }
    lines.push(cur);
    return lines.slice(0, 3);
  }

  let avail = $state(0);
  let scroller: HTMLDivElement | undefined = $state();
  /** Which edges have more lines beyond them. */
  let cue = $state({ before: false, after: false });
  function readCue() {
    if (!scroller) return;
    const max = scroller.scrollWidth - scroller.clientWidth;
    cue = {
      before: scroller.scrollLeft > 4,
      after: max - scroller.scrollLeft > 4,
    };
  }
  $effect(() => {
    void avail;
    void width;
    void scale;
    readCue();
  });
  let chosen = $derived(
    focus.kind === "persona" || focus.kind === "station" ? focus.persona : null,
  );
  /** Shrinks the map to fit its column, but never below 86%, where station names stop being readable; past that it scrolls. */
  let scale = $derived(
    avail > 0 ? Math.max(0.86, Math.min(1, avail / width)) : 1,
  );
  const isFocused = (s: Station, p: Persona) =>
    focus.kind === "station" && focus.station === s && focus.persona === p;
  let orphanBySurface = $derived(
    surfaces
      .map((s) => ({
        s,
        n: orphans.filter((o) => o.island === s.island).length,
      }))
      .filter((x) => x.n > 0),
  );
</script>

<div class="journeys">
  <div class="names" style:height="{height * scale}px">
    <button
      type="button"
      class="name all"
      class:on={focus.kind === "none"}
      style:top="0"
      style:height="{TOP * scale}px"
      onclick={() => onfocus({ kind: "none" })}
    >
      <span class="who"><b>All personas</b></span>
    </button>
    {#each rows as r, i (r.p.id)}
      {@const on =
        focus.kind !== "none" &&
        focus.kind !== "orphans" &&
        focus.persona === r.p}
      <button
        type="button"
        class="name"
        class:on
        style:top="{(r.y - ROW_H / 2 + 4) * scale}px"
        style:height="{ROW_H * scale}px"
        onclick={() =>
          onfocus(on ? { kind: "none" } : { kind: "persona", persona: r.p })}
      >
        <span
          class="swatch"
          style:background={LINE_COLORS[i % LINE_COLORS.length]}
        ></span>
        <span class="who" title={r.p.name}>
          <b>{r.p.name}</b>
          {#if r.sub.blocked}
            <span class="stranded">{r.sub.text}</span>
          {:else}
            <span class="sub"
              >{r.sub.text}{r.p.type === "internal"
                ? ", internal"
                : r.p.type === "buyer"
                  ? ", buyer role"
                  : ""}</span
            >
          {/if}
        </span>
      </button>
    {/each}
  </div>
  <div
    class="scroll"
    class:before={cue.before}
    class:after={cue.after}
    bind:clientWidth={avail}
    bind:this={scroller}
    onscroll={readCue}
  >
    <svg
      width={width * scale}
      height={height * scale}
      viewBox="0 0 {width} {height}"
      role="group"
      aria-label="Persona journeys as transit lines"
    >
      {#each STAGES as stage, si (stage)}
        <g>
          <rect
            x={stageX[si]! - 4}
            y="0"
            width={stageSlots[si]! * SLOT_W + 8}
            {height}
            fill={si % 2 ? "var(--ground-2)" : "transparent"}
            opacity="0.55"
            rx="6"
          ></rect>
          <text x={stageX[si]! + 6} y="22" class="stage">{stage}</text>
        </g>
      {/each}
      {#each interchanges as ic (ic.s.key)}
        <rect
          x={xOf(ic.s) - 7}
          y={ic.y0 - 7}
          width="14"
          height={ic.y1 - ic.y0 + 14}
          rx="7"
          fill="var(--panel)"
          stroke="var(--rule)"
          stroke-width="1.5"
        ></rect>
      {/each}
      {#each rows as r, i (r.p.id)}
        {@const color = LINE_COLORS[i % LINE_COLORS.length]}
        <g class="line" class:dim={chosen !== null && chosen !== r.p}>
          {#each r.ordered.slice(1) as s, k (s.key)}
            {@const a = r.ordered[k]!}
            {@const broken = r.strandedAt >= 0 && k >= r.strandedAt}
            <line
              x1={xOf(a)}
              x2={xOf(s)}
              y1={r.y}
              y2={r.y}
              stroke={color}
              stroke-width="5"
              stroke-linecap="round"
              stroke-dasharray={broken ? "2 7" : undefined}
              opacity={broken ? 0.45 : 1}
            ></line>
          {/each}
          {#each r.ordered as s, k (s.key)}
            {@const st = r.states[k]!}
            {@const x = xOf(s)}
            <g
              class="station"
              role="button"
              tabindex="0"
              aria-label="{r.p.name}: {s.name}"
              onclick={() =>
                onfocus({ kind: "station", station: s, persona: r.p })}
              onkeydown={(e) =>
                (e.key === "Enter" || e.key === " ") &&
                (e.preventDefault(),
                onfocus({ kind: "station", station: s, persona: r.p }))}
            >
              {#if isFocused(s, r.p)}
                <circle
                  cx={x}
                  cy={r.y}
                  r="14"
                  fill="none"
                  stroke="var(--accent)"
                  stroke-width="2.5"
                ></circle>
              {/if}
              {#if st === "pass"}
                <circle
                  cx={x}
                  cy={r.y}
                  r="8"
                  fill="var(--pass)"
                  stroke="var(--panel)"
                  stroke-width="2.5"
                ></circle>
              {:else if st === "fail"}
                <circle
                  cx={x}
                  cy={r.y}
                  r="9"
                  fill="var(--fail)"
                  stroke="var(--panel)"
                  stroke-width="2.5"
                ></circle>
                <path
                  d="M{x - 3.5} {r.y - 3.5} L{x + 3.5} {r.y + 3.5} M{x +
                    3.5} {r.y - 3.5} L{x - 3.5} {r.y + 3.5}"
                  stroke="var(--panel)"
                  stroke-width="2"
                ></path>
              {:else if st === "partial"}
                <circle
                  cx={x}
                  cy={r.y}
                  r="8"
                  fill="var(--panel)"
                  stroke="var(--pass)"
                  stroke-width="2.5"
                ></circle>
                <path
                  d="M{x} {r.y - 5.5} A5.5 5.5 0 0 1 {x} {r.y + 5.5} Z"
                  fill="var(--pass)"
                ></path>
              {:else if st === "unchecked"}
                <circle
                  cx={x}
                  cy={r.y}
                  r="8"
                  fill="var(--panel)"
                  stroke="var(--ink-3)"
                  stroke-width="2"
                ></circle>
                <path
                  d="M{x - 5} {r.y + 5} L{x + 5} {r.y - 5} M{x - 1.5} {r.y +
                    7} L{x + 7} {r.y - 1.5} M{x - 7} {r.y + 1.5} L{x +
                    1.5} {r.y - 7}"
                  stroke="var(--ink-3)"
                  stroke-width="1.4"
                ></path>
              {:else if st === "planned"}
                <circle
                  cx={x}
                  cy={r.y}
                  r="8"
                  fill="var(--ground)"
                  stroke="var(--planned)"
                  stroke-width="2"
                  stroke-dasharray="3 2.4"
                ></circle>
              {:else if st === "elsewhere"}
                <rect
                  x={x - 7}
                  y={r.y - 7}
                  width="14"
                  height="14"
                  transform="rotate(45 {x} {r.y})"
                  fill="var(--ground)"
                  stroke="var(--ink-3)"
                  stroke-width="1.6"
                ></rect>
              {:else}
                <circle
                  cx={x}
                  cy={r.y}
                  r="8"
                  fill="var(--panel)"
                  stroke="var(--ink-2)"
                  stroke-width="2.5"
                ></circle>
              {/if}
              {#each wrap(s.name) as ln, li (li)}
                <text
                  {x}
                  y={r.y + 21 + li * 10.5}
                  class="slabel"
                  class:ghost={st === "planned" || st === "elsewhere"}
                  >{ln}</text
                >
              {/each}
            </g>
          {/each}
        </g>
      {/each}
    </svg>
  </div>
</div>

<div class="orphans">
  <button
    type="button"
    class="orphan-head"
    class:on={focus.kind === "orphans"}
    onclick={() => onfocus({ kind: "orphans" })}
  >
    <span class="swatch none"></span>
    <span class="who"
      ><b>No persona</b><span class="sub"
        >{orphans.length === 1 ? "1 item is" : `${orphans.length} items are`} on no
        persona's journey yet</span
      ></span
    >
  </button>
  <div class="orphan-bars">
    {#each orphanBySurface as o (o.s.island)}
      <span class="ob"
        ><span class="t">{o.s.title}</span><span class="n"
          >{o.s.items - o.n} of {o.s.items} on a journey</span
        ><span class="bar"
          ><i style:width="{((o.s.items - o.n) / o.s.items) * 100}%"></i></span
        ></span
      >
    {/each}
  </div>
</div>

<div class="jlegend">
  <span
    ><svg width="14" height="14"
      ><circle cx="7" cy="7" r="5.5" fill="var(--pass)"></circle></svg
    >Verified</span
  >
  <span
    ><svg width="14" height="14"
      ><circle cx="7" cy="7" r="5.5" fill="var(--fail)"></circle></svg
    >Failing: the journey is blocked there</span
  >
  <span
    ><svg width="14" height="14"
      ><circle
        cx="7"
        cy="7"
        r="5"
        fill="none"
        stroke="var(--pass)"
        stroke-width="2"
      ></circle><path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill="var(--pass)"
      ></path></svg
    >Partly covered</span
  >
  <span
    ><svg width="14" height="14"
      ><circle
        cx="7"
        cy="7"
        r="5"
        fill="none"
        stroke="var(--ink-3)"
        stroke-width="1.6"
      ></circle><path
        d="M4 10 L10 4 M6.5 11.5 L11.5 6.5 M2.5 7.5 L7.5 2.5"
        stroke="var(--ink-3)"
        stroke-width="1.2"
      ></path></svg
    >Not checked here</span
  >
  <span
    ><svg width="14" height="14"
      ><circle
        cx="7"
        cy="7"
        r="5"
        fill="none"
        stroke="var(--ink-2)"
        stroke-width="2"
      ></circle></svg
    >No scenario yet</span
  >
  <span
    ><svg width="14" height="14"
      ><circle
        cx="7"
        cy="7"
        r="5"
        fill="none"
        stroke="var(--planned)"
        stroke-width="1.6"
        stroke-dasharray="2.5 2"
      ></circle></svg
    >Feature not built yet</span
  >
  <span
    ><svg width="14" height="14"
      ><rect
        x="3"
        y="3"
        width="8"
        height="8"
        transform="rotate(45 7 7)"
        fill="none"
        stroke="var(--ink-3)"
        stroke-width="1.4"
      ></rect></svg
    >{ELSEWHERE}</span
  >
</div>

<style>
  .journeys {
    display: grid;
    grid-template-columns: 236px minmax(0, 1fr);
    border-bottom: 1px solid var(--rule);
  }
  .names {
    position: relative;
    border-right: 1px solid var(--rule);
    background: var(--ground);
  }
  .name {
    position: absolute;
    left: 0;
    right: 0;
    overflow: hidden;
  }
  .name,
  .orphan-head {
    appearance: none;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 0 12px 0 16px;
    cursor: pointer;
    box-sizing: border-box;
  }
  .name.on,
  .orphan-head.on {
    background: var(--accent-soft);
  }
  .name.all {
    border-bottom: 1px solid var(--rule);
  }
  .swatch {
    width: 12px;
    height: 5px;
    border-radius: 3px;
    flex: none;
  }
  .swatch.none {
    background: repeating-linear-gradient(
      90deg,
      var(--ink-3) 0 3px,
      transparent 3px 5px
    );
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name .who b,
  .name .sub,
  .name .stranded {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .who b {
    font-weight: 600;
    font-size: 13.5px;
  }
  .sub,
  .stranded {
    font-size: 12px;
    color: var(--ink-2);
  }
  .stranded {
    color: var(--fail);
    font-weight: 600;
  }
  .scroll {
    overflow-x: auto;
    min-width: 0;
  }
  /* Faded edges say the lines go on beyond the pane. */
  .scroll.after {
    mask-image: linear-gradient(to right, black calc(100% - 56px), transparent);
  }
  .scroll.before {
    mask-image: linear-gradient(to right, transparent, black 56px);
  }
  .scroll.before.after {
    mask-image: linear-gradient(
      to right,
      transparent,
      black 56px,
      black calc(100% - 56px),
      transparent
    );
  }
  svg {
    display: block;
  }
  .stage {
    font-family: var(--display);
    font-stretch: 125%;
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    fill: var(--ink-2);
  }
  .slabel {
    font-size: 10.5px;
    fill: var(--ink);
    text-anchor: middle;
  }
  .slabel.ghost {
    fill: var(--ink-3);
    font-style: italic;
  }
  .line {
    transition: opacity 0.2s;
  }
  .line.dim {
    opacity: 0.22;
  }
  @media (prefers-reduced-motion: reduce) {
    .line {
      transition: none;
    }
  }
  .station {
    cursor: pointer;
    outline: none;
  }
  .station:focus-visible circle:first-child {
    stroke: var(--accent);
  }
  .orphans {
    display: grid;
    grid-template-columns: 236px minmax(0, 1fr);
    align-items: center;
    border-bottom: 1px solid var(--rule);
  }
  .orphan-head {
    padding-block: 12px;
    border-right: 1px solid var(--rule);
    height: 100%;
  }
  .orphan-bars {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 20px;
    padding: 10px 16px;
  }
  .ob {
    display: grid;
    grid-template-columns: auto auto;
    gap: 3px 10px;
    font-size: 12.5px;
    min-width: 130px;
  }
  .ob .n {
    color: var(--ink-2);
    text-align: right;
  }
  .ob .bar {
    grid-column: 1 / -1;
    height: 5px;
    background: var(--none);
    border-radius: 3px;
    overflow: hidden;
  }
  .ob .bar i {
    display: block;
    height: 100%;
    background: var(--pass);
  }
  .jlegend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    font-size: 12px;
    color: var(--ink-2);
    padding: 10px 16px;
  }
  .jlegend span {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  @media (max-width: 860px) {
    .journeys,
    .orphans {
      grid-template-columns: 150px minmax(0, 1fr);
    }
    .name {
      padding-left: 12px;
      gap: 8px;
    }
    .name .who b {
      white-space: normal;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      font-size: 12.5px;
      line-height: 1.2;
    }
    .name .sub,
    .name .stranded {
      font-size: 11.5px;
    }
  }
</style>
