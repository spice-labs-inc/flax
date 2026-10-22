<script lang="ts">
  /** One step of the trail over the map, from the product down to what is in focus. */
  export interface Crumb {
    label: string;
    /** Where the step goes when chosen; the step in focus has none. */
    go?: () => void;
    current?: boolean;
  }

  let { trail }: { trail: Crumb[] } = $props();
</script>

<nav class="crumbs" aria-label="Map focus">
  {#each trail as step, i (i)}
    {#if i > 0}<span class="sep">/</span>{/if}
    {#if step.go}
      <button
        type="button"
        onclick={step.go}
        aria-current={step.current ? "true" : undefined}>{step.label}</button
      >
    {:else}
      <span class="here">{step.label}</span>
    {/if}
  {/each}
</nav>

<style>
  /* One line at any width: the deepest crumbs give up their width first and end in an ellipsis. */
  .crumbs {
    display: flex;
    flex-wrap: nowrap;
    min-width: 0;
    gap: 4px;
    align-items: center;
    font-size: 13px;
    color: var(--ink-2);
    pointer-events: none;
  }
  button,
  .here {
    pointer-events: auto;
    appearance: none;
    border: 0;
    background: color-mix(in srgb, var(--ground) 82%, transparent);
    color: var(--ink);
    font: inherit;
    padding: 2px 6px;
    border-radius: 4px;
    max-width: 40ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button {
    cursor: pointer;
  }
  button,
  .here {
    flex: 0 1 auto;
    min-width: 0;
  }
  button:nth-of-type(-n + 2) {
    flex: none;
  }
  .here {
    flex-shrink: 40;
    min-width: 4ch;
  }
  .sep {
    flex: none;
    color: var(--ink-3);
  }
</style>
