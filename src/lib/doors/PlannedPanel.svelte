<script lang="ts">
  import { doorRoute, format, type Route } from "$lib/location.ts";
  import { hrefOf } from "$lib/nav.ts";
  import type { Model } from "$lib/model.ts";
  import { SURFACE_TITLE, type Feature } from "$lib/features.ts";
  import { TYPE_LABEL, type Persona } from "$lib/personas.ts";
  import type { PlannedIssue } from "$lib/planning.ts";
  import PlannedFeatureRow from "$lib/planned/PlannedFeatureRow.svelte";
  import PlannedScenarioRow from "$lib/planned/PlannedScenarioRow.svelte";
  import {
    featureFor,
    groupByPersona,
    groupBySurface,
    headline,
    plural,
    sourceSentence,
    type PlannedScenario,
  } from "$lib/planned/planned.ts";

  let { model, route }: { model: Model; route: Route } = $props();
  let by = $derived(route.by ?? "area");

  let issues = $derived(model.plannedIssues);
  let scenarios = $derived(
    model.items.flatMap((it): PlannedScenario[] =>
      it.planned?.kind === "scenario"
        ? [
            {
              label: it.label,
              surface: it.surface,
              scenarioId: it.planned.scenarioId,
              feature: it.planned.feature,
              waitingOn: it.planned.waitingOn,
            },
          ]
        : [],
    ),
  );

  let surfaces = $derived(groupBySurface(issues, scenarios));
  let personas = $derived(groupByPersona(model.personas, issues));

  function groupHref(g: "area" | "persona"): string {
    const r = { ...route };
    if (g === "persona") r.by = "persona";
    else delete r.by;
    return hrefOf(format(r, model));
  }
  const personaHref = (id: string) =>
    hrefOf(format({ ...doorRoute(route, "personas"), persona: id }, model));
  const featureHref = (f: Feature) =>
    hrefOf(
      format(
        { ...doorRoute(route, "features"), feature: `${f.surface}/${f.stem}` },
        model,
      ),
    );
  let gapsHref = $derived(
    hrefOf(format({ ...doorRoute(route, "personas"), gaps: true }, model)),
  );

  function extendsOf(issue: PlannedIssue) {
    const f = featureFor(model.features, issue);
    return f ? { name: f.name, href: featureHref(f) } : undefined;
  }
  function servesOf(issue: PlannedIssue) {
    return issue.personas.map((id) => ({
      id,
      name: model.defById.get(id)?.name ?? id,
      href: personaHref(id),
    }));
  }
  function featureOfScenario(s: PlannedScenario) {
    const f = model.featureOf(s.scenarioId);
    return f ? { name: f.name, href: featureHref(f) } : undefined;
  }
  const personaType = (p: Persona) => TYPE_LABEL[p.type];
</script>

