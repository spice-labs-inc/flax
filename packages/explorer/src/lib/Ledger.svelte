<script lang="ts">
  import Bar from "./Bar.svelte";
  import FailureNotes from "./FailureNotes.svelte";
  import VerdictAge from "./VerdictAge.svelte";
  import VerdictNotes from "./VerdictNotes.svelte";
  import {
    CODE_COLOR,
    CODE_LABEL,
    ENV_LABEL,
    ENVS,
    ENV_ORDER,
    formatPacific,
    formatPacificDay,
    homesOf,
    readableUrl,
    whereLabel,
    DOC_KIND,
    singleHome,
    type Env,
    type EnvChoice,
    type Item,
    type RunCode,
    REFERENCE_ENV,
    envsProse,
  } from "./data.ts";
  import {
    countByEnv,
    gapSentences,
    leadEnv,
    pipelineSentences,
    shortCount,
  } from "./counts.ts";
  import type { Focus } from "./focus.ts";
  import type { World } from "./layout.ts";
  import { copyText, inPage, type Dest, type Lens, type Nav } from "./nav.ts";
  import { NEED_LABEL, type ScenarioDetail } from "./scenarios.ts";
  import type { Model } from "./model.ts";
  import { countOf } from "./features/catalog.ts";
  import { live } from "./live.svelte.ts";

  let {
    model,
    world,
    title = "Product",
    holder = null,
    focus,
    env,
    snap,
    lens,
    onfocus,
    nav,
  }: {
    model: Model;
    world: World;
    /** What the world view is called: the whole product, or a surface drawn as several islands. */
    title?: string | undefined;
    /** The item whose contents the map shows, so the panel describes it while nothing inside it is in focus. */
    holder?: Item | null;
    focus: Focus;
    env: EnvChoice;
    snap: number;
    lens: Lens;
    onfocus: (f: Focus) => void;
    nav: Nav;
  } = $props();
  let {
    boardSource,
    bugs,
    itemScenarios,
    items,
    openIssueCount,
    plannedScenarioCount,
    elementsOf,
    scenarioResults,
    status,
    tally,
    itemFailures,
    itemDetails,
    itemNeeds,
    itemSteps,
    recordAt,
    runs,
    featureOf,
    scenarioItems,
    relatedItems,
    childrenOf,
    detailOf,
    sharedElementsOn,
    needProofs,
    documentedBy,
    documentsOf,
    docSources,
    surfaceTitleOf,
    holderOf,
    holderChain,
  } = $derived(model);

  /** Documentation rows folded under the top-level thing each item belongs to: a command and six of its flags make one row. */
  function foldDocs(rows: Item[]): { head: Item; parts: Item[] }[] {
    const by = new Map<string, { head: Item; parts: Item[] }>();
    for (const it of rows) {
      const head = holderChain(it)[0] ?? it;
      const g = by.get(head.id) ?? { head, parts: [] };
      if (it !== head) g.parts.push(it);
      by.set(head.id, g);
    }
    return [...by.values()];
  }

  /** The district a group of elements fills in the map of what holds them. */
  const districtDest = (g: { name: string; items: Item[] }): Dest => ({
    view: "map",
    inside: holderOf(g.items[0]!)?.id,
    area: g.name,
  });

  const islandTitle = (it: Item) => it.edition ?? surfaceTitleOf(it);
  /** The item the panel describes: the one in focus, or the holder whose map is open while nothing inside it is. */
  let shown = $derived(
    focus.level === "item"
      ? focus.cell.item
      : holder && (focus.level === "world" || focus.level === "island")
        ? holder
        : null,
  );

  const scenarioDest = (it: Item, scenario: string): Dest => ({
    view: "map",
    itemId: it.id,
    scenario,
  });

  interface ProvedBy {
    d: ScenarioDetail;
    at: string;
    step?: { n: number; text: string };
    needs: string[];
  }

  /**
   * The 1 to 3 scenarios that verify an item, in the env on show, else the nearest to the reference env where it reads verified: one
   * per need it must prove, then the ones from its own feature, then the most focused. The rest only reach it on the way.
   */
  function provedBy(it: Item): { env: Env; rows: ProvedBy[] } | undefined {
    const area = it.area.toLowerCase();
    const verifiedIn = (e: Env) =>
      status[snap]![it.idx]![ENVS.indexOf(e)] === 3;
    for (const e of (env === "all" ? ENV_ORDER : [env]).filter(verifiedIn)) {
      const passed = itemDetails(it).flatMap((d) => {
        const r = recordAt(d, e, snap);
        if (r?.status !== "p") return [];
        const sIdx = itemScenarios(it).find((s) => s.id === d.id)?.sIdx;
        const stepIdx =
          sIdx === undefined ? undefined : itemSteps(it, sIdx)?.[0];
        const st = stepIdx === undefined ? undefined : d.steps[stepIdx];
        const f = featureOf(d.id);
        return [
          {
            d,
            at: runs[r.run]!.finishedAt,
            ...(st && stepIdx !== undefined
              ? { step: { n: stepIdx + 1, text: `${st.k.trim()} ${st.t}` } }
              : {}),
            needs: sIdx === undefined ? [] : itemNeeds(it, sIdx),
            own: f?.surface === it.surface && f.area.toLowerCase() === area,
            reach: scenarioItems(d).length,
          },
        ];
      });
      if (!passed.length) continue;
      passed.sort(
        (a, b) =>
          Number(b.own) - Number(a.own) ||
          a.reach - b.reach ||
          b.at.localeCompare(a.at),
      );
      const chosen = new Set<(typeof passed)[number]>();
      for (const n of it.needs ?? []) {
        const p = passed.find((x) => x.needs.includes(n));
        if (p) chosen.add(p);
      }
      for (const p of passed) if (chosen.size < 3) chosen.add(p);
      return {
        env: e,
        rows: [...chosen].map(({ d, at, step, needs }) => ({
          d,
          at,
          needs,
          ...(step ? { step } : {}),
        })),
      };
    }
    return undefined;
  }

  /** The item whose link was last copied, and whether the clipboard took it. */
  let copied = $state<{ id: string; ok: boolean; url: string } | null>(null);
  async function copyLink(id: string, url: string) {
    copied = { id, ok: await copyText(url), url };
  }

  let bySize = $derived(
    [...world.islands].sort((a, b) => b.items.length - a.items.length),
  );
  /** What the map draws, as the island labels count it. */
  let drawn = $derived(
    world.islands.flatMap((i) => i.items).filter((it) => !it.planned),
  );

  /** The bar beside a row, in the env its count leads with. */
  function leadTally(list: Item[]) {
    const by = countByEnv(model, list, snap);
    return tally(
      list,
      snap,
      leadEnv((e) => by[e].total > 0, env),
    );
  }

  /** A page's elements under the component each belongs to, the page's own first, then the biggest. */
  function componentGroups(xs: Item[]): { name: string; items: Item[] }[] {
    const by = new Map<string, Item[]>();
    for (const x of xs) {
      const name = x.component ?? "Other elements";
      const g = by.get(name);
      if (g) g.push(x);
      else by.set(name, [x]);
    }
    return [...by.entries()]
      .map(([name, items]) => ({ name, items }))
      .sort(
        (a, b) =>
          Number(b.name === "Page") - Number(a.name === "Page") ||
          b.items.length - a.items.length ||
          a.name.localeCompare(b.name),
      );
  }
  const RUN_LABEL: Record<RunCode, string> = {
    pass: "Verified",
    fail: "Failed",
    other: "Did not finish",
    none: "Not run",
  };
  const RUN_COLOR: Record<RunCode, string> = {
    pass: "var(--pass)",
    fail: "var(--fail)",
    other: "var(--ink-3)",
    none: "transparent",
  };
