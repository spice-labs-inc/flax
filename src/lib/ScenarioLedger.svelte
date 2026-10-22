<script lang="ts">
  import Mark from "./Mark.svelte";
  import {
    ENV_LABEL,
    CONFIG,
    ENV_ORDER,
    ENVS,
    formatPacific,
    type EnvChoice,
    type Item,
  } from "./data.ts";
  import { inPage, type Nav } from "./nav.ts";
  import {
    flips,
    formatMs,
    lastWhere,
    type ScenarioDetail,
  } from "./scenarios.ts";
  import type { Model } from "./model.ts";

  let {
    model,
    detail: d,
    env,
    snap,
    nav,
  }: {
    model: Model;
    detail: ScenarioDetail;
    env: EnvChoice;
    snap: number;
    nav: Nav;
  } = $props();
  let { surfaces, items, itemState, recordAt, runs, scenarioItems, snapOfRun } =
    $derived(model);

  let titles = $derived(new Map(surfaces.map((s) => [s.island, s.title])));
  let shownEnvs = $derived(
    ENV_ORDER.filter((e) => d.records[e].length || d.applies.includes(e)),
  );
  let maxMs = $derived(
    Math.max(1, ...ENVS.flatMap((e) => d.records[e].map((r) => r.ms))),
  );
  let touched = $derived(scenarioItems(d));
  /** What a row says under an item: an element names its page, anything else its area. */
  function under(it: Item): string {
    const page =
      it.kind === "Element" && it.page
        ? items.find((x) => x.id === it.page)
        : undefined;
    return page
      ? `Element on ${page.label.replace(/^Page /, "")}, ${titles.get(it.island)}`
      : `${titles.get(it.island)}, ${it.area}`;
  }
  let commit = $derived(
    lastWhere(runs, (r) => !!r.scenariosCommit)?.scenariosCommit,
  );
  let source = $derived.by(() => {
    const m = /^(.*):(\d+)$/.exec(d.id);
    return m && commit
      ? `https://github.com/${CONFIG.repo.workspace}/blob/${commit}/${m[1]}#L${m[2]}`
      : null;
  });

  function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)]! : 0;
  }
</script>

