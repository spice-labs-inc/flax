<script lang="ts">
  let {
    message,
    more = "",
    hollow = false,
  }: {
    /** The error's first line, always shown. */
    message: string;
    /** The rest of it, folded. */
    more?: string;
    /** Drawn without the failure color, for errors that say nothing about the product. */
    hollow?: boolean;
  } = $props();
</script>

{#if more}
  <details class="err" class:hollow>
    <summary><code>{message}</code></summary>
    <pre>{more}</pre>
  </details>
{:else}
  <p class="err" class:hollow><code>{message}</code></p>
{/if}

<style>
  .err {
    margin: 8px 0 0;
    padding: 7px 10px;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--fail);
    background: var(--ground);
    border-radius: var(--r-s);
    max-width: 80ch;
    overflow-wrap: anywhere;
  }
  .err.hollow {
    color: var(--ink-2);
    background: transparent;
    border: 1px dashed var(--land-edge);
  }
  code {
    font-family: monospace;
    white-space: pre-wrap;
  }
  summary {
    cursor: pointer;
    list-style-position: outside;
    margin-left: 14px;
  }
  summary::marker {
    color: var(--ink-3);
  }
  pre {
    margin: 6px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 12px;
    color: var(--ink-2);
  }
</style>