</script>

{#snippet partRow(x: Item)}
  {@const xc = status[snap]![x.idx]!}
  <li>
    <a
      class="name"
      href={nav.href({ view: "map", itemId: x.id })}
      onclick={(e) => inPage(e) && nav.go({ view: "map", itemId: x.id })}
      >{x.label}</a
    >
    <span class="n dots">
      {#each ENV_ORDER as e (e)}
        {@const i = ENVS.indexOf(e)}
        <i
          class:never={xc[i] === -1}
          style:background={CODE_COLOR[xc[i]!]}
          title="{ENV_LABEL[e]}: {CODE_LABEL[xc[i]!]}"
        ></i>
      {/each}
    </span>
  </li>
{/snippet}

{#snippet headline(list: Item[])}
  {@const by = countByEnv(model, list, snap)}
  {@const lead = leadEnv((e) => by[e].total > 0, env)}
  {@const c = by[lead]}
  {@const home = list.length > 0 && list.every(singleHome)}
  {#if c.total === 0}
    <p class="note">None of these items exist on {ENV_LABEL[lead]}.</p>
  {:else}
    <div class="figure">
      <strong>{c.verified.toLocaleString("en-US")}</strong><span
        >of {c.total.toLocaleString("en-US")}
        {c.total === 1 ? "item" : "items"} verified{home
          ? ""
          : ` on ${ENV_LABEL[lead].toLowerCase()}`}</span
      >
    </div>
    {@const why = gapSentences(model, list, snap, c)}
    {#if why.length}
      <ul class="why">
        {#each why as w, i (i)}
          <li class:under={w.under}>{w.text}</li>
        {/each}
      </ul>
    {/if}
  {/if}
  {#if env === "all" && !home}
    {@const pipe = pipelineSentences(by, lead)}
    {#if pipe.length}
      <p class="label pipe">
        {lead === REFERENCE_ENV
          ? `On the way to ${ENV_LABEL[lead]}`
          : "Other environments"}
      </p>
      {#each pipe as p, i (i)}
        <p class="note tight">{p}</p>
      {/each}
    {/if}
  {/if}
{/snippet}

<aside class="side" aria-live="polite">
  {#if !shown && focus.level === "world"}
    <section class="ledger">
      <h2>{title}</h2>
      <p class="sub">
        {countOf(drawn.length, "item")} on {countOf(
          world.islands.length,
          title === "Product" ? "surface" : "site",
        )}.
      </p>
      {@render headline(drawn)}
      {#if title === "Product" && (plannedScenarioCount || openIssueCount)}
        <p class="note">
          Dashed hexes are not gaps: {plannedScenarioCount} scenarios written and
          waiting to run, and {openIssueCount} open Engineering Board issues for features
          not built yet (open as of {formatPacificDay(boardSource.checkedAt)}).
        </p>
      {/if}
    </section>
    <section class="ledger">
      <p class="label">{title === "Product" ? "Surfaces" : "Sites"}</p>
      <div class="rows">
        {#each bySize as isl (isl.info.island)}
          {@const real = isl.items.filter((it) => !it.planned)}
          {@const ghosts = isl.items.length - real.length}
          <button
            class="row"
            type="button"
            onclick={() => onfocus({ level: "island", island: isl })}
          >
            <span class="name">{isl.info.title}</span>
            <span class="n"
              >{shortCount(model, real, snap, env)}{ghosts
                ? `; ${ghosts} planned`
                : ""}</span
            >
            <Bar t={leadTally(real)} />
          </button>
        {/each}
      </div>
    </section>
  {:else if !shown && focus.level === "island"}
    {@const isl = focus.island}
    {@const real = isl.items.filter((it) => !it.planned)}
    {@const areas = isl.districts.filter(
      (d) => !d.items.every((it) => it.planned),
    ).length}
    <section class="ledger">
      <h2>{isl.info.title}</h2>
      <p class="sub">
        {countOf(real.length, "item")} in {areas}
        {areas === 1 ? "area" : "areas"}{real.length < isl.items.length
          ? `, plus ${isl.items.length - real.length} planned`
          : ""}
      </p>
      {@render headline(real)}
    </section>
    <section class="ledger">
      <p class="label">Areas</p>
      <div class="rows">
        {#each isl.districts as d (d.name)}
          <button
            class="row"
            type="button"
            onclick={() => onfocus({ level: "district", district: d })}
          >
            <span class="name">{d.name}</span>
            <span class="n">{shortCount(model, d.items, snap, env)}</span>
            <Bar t={leadTally(d.items)} />
          </button>
        {/each}
      </div>
    </section>
    {@const islandBugs = bugs.filter((b) => b.surface === isl.info.surface)}
    {#if islandBugs.length}
      <section class="ledger">
        <p class="label">Open bugs on this surface</p>
        {#each islandBugs as b (b.id)}
          <p class="note">
            <a href={b.url} target="_blank" rel="noreferrer">{b.label}</a><small
            >
              {b.id.replace("bug:", "")}</small
            >
          </p>
        {/each}
      </section>
    {/if}
    {#if isl.info.notes.length || isl.info.outOfScope.length}
      <details class="more">
        <summary>Details</summary>
        {#if isl.info.notes.length}
          <p class="label">How this surface was read</p>
          {#each isl.info.notes as n, i (i)}
            <p class="note">{n}</p>
          {/each}
        {/if}
        {#if isl.info.outOfScope.length}
          <p class="label">Not counted here</p>
          {#each isl.info.outOfScope.slice(0, 8) as o, i (i)}
            <p class="note"><b>{o.label}</b>: {o.reason}</p>
          {/each}
        {/if}
      </details>
    {/if}
  {:else if focus.level === "district"}
    {@const d = focus.district}
    <section class="ledger">
      <h2>{d.name}</h2>
      <p class="sub">
        {d.island.info.title}, {countOf(d.items.length, "item")}
      </p>
      {#if d.items.every((it) => it.planned?.kind === "scenario")}
        <p class="note">
          Scenarios written in the workspace and tagged planned: each waits on a
          feature or a fixture before it can run. None is a gap.
        </p>
      {:else if d.items.every((it) => it.planned)}
        <p class="note">
          Open issues on the Engineering Board for features that do not exist
          yet, still open as of {formatPacificDay(boardSource.checkedAt)}. None
          is a gap.
        </p>
      {:else}
        {@render headline(d.items.filter((it) => !it.planned))}
      {/if}
    </section>
    <section class="ledger">
      <p class="label">Items</p>
      <div class="rows">
        {#each d.cells as c (c.item.id)}
          {@const codes = status[snap]![c.item.idx]!}
          <button
            class="row itemrow"
            type="button"
            onclick={() => onfocus({ level: "item", cell: c })}
          >
            <span class="name">{c.item.label}</span>
            <span class="n dots">
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
        {/each}
      </div>
    </section>
  {:else if shown}
    {@const c = { item: shown }}
    {@const codes = status[snap]![c.item.idx]!}
    {#if c.item.planned?.kind === "scenario"}
      {@const p = c.item.planned}
      <section class="ledger">
        <h2>{c.item.label}</h2>
        <p class="sub">{islandTitle(c.item)}, planned scenario</p>
        <p class="note">
          Written and tagged planned, so scheduled runs list it but never run
          it.{p.waitingOn ? " " + p.waitingOn : ""}
        </p>
        <dl class="kv">
          <dt>Scenario</dt>
          <dd><code>{p.scenarioId}</code></dd>
          <dt>Feature</dt>
          <dd>{p.feature}</dd>
          <dt>Would run on</dt>
          <dd>{c.item.envs.map((e) => ENV_LABEL[e]).join(", ")}</dd>
        </dl>
      </section>
    {:else if c.item.planned?.kind === "issue"}
      {@const p = c.item.planned}
      <section class="ledger">
        <h2>{c.item.label}</h2>
        <p class="sub">{islandTitle(c.item)}, open issue</p>
        <p class="note">
          Not built yet: {p.board} on the Engineering Board, still open as of {formatPacificDay(
            boardSource.checkedAt,
          )}. When it ships, a scenario written for it lights this hex.
        </p>
        <dl class="kv">
          <dt>Issue</dt>
          <dd>
            <a href={p.url} target="_blank" rel="noreferrer"
              >{c.item.id.replace("planned:", "")}</a
            >
          </dd>
          <dt>Area</dt>
          <dd>{p.area}</dd>
          {#if p.personas.length}<dt>For</dt>
            <dd>
              {p.personas
                .map((id) => model.defById.get(id)?.name ?? id)
                .join(", ")}
            </dd>{/if}
        </dl>
      </section>
    {:else}
      {@const fails = itemFailures(c.item, snap, env === "all" ? ENVS : [env])}
      {@const pageItem = c.item.page
        ? items.find((x) => x.id === c.item.page)
        : undefined}
      {@const parentItem = c.item.parent
        ? items.find((x) => x.id === c.item.parent)
        : undefined}
      {@const proved = provedBy(c.item)}
      <section class="ledger">
        <h2>{c.item.label}</h2>
        <p class="sub">
          {#if c.item.kind === "Element" && pageItem}
            An element on the page
            <a
              href={nav.href({ view: "map", itemId: pageItem.id })}
              onclick={(e) =>
                inPage(e) && nav.go({ view: "map", itemId: pageItem.id })}
              >{pageItem.label.replace(/^Page /, "")}</a
            >, {islandTitle(c.item)}
          {:else if c.item.kind === "Element" && c.item.usedBy?.length}
            An element of the {islandTitle(c.item)} rendered on {c.item.usedBy
              .length} pages: {#each c.item.usedBy as pid, i (pid)}{@const pg =
                items.find((x) => x.id === pid)}{#if pg}<a
                  href={nav.href({ view: "map", itemId: pg.id })}
                  onclick={(e) =>
                    inPage(e) && nav.go({ view: "map", itemId: pg.id })}
                  >{pg.label.replace(/^Page /, "")}</a
                >{i < c.item.usedBy.length - 1 ? ", " : ""}{/if}{/each}
          {:else if c.item.kind === "Element"}
            An element of the {islandTitle(c.item)}, {c.item.area}, not tied to
            one page
          {:else if c.item.parent && parentItem}
            {c.item.kind} on
            <a
              href={nav.href({ view: "map", itemId: parentItem.id })}
              onclick={(e) =>
                inPage(e) && nav.go({ view: "map", itemId: parentItem.id })}
              >{parentItem.label}</a
            >, {islandTitle(c.item)}
          {:else}
            {c.item.kind} on {islandTitle(c.item)}, {c.item.area}
          {/if}
        </p>
        <div class="envgrid">
          {#each homesOf(c.item).filter((h) => env === "all" || h.env === env) as h (h.env)}
            {@const i = ENVS.indexOf(h.env)}
            <div class="envcell">
              <b>{h.label}</b><span class="state"
                ><i
                  class:never={codes[i] === -1}
                  style:background={CODE_COLOR[codes[i]!]}
                ></i>{CODE_LABEL[codes[i]!]}</span
              ><VerdictAge {model} item={c.item} env={h.env} {snap} />
            </div>
          {/each}
        </div>
        <VerdictNotes {model} item={c.item} {env} {snap} {nav} />
        {#if fails.length}
          <FailureNotes
            notes={fails}
            {nav}
            dest={(n) => scenarioDest(c.item, n.scenario.id)}
            from={(n, what) => ({
              focus: `fail-${what === "shot" ? "shot" : "scenario"}:${n.env}`,
            })}
          />
        {/if}
        {#if c.item.links?.length}
          <dl class="kv">
            <dt>View</dt>
            <dd>
              {#each c.item.links as l, i (l.url)}{i > 0 ? ", " : ""}<a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  >{l.env ? ENV_LABEL[l.env] : readableUrl(l.url)}</a
                >{/each}<small class="outside">opens outside</small>
            </dd>
          </dl>
        {/if}
        <p class="copyline">
          <button
            type="button"
            class="copy"
            onclick={() =>
              copyLink(c.item.id, nav.url({ view: "map", itemId: c.item.id }))}
            >Copy link</button
          ><span class="copied" aria-live="polite"
            >{copied?.id === c.item.id && copied.ok ? "Link copied" : ""}</span
          >
        </p>
        {#if copied?.id === c.item.id && !copied.ok}
          <label class="manual"
            >The page cannot reach the clipboard here; copy this link:
            <input
              readonly
              value={copied.url}
              onfocus={(e) => e.currentTarget.select()}
            /></label
          >
        {/if}
      </section>
      <section class="ledger">
        <p class="label">
          {proved && (env === "all" || proved.env !== env)
            ? `Proved on ${whereLabel(c.item, proved.env).toLowerCase()} by`
            : "Proved by"}
        </p>
        {#if proved}
          <div class="rows">
            {#each proved.rows as p (p.d.id)}
              <a
                class="row itemrow"
                href={nav.href({
                  ...scenarioDest(c.item, p.d.id),
                  ...(p.step ? { step: p.step.n } : {}),
                })}
                data-return="item-proof:{p.d.id}"
                onclick={(e) =>
                  inPage(e) &&
                  nav.go(
                    {
                      ...scenarioDest(c.item, p.d.id),
                      ...(p.step ? { step: p.step.n } : {}),
                    },
                    { focus: `item-proof:${p.d.id}` },
                  )}
              >
                <span class="name wrap"
                  >{p.d.name}<small
                    >{p.step ? `Step ${p.step.n}: ${p.step.text}. ` : ""}{p
                      .needs.length
                      ? `${p.needs.map((n) => NEED_LABEL[n] ?? n).join(", ")}. `
                      : ""}Verified {formatPacific(p.at)}.</small
                  ></span
                >
              </a>
            {/each}
          </div>
        {:else if itemScenarios(c.item).length}
          <p class="note">
            Not verified {env === "all"
              ? "in any environment"
              : `on ${ENV_LABEL[env].toLowerCase()}`} at this point.
          </p>
        {:else}
          <p class="note">No scenario reaches it yet. This is a named gap.</p>
        {/if}
      </section>
      {#if c.item.needs?.length}
        {@const needs = needProofs(c.item, snap)}
        <section class="ledger">
          <p class="label">What it must prove</p>
          <ul class="elements needs">
            {#each needs as n (n.need)}
              <li>
                <span class="name"
                  >{n.label}{#if !n.required}<small
                      >Beyond what it must prove</small
                    >{:else if !n.scenarios.length}<small class="gap"
                      >Nothing proves this yet</small
                    >{/if}</span
                >
                <span class="n dots">
                  {#each ENV_ORDER as e (e)}
                    {@const code = n.proof[e]
                      ? 3
                      : c.item.envs.includes(e)
                        ? 0
                        : -1}
                    <i
                      class:never={code === -1}
                      style:background={CODE_COLOR[code]}
                      title="{ENV_LABEL[e]}: {n.proof[e]
                        ? `verified ${formatPacific(n.proof[e].at)}`
                        : CODE_LABEL[code]}"
                    ></i>
                  {/each}
                </span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
      {#each [{ label: "Documents", rows: documentsOf(c.item), sources: [] }, { label: "Documented by", rows: documentedBy(c.item), sources: docSources(c.item) }] as docs (docs.label)}
        {#if docs.rows.length || docs.sources.length}
          <section class="ledger">
            <p class="label">{docs.label}</p>
            <div class="rows">
              {#each foldDocs(docs.rows) as g (g.head.id)}
                <a
                  class="row itemrow"
                  href={nav.href({ view: "map", itemId: g.head.id })}
                  onclick={(e) =>
                    inPage(e) && nav.go({ view: "map", itemId: g.head.id })}
                >
                  <span class="name wrap"
                    >{g.head.label}<small
                      >{islandTitle(g.head)}, {g.head.area}{g.parts.length
                        ? `, with ${g.parts.length} of its parts`
                        : ""}</small
                    ></span
                  >
                </a>
              {/each}
              {#each docs.sources as d (d.id)}
                <a
                  class="row itemrow"
                  href={d.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span class="name wrap"
                    >{d.title}<small>{DOC_KIND[d.kind]}, opens outside</small
                    ></span
                  >
                </a>
              {/each}
            </div>
          </section>
        {/if}
      {/each}
      {@const ctrls = elementsOf(c.item).filter((x) => x.kind === "Element")}
      {#if ctrls.length}
        {@const groups = componentGroups(ctrls)}
        <section class="ledger">
          <p class="label">
            {c.item.kind === "Page" ? "Elements on this page" : "Elements"}
          </p>
          <p class="note">
            {shortCount(model, ctrls, snap, env)}.
          </p>
          <details class="more">
            <summary
              >The {countOf(ctrls.length, "element")}{groups.length > 1
                ? `, in ${groups.length} components`
                : ""}</summary
            >
            {#each groups as g (g.name)}
              {#if groups.length > 1}
                <p class="component">
                  <a
                    href={nav.href(districtDest(g))}
                    onclick={(e) => inPage(e) && nav.go(districtDest(g))}
                    >{g.name}</a
                  ><span>{shortCount(model, g.items, snap, env)}</span>
                </p>
              {/if}
              <ul class="elements">
                {#each g.items as x (x.id)}
                  {@render partRow(x)}
                {/each}
              </ul>
            {/each}
          </details>
        </section>
      {/if}
      {@const shared = sharedElementsOn(c.item)}
      {#if shared.length}
        <section class="ledger">
          <p class="label">Elements shared with other pages</p>
          <p class="note">
            Rendered here and elsewhere, so they live on the Shared elements
            hex. {shortCount(model, shared, snap, env)}.
          </p>
          <details class="more">
            <summary>The {countOf(shared.length, "shared element")}</summary>
            {#each componentGroups(shared) as g (g.name)}
              <p class="component">
                <a
                  href={nav.href(districtDest(g))}
                  onclick={(e) => inPage(e) && nav.go(districtDest(g))}
                  >{g.name}</a
                ><span>{shortCount(model, g.items, snap, env)}</span>
              </p>
              <ul class="elements">
                {#each g.items as x (x.id)}
                  {@render partRow(x)}
                {/each}
              </ul>
            {/each}
          </details>
        </section>
      {/if}
      {@const parts = childrenOf(c.item).filter((x) => x.kind !== "Element")}
      {#if parts.length}
        <section class="ledger">
          <p class="label">What it holds</p>
          <p class="note">
            {countOf(parts.length, "part")}, each an item of its own: {shortCount(
              model,
              parts,
              snap,
              env,
            )}.
          </p>
          <p class="note">
            <a
              href={nav.href({ view: "map", inside: c.item.id })}
              onclick={(e) =>
                inPage(e) && nav.go({ view: "map", inside: c.item.id })}
              >Open as a map</a
            >
          </p>
        </section>
      {/if}
      {@const proofIds = new Set(proved?.rows.map((p) => p.d.id) ?? [])}
      {@const scen = itemScenarios(c.item).filter((s) => !proofIds.has(s.id))}
      {@const rel = relatedItems(c.item)}
      {#if scen.length || rel.length}
        <section class="ledger folds">
          {#if scen.length}
            <details class="more">
              <summary
                >Reached by {scen.length}
                {proofIds.size ? "more" : ""}
                {scen.length === 1 ? "scenario" : "scenarios"} on the way</summary
              >
              <div class="rows">
                {#each scen as sc (sc.id)}
                  {@const res = scenarioResults(sc, snap)}
                  <a
                    class="row itemrow"
                    href={nav.href(scenarioDest(c.item, sc.id))}
                    data-return="item-scenario:{sc.id}"
                    onclick={(e) =>
                      inPage(e) &&
                      nav.go(scenarioDest(c.item, sc.id), {
                        focus: `item-scenario:${sc.id}`,
                      })}
                  >
                    <span class="name wrap"
                      >{sc.name}<small>{sc.feature}</small></span
                    >
                    <span class="n dots">
                      {#each ENV_ORDER as e (e)}
                        {@const i = ENVS.indexOf(e)}
                        {@const r = res[i]!}
                        <i
                          class:never={r === "none"}
                          style:background={RUN_COLOR[r]}
                          title="{ENV_LABEL[ENVS[i]!]}: {RUN_LABEL[r]}"
                        ></i>
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
            </details>
          {/if}
          {#if rel.length}
            <details class="more">
              <summary
                >{c.item.surface === "api"
                  ? `Used by ${rel.length} ${rel.length === 1 ? "page, command or tool" : "pages, commands and tools"}`
                  : `Uses ${countOf(rel.length, "API operation")}`}</summary
              >
              <p class="note">
                {#if c.item.surface === "api"}
                  What calls this operation, going by the scenarios that touch
                  both.
                {:else}
                  API operations the scenarios that touch it also call, their
                  setup included.
                {/if}
              </p>
              <div class="rows">
                {#each rel as r (r.item.id)}
                  <a
                    class="row itemrow"
                    href={nav.href({ view: "map", itemId: r.item.id })}
                    onclick={(e) =>
                      inPage(e) && nav.go({ view: "map", itemId: r.item.id })}
                  >
                    <span class="name wrap"
                      >{r.item.label}<small
                        >{islandTitle(r.item)}, {r.item.area}; {r.scenarios
                          .length}
                        {r.scenarios.length === 1
                          ? "scenario"
                          : "scenarios"}{#if r.step}{@const t = detailOf(
                            r.step.scenario.id,
                          )?.steps[r.step.step]?.t}. Step {r.step.step + 1}{t
                            ? `: ${t}`
                            : ""}{:else if r.setupOnly}. In setup only{/if}</small
                      ></span
                    >
                  </a>
                {/each}
              </div>
            </details>
          {/if}
        </section>
      {/if}
      <details class="more">
        <summary>Details</summary>
        <dl class="kv">
          <dt>Id</dt>
          <dd><code>{c.item.id}</code></dd>
        </dl>
      </details>
    {/if}
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
  h2 {
    margin: 0 0 2px;
    font-family: var(--display);
    font-stretch: 112%;
    font-size: 18px;
    font-weight: 700;
    text-wrap: balance;
    overflow-wrap: anywhere;
  }
  .sub {
    color: var(--ink-2);
    font-size: 13px;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .figure {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-top: 12px;
    flex-wrap: wrap;
  }
  .figure strong {
    font-family: var(--display);
    font-size: 34px;
    font-weight: 700;
    line-height: 1;
  }
  .figure span {
    color: var(--ink-2);
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
    grid-template-columns: auto minmax(0, 1fr);
    gap: 5px 10px;
    cursor: pointer;
  }
  .row:hover {
    background: var(--ground-2);
  }
  .row.itemrow {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
  }
  .row.itemrow .name {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  a.row {
    text-decoration: none;
    box-sizing: border-box;
  }
  .why {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    font-size: 12.5px;
    color: var(--ink-2);
    display: grid;
    gap: 3px;
  }
  .why li.under {
    padding-left: 12px;
  }
  .label.pipe {
    margin-top: 14px;
  }
  .note.tight {
    margin-top: 2px;
  }
  details.more {
    font-size: 12.5px;
  }
  details.more summary {
    padding: 4px 0;
  }
  .folds {
    display: grid;
    gap: 8px;
  }
  .copyline {
    margin: 10px 0 0;
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .copy {
    appearance: none;
    border: 1px solid var(--rule);
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    font-size: 12.5px;
    border-radius: var(--r-s);
    padding: 3px 10px;
    cursor: pointer;
  }
  .copy:hover {
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
    margin-top: 8px;
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
  .name.wrap {
    white-space: normal;
    display: flex;
    flex-direction: column;
    overflow-wrap: anywhere;
  }
  .name.wrap small {
    font-size: 11.5px;
  }
  .name {
    min-width: 0;
    white-space: nowrap;
  }
  .n {
    color: var(--ink-2);
    font-size: 12.5px;
    text-align: right;
  }
  .component {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin: 12px 0 0;
    font-size: 13px;
    font-weight: 600;
  }
  .component span {
    font-weight: 400;
    color: var(--ink-3);
  }
  .component a,
  .elements a.name {
    color: var(--ink);
  }
  .elements {
    list-style: none;
    margin: 6px 0 14px;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  .elements li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .elements .name {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .needs .name small {
    display: block;
    color: var(--ink-3);
  }
  .needs .name small.gap {
    color: var(--fail);
  }
  .dots {
    display: inline-flex;
    gap: 4px;
    align-items: center;
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
  a {
    color: var(--accent);
  }
  small {
    color: var(--ink-3);
  }
  .note {
    font-size: 12.5px;
    color: var(--ink-2);
    margin: 8px 0 0;
    overflow-wrap: anywhere;
  }
  details {
    margin-top: 12px;
    font-size: 12.5px;
  }
  summary {
    cursor: pointer;
    color: var(--accent);
  }
  .envgrid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-top: 12px;
  }
  .envcell {
    border: 1px solid var(--rule);
    border-radius: var(--r-s);
    padding: 8px;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .state {
    display: flex;
    gap: 6px;
    align-items: baseline;
    color: var(--ink-2);
  }
  .state i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
    display: inline-block;
  }
  .state i.never {
    border: 1px dashed var(--land-edge);
    box-sizing: border-box;
  }
  .kv {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 12px;
    font-size: 12.5px;
    margin-top: 12px;
  }
  .kv dt {
    color: var(--ink-3);
  }
  .kv dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .kv .outside {
    margin-left: 6px;
    color: var(--ink-3);
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