<aside class="side" aria-label="Scenario history">
  <section class="ledger">
    <p class="label">Every recorded run</p>
    {#each shownEnvs as e (e)}
      {@const recs = d.records[e]}
      {@const cur = recordAt(d, e, snap)}
      {@const n = flips(recs)}
      <div class="env" class:sel={env === e}>
        <p class="ehead">
          <b>{ENV_LABEL[e]}</b>
          <span
            >{#if recs.length}{recs.filter((r) => r.status === "p").length} of {recs.length}
              verified{n
                ? `, flipped ${n} ${n === 1 ? "time" : "times"}`
                : ""}{:else}No runs recorded{/if}</span
          >
        </p>
        {#if recs.length}
          <div class="strip" role="group" aria-label="{ENV_LABEL[e]} runs">
            {#each recs as r (r.run)}
              {@const point = snapOfRun(r.run)}
              {@const run = runs[r.run]!}
              {@const label = `${ENV_LABEL[e]}, ${formatPacific(run.finishedAt)}: ${r.status === "p" ? "verified" : r.status === "f" ? "failed" : "did not finish"}, ${formatMs(r.ms)}`}
              <button
                type="button"
                class="bar b-{r.status}"
                class:cur={r === cur}
                class:later={point > snap}
                style:--h="{Math.max(12, Math.sqrt(r.ms / maxMs) * 100)}%"
                disabled={point < 0}
                aria-label="{label}{point < 0
                  ? ''
                  : '. Show the timeline at this run'}"
                aria-current={r === cur ? "true" : undefined}
                title={label}
                onclick={() => nav.go({ snap: point })}
              ></button>
            {/each}
          </div>
          <p class="sub">
            Typical run {formatMs(median(recs.map((r) => r.ms)))}.
          </p>
        {/if}
      </div>
    {/each}
    <p class="note">
      One bar per run, oldest first, taller when it took longer. Choose one to
      move the timeline there.
    </p>
  </section>

  <section class="ledger">
    <p class="label">
      Surface items it touches ({touched.length})
    </p>
    {#if touched.length === 0}
      <p class="note">No run recorded it touching a surface item.</p>
    {:else}
      <div class="rows">
        {#each touched as it (it.id)}
          <a
            class="row"
            href={nav.href({ view: "map", itemId: it.id })}
            onclick={(e) => inPage(e) && nav.go({ view: "map", itemId: it.id })}
          >
            <span class="name">{it.label}<small>{under(it)}</small></span>
            <span class="dots">
              {#each ENV_ORDER as e (e)}
                {@const s = itemState(it, e, snap)}
                <span title="{ENV_LABEL[e]}: {s.label}"
                  ><Mark kind={s.kind} size={12} /><span class="sr"
                    >{ENV_LABEL[e]}: {s.label}</span
                  ></span
                >
              {/each}
            </span>
          </a>
        {/each}
      </div>
    {/if}
  </section>

  {#if source}
    <section class="ledger">
      <p class="label">Where it is written</p>
      <p class="note">
        <a href={source} target="_blank" rel="noreferrer"
          >{d.id.replace(/:(\d+)$/, ", line $1")}</a
        > in the workspace, as of the newest run.
      </p>
    </section>
  {/if}
</aside>

<style>
  .side {
    border-left: 1px solid var(--rule);
    background: var(--panel);
    min-height: 0;
    height: 100%;
    box-sizing: border-box;
    overflow: auto;
    padding: 18px 18px 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .ledger + .ledger {
    border-top: 1px solid var(--rule);
    padding-top: 16px;
  }
  .label {
    font-size: 12px;
    color: var(--ink-2);
    margin: 0 0 6px;
  }
  .env {
    padding: 8px 10px 10px;
    margin: 0 -10px;
    border-radius: var(--r-s);
  }
  .env.sel {
    background: color-mix(in srgb, var(--accent-soft) 70%, var(--panel));
  }
  .ehead {
    margin: 0 0 6px;
    display: flex;
    justify-content: space-between;
    gap: 10px;
    font-size: 13px;
  }
  .ehead span {
    color: var(--ink-2);
    font-size: 12.5px;
    text-align: right;
  }
  .strip {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 40px;
    border-bottom: 1px solid var(--rule);
  }
  .bar {
    appearance: none;
    border: 0;
    padding: 0;
    flex: 1 1 0;
    max-width: 18px;
    min-width: 5px;
    height: var(--h);
    border-radius: 2px 2px 0 0;
    background: var(--ink-3);
    cursor: pointer;
  }
  .bar.b-p {
    background: var(--pass);
  }
  .bar.b-f {
    background: var(--fail);
  }
  .bar.later {
    opacity: 0.3;
  }
  .bar.cur {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }
  .bar:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .bar:disabled {
    cursor: default;
  }
  .sub {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--ink-2);
  }
  .note {
    font-size: 12.5px;
    color: var(--ink-2);
    margin: 8px 0 0;
    overflow-wrap: anywhere;
  }
  a {
    color: var(--accent);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row {
    color: inherit;
    text-decoration: none;
    padding: 7px 8px;
    margin: 0 -8px;
    border-radius: var(--r-s);
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
  }
  .row:hover {
    background: var(--ground-2);
  }
  .name {
    display: flex;
    flex-direction: column;
    overflow-wrap: anywhere;
  }
  small {
    font-size: 11.5px;
    color: var(--ink-2);
  }
  .dots {
    display: inline-flex;
    gap: 3px;
  }
  @media (max-width: 860px) {
    .side {
      border-left: 0;
      border-top: 1px solid var(--rule);
      overflow: visible;
      height: auto;
    }
  }
</style>
