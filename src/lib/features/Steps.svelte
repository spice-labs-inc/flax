<script lang="ts">
  import type { GherkinStep } from "$lib/scenarios.ts";

  let { steps }: { steps: GherkinStep[] } = $props();
</script>

<ol class="steps">
  {#each steps as s, i (i)}
    <li>
      <span class="kw">{s.k.trim()}</span>
      <span class="text">{s.t}</span>
      {#if s.doc}
        <pre class="doc">{s.doc}</pre>
      {/if}
      {#if s.table}
        <table class="table">
          <tbody>
            {#each s.table as row, r (r)}
              <tr>
                {#each row as cell, c (c)}
                  <td>{cell}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </li>
  {/each}
</ol>

<style>
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    max-width: 70ch;
  }
  li {
    display: grid;
    grid-template-columns: 4.2em minmax(0, 1fr);
    column-gap: 8px;
    padding: 3px 0;
    line-height: 1.5;
  }
  .kw {
    color: var(--ink-3);
    text-align: right;
  }
  .doc,
  .table {
    grid-column: 2;
    margin: 4px 0 6px;
  }
  .doc {
    font: inherit;
    white-space: pre-wrap;
    color: var(--ink-2);
  }
  .table {
    border-collapse: collapse;
    font-size: 13px;
  }
  td {
    padding: 2px 10px 2px 0;
    color: var(--ink-2);
    border-bottom: 1px solid var(--rule);
  }
</style>
