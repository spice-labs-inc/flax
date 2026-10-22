<script lang="ts">
  import {
    ENV_LABEL,
    ENVS,
    ENV_ORDER,
    formatPacific,
    formatPacificDay,
    type EnvChoice,
  } from "./data.ts";

  import { onDestroy } from "svelte";
  import type { Model } from "./model.ts";

  let {
    model,
    snap = $bindable(0),
    env,
  }: { model: Model; snap?: number; env: EnvChoice } = $props();
  let { LATEST, items, snapshots, tally } = $derived(model);

  let timer: ReturnType<typeof setInterval> | null = null;
  let playing = $state(false);

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    playing = false;
  }

  function play() {
    if (playing) return stop();
    if (snap >= LATEST) snap = 0;
    playing = true;
    timer = setInterval(() => {
      if (snap >= LATEST) stop();
      else snap += 1;
    }, 900);
  }

  onDestroy(stop);

  let n = $derived(snapshots.length);
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 1000 : 1000);
  let points = $derived(snapshots.map((_, i) => tally(items, i, env)));
  const y = (v: number, slots: number) => 52 - (v / Math.max(1, slots)) * 48;
  let passLine = $derived(
    points
      .map((t, i) => `${i ? "L" : "M"}${x(i)},${y(t.pass, t.slots)}`)
      .join(" "),
  );
  let passArea = $derived(
    `M${x(0)},52 ${passLine.replace(/^M/, "L")} L1000,52 Z`,
  );
  let failBand = $derived(
    points
      .map((t, i) => `${i ? "L" : "M"}${x(i)},${y(t.pass + t.fail, t.slots)}`)
      .join(" ") +
      " " +
      [...points]
        .map((t, i) => ({ t, i }))
        .reverse()
        .map(({ t, i }) => `L${x(i)},${y(t.pass, t.slots)}`)
        .join(" ") +
      " Z",
  );

  let trackW = $state(0);
  /** A day label at the first point of each California day; when two would collide, the later day keeps its label. */
  let days = $derived.by(() => {
    const firsts: { i: number; label: string }[] = [];
    snapshots.forEach((s, i) => {
      const label = formatPacificDay(s.at);
      if (firsts.at(-1)?.label !== label) firsts.push({ i, label });
    });
    const px = (i: number) => (x(i) / 1000) * trackW;
    const width = (label: string) => label.length * 7 + 10;
    const kept: ((typeof firsts)[number] & { end: boolean })[] = [];
    for (let k = firsts.length - 1; k >= 0; k--) {
      const f = firsts[k]!;
      const next = kept[0];
      if (!next || px(next.i) - px(f.i) > width(f.label))
        kept.unshift({ ...f, end: px(f.i) + width(f.label) > trackW });
    }
    return kept;
  });

  let cur = $derived(snapshots[snap]!);
  let runsSoFar = $derived(ENVS.reduce((n, e) => n + cur.runs[e], 0));
  let runsTitle = $derived(
    ENV_ORDER.map((e) => `${ENV_LABEL[e]} ${cur.runs[e]}`).join(", "),
  );
</script>

<section class="time" aria-label="Timeline of scheduled scenario runs">
  <button
    class="play"
    type="button"
    onclick={play}
    aria-pressed={playing}
    aria-label={playing
      ? "Pause the history"
      : "Play the history from the first run"}
  >
    {#if playing}
      <svg viewBox="0 0 16 16" aria-hidden="true"
        ><rect x="3" y="2" width="3.5" height="12" fill="currentColor"
        ></rect><rect x="9.5" y="2" width="3.5" height="12" fill="currentColor"
        ></rect></svg
      >
    {:else}
      <svg viewBox="0 0 16 16" aria-hidden="true"
        ><path d="M4 2 L14 8 L4 14 Z" fill="currentColor"></path></svg
      >
    {/if}
  </button>
  <div class="lbl">
    <strong>{formatPacific(cur.at)}{snap === LATEST ? ", latest" : ""}</strong>
    {ENV_LABEL[cur.env]} run: {cur.ran.passed} of {cur.ran.scenarios} verified.
    <span title={runsTitle}
      >{runsSoFar} {runsSoFar === 1 ? "run" : "runs"} so far.</span
    >
  </div>
  <div class="track" bind:clientWidth={trackW}>
    <svg viewBox="0 0 1000 56" preserveAspectRatio="none" aria-hidden="true">
      <line
        x1="0"
        x2="1000"
        y1="52"
        y2="52"
        stroke="var(--rule)"
        vector-effect="non-scaling-stroke"
      ></line>
      <line
        x1="0"
        x2="1000"
        y1="4"
        y2="4"
        stroke="var(--rule)"
        stroke-dasharray="3 3"
        vector-effect="non-scaling-stroke"
      ></line>
      <path d={passArea} fill="var(--pass)" opacity="0.22"></path>
      <path d={failBand} fill="var(--fail)" opacity="0.5"></path>
      <path
        d={passLine}
        fill="none"
        stroke="var(--pass)"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
      ></path>
      {#each snapshots as s, i (s.runId)}
        <line
          x1={x(i)}
          x2={x(i)}
          y1="52"
          y2="56"
          stroke="var(--ink-3)"
          vector-effect="non-scaling-stroke"
        ></line>
      {/each}
      <line
        x1={x(snap)}
        x2={x(snap)}
        y1="0"
        y2="56"
        stroke="var(--accent)"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
      ></line>
    </svg>
    <input
      id="scrub"
      type="range"
      min="0"
      max={LATEST}
      step="1"
      bind:value={snap}
      oninput={stop}
      disabled={n < 2}
      aria-label="Point in the run history"
      aria-valuetext={formatPacific(cur.at)}
    />
    <div class="ticks">
      {#each days as d (d.label)}
        <span
          style:left="{x(d.i) / 10}%"
          class:end={d.end}
          class:now={d.i <= snap &&
            (days.find((o) => o.i > d.i)?.i ?? Infinity) > snap}>{d.label}</span
        >
      {/each}
    </div>
  </div>
</section>

<style>
  .time {
    border-top: 1px solid var(--rule);
    padding: 10px 20px 12px;
    display: grid;
    grid-template-columns: auto 230px minmax(0, 1fr);
    gap: 8px 16px;
    align-items: center;
  }
  .play {
    appearance: none;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 1px solid var(--rule);
    background: var(--accent);
    color: var(--panel);
    display: grid;
    place-items: center;
    cursor: pointer;
  }
  .play svg {
    width: 15px;
    height: 15px;
  }
  .lbl {
    font-size: 13px;
    color: var(--ink-2);
    height: 4.4em;
    overflow: hidden;
  }
  .lbl strong {
    color: var(--ink);
    display: block;
    font-size: 14px;
  }
  .track {
    min-width: 0;
  }
  svg {
    display: block;
    width: 100%;
    height: 56px;
    overflow: visible;
  }
  input {
    width: 100%;
    margin: 4px 0 0;
    accent-color: var(--accent);
  }
  .ticks {
    position: relative;
    height: 1.4em;
    font-size: 11.5px;
    color: var(--ink-3);
  }
  .ticks span {
    position: absolute;
    top: 0;
    white-space: nowrap;
  }
  .ticks .end {
    transform: translateX(-100%);
  }
  .ticks .now {
    color: var(--ink);
    font-weight: 600;
  }
  @media (max-width: 860px) {
    .time {
      padding-inline: 16px;
      grid-template-columns: auto minmax(0, 1fr);
    }
    .track {
      grid-column: 1 / -1;
    }
  }
</style>
