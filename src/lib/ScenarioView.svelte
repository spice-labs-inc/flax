<script lang="ts">
  import { onMount } from "svelte";
  import LiveScenario from "./LiveScenario.svelte";
  import Mark from "./Mark.svelte";
  import type { MarkKind } from "./data.ts";
  import {
    ENV_LABEL,
    ENVS,
    ENV_ORDER,
    formatPacific,
    formatPacificDay,
    type Env,
    type EnvChoice,
    type Item,
    CONFIG,
    envsProse,
    excludedOn,
  } from "./data.ts";
  import { copyText, type Nav } from "./nav.ts";
  import {
    STEP_LABEL,
    formatMs,
    lastWhere,
    tagLabel,
    type GherkinStep,
    type ScenarioDetail,
    type ScenarioRecord,
    type StepCode,
  } from "./scenarios.ts";
  import type { ScenarioRun } from "./live.svelte.ts";
  import type { Model } from "./model.ts";

  let {
    model,
    detail: d,
    liveRuns = [],
    env,
    snap,
    step = $bindable(null),
    from,
    back,
    nav,
    onclose,
  }: {
    model: Model;
    detail: ScenarioDetail;
    /** This scenario in the runs in progress, as the live stream has it. */
    liveRuns?: ScenarioRun[];
    env: EnvChoice;
    snap: number;
    step?: number | null;
    from: Item | null;
    /** Where Esc and the back link go: the view the scenario was opened from. */
    back: { label: string; href: string };
    nav: Nav;
    onclose: () => void;
  } = $props();
  let { recordAt, runs, shots } = $derived(model);

  interface Lane {
    env: Env;
    rec: ScenarioRecord | undefined;
    applies: boolean;
    /** The record ran the steps shown; false when the feature changed since. */
    aligned: boolean;
    codes: string;
  }

  /** Step codes for a record; a run without messages only knows where it failed. */
  function codesOf(r: ScenarioRecord, n: number): string {
    if (r.codes) return r.codes;
    const at = r.failure?.at ?? -1;
    if (r.status === "p") return "p".repeat(n);
    if (at < 0) return "s".repeat(n);
    return "p".repeat(at) + "f" + "s".repeat(Math.max(0, n - at - 1));
  }

  let lanes: Lane[] = $derived(
    ENV_ORDER.map((e) => {
      const rec = recordAt(d, e, snap);
      return {
        env: e,
        rec,
        applies: d.applies.includes(e),
        aligned: !rec?.steps,
        codes: rec ? codesOf(rec, d.steps.length) : "",
      };
    }),
  );
  let ran = $derived(lanes.filter((l) => l.rec));
  let maxMs = $derived(
    Math.max(
      1,
      ...lanes.flatMap((l) => (l.aligned ? (l.rec?.stepMs ?? []) : [])),
    ),
  );

  const KIND: Record<StepCode, MarkKind> = {
    p: "pass",
    f: "fail",
    s: "skip",
    u: "planned",
    n: "planned",
    a: "other",
  };

  const names = (envs: Env[]) => {
    const l = envs.map((e) => ENV_LABEL[e]);
    return l.length < 2
      ? (l[0] ?? "")
      : `${l.slice(0, -1).join(", ")} and ${l.at(-1)}`;
  };

  function failedWhere(r: ScenarioRecord): string {
    const at = r.failure?.at;
    if (at === undefined) return "";
    if (at >= 0) return ` at step ${at + 1}`;
    if (at === -1) return " while setting up";
    if (at === -2) return " while cleaning up";
    return "";
  }

  function neverReason(e: Env): string {
    const pinned = ENVS.filter((x) => d.tags.includes(`@env:${x}`));
    if (pinned.length && !pinned.includes(e))
      return `Pinned to ${names(pinned)}`;
    const excluded = excludedOn(d.tags, e);
    if (excluded)
      return `${CONFIG.tagLabels[excluded] ?? `Tagged ${excluded}`}: left out of ${ENV_LABEL[e]} runs`;
    if (
      CONFIG.envs.find((x) => x.name === e)?.fixtures !== "always" &&
      d.tags.includes("@fixture")
    )
      return `${ENV_LABEL[e]} runs never create fixtures`;
    return "Not scheduled here";
  }

  let summary = $derived.by(() => {
    if (!ran.length) return "No environment had run it by this point.";
    const pass = ran.filter((l) => l.rec!.status === "p").map((l) => l.env);
    const fail = ran.filter((l) => l.rec!.status === "f");
    const other = ran.filter((l) => !"pf".includes(l.rec!.status));
    const never = lanes.filter((l) => !l.rec && !l.applies).map((l) => l.env);
    const parts: string[] = [];
    if (pass.length === ran.length)
      parts.push(
        ran.length === 1
          ? `Verified on ${names(pass)}`
          : `Verified on ${names(pass)}, the same everywhere it ran`,
      );
    else {
      if (pass.length) parts.push(`Verified on ${names(pass)}`);
      const where = new Map<string, Env[]>();
      for (const l of fail) {
        const w = failedWhere(l.rec!);
        where.set(w, [...(where.get(w) ?? []), l.env]);
      }
      for (const [w, envs] of where) parts.push(`fails on ${names(envs)}${w}`);
      if (other.length)
        parts.push(`did not finish on ${names(other.map((l) => l.env))}`);
    }
    let text = parts.join(", ").replace(/^./, (c) => c.toUpperCase()) + ".";
    if (never.length) text += ` Never runs on ${names(never)}.`;
    const timed = ran.filter((l) => l.rec!.ms > 0);
    if (timed.length > 1) {
      const slow = timed.reduce((a, b) => (b.rec!.ms > a.rec!.ms ? b : a));
      const fast = timed.reduce((a, b) => (b.rec!.ms < a.rec!.ms ? b : a));
      const ratio = slow.rec!.ms / fast.rec!.ms;
      if (ratio >= 1.5 && slow.rec!.ms - fast.rec!.ms >= 2000)
        text += ` ${ENV_LABEL[slow.env]} took ${ratio.toFixed(1)} times as long as ${ENV_LABEL[fast.env]}.`;
    }
    return text;
  });
  let differs = $derived(
    new Set(ran.map((l) => `${l.rec!.status}${failedWhere(l.rec!)}`)).size > 1,
  );

  function rowDiffers(i: number): boolean {
    const codes = lanes
      .filter((l) => l.rec && l.aligned)
      .map((l) => l.codes[i] ?? "s");
    return new Set(codes).size > 1;
  }

  /** How much slower than the quickest env this lane ran a step, when it is markedly slower. */
  function slower(i: number, lane: Lane): number | null {
    const ms = lane.rec?.stepMs[i];
    if (!ms || !lane.aligned) return null;
    const others = lanes
      .filter((l) => l.rec && l.aligned && (l.rec.stepMs[i] ?? 0) > 0)
      .map((l) => l.rec!.stepMs[i]!);
    const min = Math.min(...others);
    return others.length > 1 && ms >= min * 2 && ms - min >= 1000
      ? ms / min
      : null;
  }

  interface FailGroup {
    envs: Env[];
    message: string;
    /** The step it names, if any, and the error's first line; the rest folds. */
    head: string;
    rest: string;
    key: string;
    shots: { env: Env; src: string; at: string; own: boolean }[];
  }

  /** Ids, hashes and counts differ from run to run; the failure is the same without them. */
  const sameness = (m: string) =>
    m
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        "",
      )
      .replace(/\b[0-9a-f]{7,}\b/gi, "")
      .replace(/\d+/g, "");

  /** Failures at one place, envs that failed the same way together; -4 gathers step failures of records that ran an earlier version of the steps. */
  function failuresAt(at: number): FailGroup[] {
    const groups: FailGroup[] = [];
    for (const l of lanes) {
      const f = l.rec?.failure;
      if (!f) continue;
      const older = f.at >= 0 && !l.aligned;
      if (!(at === -4 ? older : f.at === at && !older)) continue;
      const own = older ? l.rec?.steps?.[f.at] : undefined;
      const message =
        at === -3 && f.step
          ? `${f.step}\n${f.message}`
          : own
            ? `Step ${f.at + 1}, ${own.k} ${own.t}\n${f.message}`
            : f.message;
      const key = sameness(message);
      let g = groups.find((x) => x.key === key);
      if (!g) {
        const lines = message.split("\n");
        const shown = (at === -3 && f.step) || own ? 2 : 1;
        g = {
          envs: [],
          message,
          head: lines.slice(0, shown).join("\n"),
          rest: lines.slice(shown).join("\n").trim(),
          key,
          shots: [],
        };
        groups.push(g);
      }
      g.envs.push(l.env);
      const shot = shotFor(l.env, l.rec!);
      if (shot) g.shots.push(shot);
    }
    return groups;
  }

  /** The record's own screenshot, or the env's newest kept failure screenshot when this one was not kept. */
  function shotFor(e: Env, r: ScenarioRecord) {
    if (r.shot && shots[r.shot])
      return {
        env: e,
        src: shots[r.shot]!,
        at: runs[r.run]!.finishedAt,
        own: true,
      };
    const kept = lastWhere(d.records[e], (x) => !!x.shot && !!shots[x.shot]);
    return kept
      ? {
          env: e,
          src: shots[kept.shot!]!,
          at: runs[kept.run]!.finishedAt,
          own: false,
        }
      : null;
  }

  /** Quoted values in a step stand out from the sentence around them. */
  function pieces(text: string): { t: string; q: boolean }[] {
    return text
      .split(/("[^"]*")/)
      .filter(Boolean)
      .map((t) => ({ t, q: /^".*"$/.test(t) }));
  }

  const short = (sha: string) =>
    /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : sha;
  const featureFile = $derived(d.id.replace(/:\d+$/, ""));
  const line = $derived(d.id.match(/:(\d+)$/)?.[1] ?? "");

  let tbody = $state<HTMLElement>();
  let active = $derived(
    Math.max(0, Math.min(d.steps.length - 1, (step ?? 1) - 1)),
  );
  let heading = $state<HTMLElement>();

  onMount(() => {
    if (step !== null && step > d.steps.length) step = null;
    // After the search dialog closes, which hands focus back to where it was opened from.
    if (step === null)
      requestAnimationFrame(() => heading?.focus({ preventScroll: true }));
  });

  function focusRow(i: number) {
    const row = tbody?.querySelector<HTMLElement>(`[data-step="${i}"]`);
    if (!row) return;
    step = i + 1;
    row.focus();
  }

  function rowKey(e: KeyboardEvent, i: number) {
    const last = d.steps.length - 1;
    const to =
      e.key === "ArrowDown"
        ? Math.min(last, i + 1)
        : e.key === "ArrowUp"
          ? Math.max(0, i - 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    focusRow(to);
  }

  $effect(() => {
    if (step === null) return;
    tbody
      ?.querySelector(`[data-step="${step - 1}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });

  let copied = $state<"idle" | "done" | "manual">("idle");
  let manualUrl = $state("");
  async function copyLink() {
    const url = nav.url({ view: "map", scenario: d.id, itemId: from?.id });
    if (await copyText(url)) copied = "done";
    else {
      manualUrl = url;
      copied = "manual";
    }
  }

  let dialog = $state<HTMLDialogElement>();
  let big = $state<{ src: string; caption: string } | null>(null);
  function enlarge(src: string, caption: string) {
    big = { src, caption };
    dialog?.showModal();
  }
</script>

{#snippet stepText(s: GherkinStep, i: number)}
  <span class="num">{i + 1}</span>
  <span class="kw">{s.k}</span>
  <span class="txt"
    >{#each pieces(s.t) as p, pi (pi)}{#if p.q}<b class="arg">{p.t}</b
        >{:else}{p.t}{/if}{/each}{#if s.bg}<span class="bg">background</span
      >{/if}</span
  >
  {#if s.doc}<pre class="doc">{s.doc}</pre>{/if}
  {#if s.table}
    <table class="data">
      <tbody>
        {#each s.table as row, ri (ri)}
          <tr>
            {#each row as cell, ci (ci)}<td>{cell}</td>{/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
{/snippet}

{#snippet failRow(at: number, label: string)}
  {@const groups = failuresAt(at)}
  {#if groups.length}
    <tr class="failrow">
      <td colspan="4">
        {#each groups as g (g.envs.join())}
          <div class="fail">
            <p class="fhead">
              <Mark kind="fail" size={13} />
              <b
                >{label} on {names(g.envs)}{g.envs.length < ran.length
                  ? " only"
                  : ""}</b
              >
            </p>
            <pre class="msg">{g.head || "No message was recorded."}</pre>
            {#if g.rest}
              <details class="msgmore">
                <summary>The rest of the error</summary>
                <pre class="msg">{g.rest}</pre>
              </details>
            {/if}
            {#if g.shots.length}
              <div class="shots">
                {#each g.shots as s (s.env)}
                  {@const caption = `${ENV_LABEL[s.env]}, ${formatPacific(s.at)}`}
                  <figure>
                    <button
                      type="button"
                      class="thumb"
                      onclick={() =>
                        enlarge(
                          s.src,
                          `Screenshot when it failed on ${caption}`,
                        )}
                      aria-label="Enlarge the screenshot from {caption}"
                    >
                      <img
                        src={s.src}
                        alt="The page when it failed on {caption}"
                      />
                    </button>
                    <figcaption>
                      {#if s.own}
                        Screenshot from {ENV_LABEL[s.env]} as it failed
                      {:else}
                        {ENV_LABEL[s.env]}'s newest kept failure screenshot,
                        from {formatPacific(s.at)}
                      {/if}
                    </figcaption>
                  </figure>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </td>
    </tr>
  {/if}
{/snippet}

<article class="sheet" aria-labelledby="scenario-title">
  <header class="head">
    <a
      class="back"
      href={back.href}
      onclick={(e) => {
        if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          onclose();
        }
      }}
      ><svg viewBox="0 0 16 16" aria-hidden="true"
        ><path
          d="M10 3 L5 8 L10 13"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
        ></path></svg
      >{back.label}<kbd>Esc</kbd></a
    >
    <p class="feature">{d.feature}</p>
    <h2 id="scenario-title" tabindex="-1" bind:this={heading}>{d.name}</h2>
    {#if d.description}<p class="desc">{d.description}</p>{/if}
    <div class="meta">
      <ul class="tags" aria-label="Tags">
        {#each d.tags as t (t)}<li class="chip">{tagLabel(t)}</li>{/each}
      </ul>
      <span class="where">{featureFile}, line {line}</span>
      <button type="button" class="btn" onclick={copyLink}>Copy link</button>
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
          onfocus={(e) => e.currentTarget.select()}
        /></label
      >
    {/if}
  </header>

  <LiveScenario runs={liveRuns} steps={d.steps} />

  <p class="summary" class:differs>{summary}</p>

  <div class="tablewrap">
    <table class="steps" class:one={env !== "all"}>
      <caption class="sr"
        >Each step of the scenario and its result in {envsProse(
          undefined,
          true,
        )}</caption
      >
      <thead>
        <tr>
          <th scope="col" class="corner">Step</th>
          {#each lanes as l (l.env)}
            <th
              scope="col"
              class="lane"
              class:sel={env === l.env}
              class:never={!l.rec && !l.applies}
            >
              <span class="ename">{ENV_LABEL[l.env]}</span>
              {#if l.rec}
                {@const run = runs[l.rec.run]!}
                <span class="res res-{l.rec.status}"
                  ><Mark
                    kind={l.rec.status === "p"
                      ? "pass"
                      : l.rec.status === "f"
                        ? "fail"
                        : "other"}
                    size={13}
                  />{l.rec.status === "p"
                    ? "Verified"
                    : l.rec.status === "f"
                      ? "Failed"
                      : STEP_LABEL[l.rec.status]}{failedWhere(l.rec)}</span
                >
                <span class="dl">
                  <span>{formatMs(l.rec.ms)}</span>
                  <span>{formatPacific(run.finishedAt)}</span>
                  {#each run.versions as v (v.service)}
                    <span title={v.release}
                      >Against {v.service}
                      {v.release ? short(v.release) : "unknown"}{v.builtAt
                        ? `, built ${formatPacificDay(v.builtAt)}`
                        : ""}</span
                    >
                  {/each}
                  {#if run.workflowRun}
                    <a href={run.workflowRun} target="_blank" rel="noreferrer"
                      >Run log on GitHub</a
                    >
                  {/if}
                </span>
                {#if !l.aligned}
                  <span class="note">Ran an earlier version of these steps</span
                  >
                {/if}
              {:else if l.applies}
                <span class="res"><Mark kind="none" size={13} />No run yet</span
                >
                <span class="dl"
                  ><span>Nothing recorded by this point</span></span
                >
              {:else}
                <span class="res"
                  ><Mark kind="never" size={13} />Never runs here</span
                >
                <span class="dl"><span>{neverReason(l.env)}</span></span>
              {/if}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody bind:this={tbody}>
        {@render failRow(-1, "Failed while setting up")}
        {#each d.steps as s, i (i)}
          {@const diff = rowDiffers(i)}
          {@const logs = lanes.filter((l) => l.aligned && l.rec?.logs?.[i])}
          <tr
            class="step"
            class:diff
            class:cur={step === i + 1}
            data-step={i}
            tabindex={i === active ? 0 : -1}
            onfocus={() => (step = i + 1)}
            onkeydown={(e) => rowKey(e, i)}
          >
            <th scope="row">
              <span class="stext">{@render stepText(s, i)}</span>
              {#if diff}<span class="diffnote"
                  >Differs between environments</span
                >{/if}
              {#if logs.length}
                <details class="logs">
                  <summary>What it printed</summary>
                  {#each logs as l (l.env)}
                    <p class="lenv">{ENV_LABEL[l.env]}</p>
                    <pre>{l.rec!.logs![i]}</pre>
                  {/each}
                </details>
              {/if}
            </th>
            {#each lanes as l (l.env)}
              {@const code = l.aligned
                ? (l.codes[i] as StepCode | undefined)
                : undefined}
              {@const ms = l.aligned ? (l.rec?.stepMs[i] ?? 0) : 0}
              {@const failAt = l.codes.indexOf("f")}
              {@const x = slower(i, l)}
              <td
                class="cell"
                class:sel={env === l.env}
                class:never={!l.rec && !l.applies}
                class:stranded={failAt >= 0 && i > failAt}
                class:first={i === 0}
                class:last={i === d.steps.length - 1}
              >
                {#if code}
                  <span class="station">
                    <Mark kind={KIND[code]} size={15} />
                    <span class="cl">
                      <span class="ctext"
                        >{code === "p"
                          ? ms
                            ? formatMs(ms)
                            : "Verified"
                          : STEP_LABEL[code]}{code !== "p" && ms
                          ? `, ${formatMs(ms)}`
                          : ""}</span
                      >
                      {#if ms}
                        <span class="dbar"
                          ><i style:width="{Math.sqrt(ms / maxMs) * 100}%"
                          ></i></span
                        >
                      {/if}
                      {#if x}<span class="slow">{x.toFixed(1)}x slower</span
                        >{/if}
                    </span>
                  </span>
                {:else if l.rec}
                  <span class="cl ctext muted">Not in that run</span>
                {/if}
              </td>
            {/each}
          </tr>
          {@render failRow(i, `Failed at step ${i + 1}`)}
        {/each}
        {@render failRow(-2, "Failed while cleaning up")}
        {@render failRow(-3, "Failed")}
        {@render failRow(
          -4,
          "Failed, running an earlier version of these steps,",
        )}
      </tbody>
    </table>
  </div>
</article>

<dialog
  bind:this={dialog}
  class="big"
  aria-label={big?.caption ?? "Screenshot"}
  onclose={() => (big = null)}
  onclick={(e) => e.target === dialog && dialog?.close()}
>
  {#if big}
    <figure>
      <img src={big.src} alt={big.caption} />
      <figcaption>
        {big.caption}
        <button type="button" class="btn" onclick={() => dialog?.close()}
          >Close <kbd>Esc</kbd></button
        >
      </figcaption>
    </figure>
  {/if}
</dialog>

<style>
  .sheet {
    padding: 18px 28px 40px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--accent);
    font-size: 13px;
    text-decoration: none;
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .back:hover {
    text-decoration: underline;
  }
  .back svg {
    width: 14px;
    height: 14px;
    flex: none;
  }
  .back kbd {
    margin-left: 4px;
  }
  .feature {
    margin: 10px 0 0;
    color: var(--ink-2);
    font-size: 13px;
  }
  /* Only a landing spot for focus when the scenario opens, never tabbed to. */
  h2:focus {
    outline: none;
  }
  h2 {
    margin: 2px 0 0;
    font-family: var(--display);
    font-stretch: 112%;
    font-weight: 700;
    font-size: 24px;
    line-height: 1.2;
    text-wrap: balance;
    overflow-wrap: anywhere;
  }
  .desc {
    margin: 6px 0 0;
    color: var(--ink-2);
    max-width: 72ch;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin-top: 10px;
  }
  .tags {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    padding: 1px 8px;
  }
  .where {
    color: var(--ink-2);
    font-size: 12.5px;
    overflow-wrap: anywhere;
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
    align-items: center;
    gap: 8px;
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
  .summary {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    padding: 9px 14px;
    border-radius: var(--r-s);
    background: var(--panel);
    border: 1px solid var(--rule);
    max-width: 90ch;
  }
  .summary.differs {
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .tablewrap {
    min-width: 0;
  }
  .steps {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    table-layout: fixed;
  }
  .corner {
    width: auto;
    text-align: left;
    vertical-align: bottom;
    font-size: 12px;
    color: var(--ink-2);
    font-weight: 400;
    padding: 0 10px 8px 0;
  }
  .lane {
    width: 21%;
    text-align: left;
    vertical-align: top;
    font-weight: 400;
    padding: 10px 12px 12px;
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
    background: var(--panel);
  }
  .lane:nth-child(2) {
    border-left: 1px solid var(--rule);
    border-top-left-radius: var(--r-s);
  }
  .lane:last-child {
    border-right: 1px solid var(--rule);
    border-top-right-radius: var(--r-s);
  }
  .lane + .lane {
    border-left: 1px solid var(--rule);
  }
  .lane.sel,
  .cell.sel {
    background: color-mix(in srgb, var(--accent-soft) 70%, var(--panel));
  }
  .lane.sel .ename::after {
    content: ", selected";
    font-weight: 400;
    color: var(--ink-2);
    font-family: var(--text);
    font-stretch: 100%;
    font-size: 12px;
  }
  .ename {
    display: block;
    font-family: var(--display);
    font-stretch: 112%;
    font-weight: 700;
    font-size: 15px;
  }
  .res {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    margin-top: 4px;
    font-size: 13.5px;
  }
  .res-f {
    color: var(--fail);
  }
  .dl {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 4px;
    font-size: 12px;
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
  .dl a,
  .lane a {
    color: var(--accent);
  }
  .note {
    display: block;
    margin-top: 4px;
    font-size: 12px;
    color: var(--ink-2);
  }
  .lane.never,
  .cell.never {
    background-image: repeating-linear-gradient(
      45deg,
      color-mix(in srgb, var(--land-edge) 22%, transparent) 0 1.5px,
      transparent 1.5px 7px
    );
  }

  .step th {
    text-align: left;
    font-weight: 400;
    vertical-align: top;
    padding: 10px 14px 10px 0;
    border-bottom: 1px solid var(--rule);
  }
  .stext {
    display: grid;
    grid-template-columns: 1.8em 3.6em minmax(0, 1fr);
    align-items: baseline;
  }
  .num {
    color: var(--ink-2);
    font-size: 12px;
  }
  .kw {
    color: var(--ink-2);
    font-weight: 600;
  }
  .txt {
    overflow-wrap: anywhere;
  }
  .arg {
    font-weight: 600;
    color: var(--ink);
  }
  .bg {
    margin-left: 8px;
    font-size: 11.5px;
    color: var(--ink-2);
    border: 1px dashed var(--land-edge);
    border-radius: 999px;
    padding: 0 6px;
  }
  .doc,
  .data {
    grid-column: 3;
    margin: 6px 0 0;
    font-size: 12px;
  }
  .doc {
    white-space: pre-wrap;
    background: var(--ground-2);
    padding: 6px 8px;
    border-radius: 4px;
  }
  .data {
    border-collapse: collapse;
  }
  .data td {
    border: 1px solid var(--rule);
    padding: 2px 6px;
  }
  .diffnote {
    display: inline-block;
    margin: 6px 0 0 calc(1.8em + 3.6em);
    font-size: 11.5px;
    font-weight: 600;
    color: var(--accent);
  }
  .step.diff th {
    background: color-mix(in srgb, var(--accent-soft) 55%, transparent);
  }
  .step {
    outline-offset: -2px;
  }
  .step.cur th {
    background: color-mix(in srgb, var(--accent-soft) 85%, transparent);
  }
  .logs {
    margin: 6px 0 0 calc(1.8em + 3.6em);
    font-size: 12px;
  }
  .logs summary {
    cursor: pointer;
    color: var(--accent);
  }
  .logs pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 2px 0 6px;
    color: var(--ink-2);
  }
  .lenv {
    margin: 6px 0 0;
    font-weight: 600;
  }

  .cell {
    position: relative;
    vertical-align: top;
    padding: 10px 12px 10px 34px;
    border-bottom: 1px solid var(--rule);
    border-left: 1px solid var(--rule);
  }
  .cell:last-child {
    border-right: 1px solid var(--rule);
  }
  /* The env's line runs through every step like a transit line; after a failure the rest of it is stranded. */
  .cell::before {
    content: "";
    position: absolute;
    left: 18px;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: var(--land-edge);
  }
  .cell.first::before {
    top: 18px;
  }
  .cell.last::before {
    bottom: calc(100% - 18px);
  }
  .cell.stranded::before {
    background: repeating-linear-gradient(
      to bottom,
      var(--land-edge) 0 3px,
      transparent 3px 7px
    );
  }
  .cell.never::before,
  .cell:not(:has(.station))::before {
    display: none;
  }
  .station {
    display: contents;
  }
  .station :global(.mark) {
    position: absolute;
    left: 10.5px;
    top: 11px;
  }
  .cl {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .ctext {
    font-size: 12.5px;
    color: var(--ink-2);
  }
  .muted {
    color: var(--ink-2);
  }
  .dbar {
    height: 4px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--land-edge) 35%, transparent);
    overflow: hidden;
  }
  .dbar i {
    display: block;
    height: 100%;
    background: var(--ink-3);
  }
  .slow {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink);
  }

  .failrow td {
    padding: 10px 0 14px;
    border-bottom: 1px solid var(--rule);
  }
  .fail + .fail {
    margin-top: 14px;
  }
  .fhead {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .msgmore summary {
    margin-top: 4px;
    font-size: 12px;
    color: var(--ink-2);
    cursor: pointer;
  }
  .msg {
    margin: 6px 0 0;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--fail) 8%, var(--panel));
    border: 1px solid color-mix(in srgb, var(--fail) 25%, transparent);
    border-radius: var(--r-s);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 16em;
    overflow: auto;
  }
  .shots {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 10px;
  }
  figure {
    margin: 0;
    max-width: 100%;
  }
  .thumb {
    appearance: none;
    padding: 0;
    border: 1px solid var(--rule);
    border-radius: var(--r-s);
    overflow: hidden;
    background: var(--panel);
    cursor: zoom-in;
    display: block;
    max-width: 100%;
  }
  .thumb img {
    display: block;
    width: 360px;
    max-width: 100%;
    height: auto;
  }
  .shots figcaption {
    font-size: 12px;
    color: var(--ink-2);
    margin-top: 4px;
    max-width: 360px;
  }

  .big {
    border: 0;
    padding: 0;
    background: transparent;
    max-width: min(1240px, calc(100% - 32px));
    max-height: calc(100% - 32px);
  }
  .big::backdrop {
    background: color-mix(in srgb, var(--ink) 55%, transparent);
  }
  .big figure {
    background: var(--panel);
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid var(--rule);
  }
  .big img {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 120px);
    margin: 0 auto;
  }
  .big figcaption {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    font-size: 13px;
    color: var(--ink);
  }

  @media (max-width: 860px) {
    .sheet {
      padding: 14px 16px 28px;
    }
    h2 {
      font-size: 20px;
    }
    .steps,
    .steps thead,
    .steps tbody,
    .steps tr {
      display: block;
    }
    .steps thead tr,
    .steps tr.step {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .corner {
      display: none;
    }
    .lane {
      width: auto;
      padding: 8px;
      min-width: 0;
    }
    .lane.sel .ename::after {
      content: "";
    }
    .dl a {
      display: none;
    }
    .step th {
      grid-column: 1 / -1;
      padding: 10px 0 6px;
      border-bottom: 0;
    }
    .cell {
      display: block;
      min-width: 0;
      padding: 4px 6px 10px 28px;
    }
    .cell::before {
      left: 14px;
    }
    .station :global(.mark) {
      left: 6.5px;
      top: 5px;
    }
    .cell.first::before {
      top: 12px;
    }
    .cell.last::before {
      bottom: calc(100% - 12px);
    }
    .failrow,
    .failrow td {
      display: block;
    }
    .stext {
      grid-template-columns: 1.6em 3.4em minmax(0, 1fr);
    }
    .diffnote,
    .logs {
      margin-left: calc(1.6em + 3.4em);
    }
    .thumb img {
      width: 100%;
    }
  }
</style>
