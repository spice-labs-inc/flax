<script lang="ts">
  import Mark from "$lib/Mark.svelte";
  import type { PlannedIssue } from "$lib/planning.ts";
  import { boardWords, repoRef } from "./planned.ts";

  let {
    issue,
    extends: feature,
    serves,
    gapsHref,
  }: {
    issue: PlannedIssue;
    /** The existing feature it extends, when the issue's area names one. */
    extends?: { name: string; href: string };
    serves: { id: string; name: string; href: string }[];
    gapsHref: string;
  } = $props();
</script>

<li class="row">
  <Mark kind="planned" size={14} />
  <div class="body">
    <p class="head">
      <span class="label">{issue.item.label}</span>
      <span class="board">{boardWords(issue.board)}</span>
    </p>
    <p class="meta">
      {#if feature}
        Extends <a href={feature.href}>{feature.name}</a>.
      {/if}
      {#if serves.length}
        Serves
        {#each serves as p, i (p.id)}<a href={p.href}>{p.name}</a>{i <
          serves.length - 2
            ? ", "
            : i === serves.length - 2
              ? " and "
              : ""}{/each}.
      {:else}
        <a class="gap" href={gapsHref}>Serves nobody yet</a>.
      {/if}
      <a class="gh" href={issue.url} rel="noreferrer">{repoRef(issue.url)}</a>
    </p>
  </div>
</li>

<style>
  .row {
    display: flex;
    gap: 12px;
    padding: 12px 0;
    border-top: 1px solid var(--rule);
  }
  .row > :global(.mark) {
    margin-top: 5px;
  }
  .body {
    min-width: 0;
    flex: 1;
  }
  p {
    margin: 0;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 12px;
  }
  .label {
    font-weight: 600;
    font-size: 17.5px;
    line-height: 1.3;
    letter-spacing: -0.005em;
  }
  .board {
    color: var(--planned);
    font-weight: 500;
    white-space: nowrap;
  }
  .meta {
    margin-top: 3px;
    color: var(--ink-2);
    line-height: 1.6;
  }
  a {
    color: var(--ink);
    text-decoration: underline;
    text-decoration-color: var(--rule);
    text-underline-offset: 3px;
    padding: 4px 0;
  }
  a:hover {
    text-decoration-color: var(--accent);
    color: var(--accent);
  }
  .gap {
    color: var(--ink-2);
  }
  .gh {
    color: var(--ink-3);
    text-decoration: none;
    white-space: nowrap;
  }
  .gh:hover {
    color: var(--accent);
  }
</style>