<div class="panel">
  <div class="reading">
    <h1>{headline(issues.length, scenarios.length)}</h1>
    <p class="source">{sourceSentence(model.boardSource)}</p>

    <nav class="by" aria-label="Grouping">
      <a
        href={groupHref("area")}
        aria-current={by === "area" ? "page" : undefined}>By area</a
      >
      <a
        href={groupHref("persona")}
        aria-current={by === "persona" ? "page" : undefined}>By persona</a
      >
    </nav>

    {#if by === "area"}
      {#each surfaces as g (g.surface)}
        <section id="area-{g.surface}">
          <h2>{g.title}</h2>
          {#if g.issues.length}
            <h3>{plural(g.issues.length, "planned feature")}</h3>
            <ul>
              {#each g.issues as issue (issue.item.id)}
                <PlannedFeatureRow
                  {issue}
                  extends={extendsOf(issue)}
                  serves={servesOf(issue)}
                  {gapsHref}
                />
              {/each}
            </ul>
          {/if}
          {#if g.scenarios.length}
            <h3>
              {plural(g.scenarios.length, "scenario")} written and waiting
            </h3>
            <ul>
              {#each g.scenarios as s (s.scenarioId)}
                <PlannedScenarioRow
                  scenario={s}
                  feature={featureOfScenario(s)}
                />
              {/each}
            </ul>
          {/if}
        </section>
      {:else}
        <p class="empty">
          Nothing is waiting: no planned feature, no scenario written ahead of
          its feature.
        </p>
      {/each}
    {:else}
      {#each personas.groups as g (g.persona.id)}
        <section id="persona-{g.persona.id}">
          <h2>
            <a href={personaHref(g.persona.id)}>{g.persona.name}</a>
            <span class="type">{personaType(g.persona)}</span>
          </h2>
          <h3>{plural(g.issues.length, "planned feature")}</h3>
          <ul>
            {#each g.issues as issue (issue.item.id)}
              <PlannedFeatureRow
                {issue}
                extends={extendsOf(issue)}
                serves={servesOf(issue)}
                {gapsHref}
              />
            {/each}
          </ul>
        </section>
      {/each}
      {#if personas.idle.length}
        <p class="idle">
          Nothing is planned yet for
          {#each personas.idle as p, i (p.id)}<a href={personaHref(p.id)}
              >{p.name}</a
            >{i < personas.idle.length - 2
              ? ", "
              : i === personas.idle.length - 2
                ? " or "
                : ""}{/each}.
        </p>
      {/if}
      <section id="nobody">
        <h2>Serves nobody yet</h2>
        {#if personas.nobody.length}
          <p class="lede">
            {plural(personas.nobody.length, "planned feature")} with no persona named.
            <a href={gapsHref}>See every gap</a>.
          </p>
          <ul>
            {#each personas.nobody as issue (issue.item.id)}
              <PlannedFeatureRow
                {issue}
                extends={extendsOf(issue)}
                serves={[]}
                {gapsHref}
              />
            {/each}
          </ul>
        {:else}
          <p class="lede">Every planned feature names a persona it serves.</p>
        {/if}
      </section>
      <section id="untied">
        <h2>Not tied to a persona</h2>
        <p class="lede">Scenarios belong to a feature, not to a persona.</p>
        {#if scenarios.length}
          <h3>{plural(scenarios.length, "scenario")} written and waiting</h3>
          <ul>
            {#each scenarios as s (s.scenarioId)}
              <PlannedScenarioRow
                scenario={s}
                feature={featureOfScenario(s)}
                surface={SURFACE_TITLE[s.surface]}
              />
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  </div>
</div>

<style>
  .panel {
    padding: 18px 20px 24px;
  }
  .reading {
    min-width: 0;
    max-width: 92ch;
  }
  h1 {
    margin: 0;
    max-width: 70ch;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 650;
    font-size: 27px;
    line-height: 1.12;
    letter-spacing: -0.012em;
    text-wrap: balance;
  }
  .source {
    margin: 10px 0 0;
    max-width: 70ch;
    color: var(--ink-2);
  }
  .by {
    display: inline-flex;
    margin-top: 24px;
    padding: 2px;
    border: 1px solid var(--rule);
    border-radius: 8px;
  }
  .by a {
    padding: 8px 14px;
    min-height: 40px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    border-radius: var(--r-s);
    color: var(--ink-2);
    text-decoration: none;
    font-weight: 600;
    transition: background 150ms ease;
  }
  .by a:hover {
    color: var(--ink);
    background: var(--ground-2);
  }
  .by a[aria-current="page"] {
    color: var(--ink);
    background: var(--panel);
    box-shadow: 0 1px 0 var(--rule);
  }
  section {
    margin-top: 44px;
    scroll-margin-top: 24px;
  }
  h2 {
    margin: 0 0 6px;
    font-family: var(--display);
    font-stretch: 78%;
    font-weight: 700;
    font-size: 27px;
    line-height: 1.15;
    letter-spacing: -0.01em;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 14px;
  }
  h2 a {
    color: var(--ink);
    text-decoration: none;
  }
  h2 a:hover {
    color: var(--accent);
  }
  .type {
    font-family: var(--text);
    font-stretch: 100%;
    font-weight: 500;
    font-size: 14px;
    color: var(--ink-2);
  }
  h3 {
    margin: 20px 0 2px;
    font-size: 14px;
    font-weight: 600;
    color: var(--ink-3);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  ul:last-child {
    border-bottom: 1px solid var(--rule);
  }
  .lede,
  .idle,
  .empty {
    margin: 6px 0 0;
    max-width: 70ch;
    color: var(--ink-2);
    line-height: 1.6;
  }
  .idle {
    margin-top: 28px;
  }
  .idle a,
  .lede a {
    color: var(--ink);
    text-decoration: underline;
    text-decoration-color: var(--rule);
    text-underline-offset: 3px;
    padding: 4px 0;
  }
  .idle a:hover,
  .lede a:hover {
    color: var(--accent);
    text-decoration-color: var(--accent);
  }
  @container (min-width: 1024px) {
    h1 {
      font-size: 34px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .by a {
      transition: none;
    }
  }
</style>
