<script lang="ts">
  let {
    entries,
  }: {
    entries: { id: string; label: string; count: number }[];
  } = $props();

  // The single-file page keeps its location after the #, so a fragment link there would navigate instead of scroll.
  function jump(e: MouseEvent, id: string) {
    if (!__EXPLORER_SINGLE_FILE__) return;
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }
</script>

<nav class="rail" aria-label="On this page">
  <p class="title">On this page</p>
  <ul>
    {#each entries as e (e.id)}
      <li>
        <a href="#{e.id}" onclick={(ev) => jump(ev, e.id)}>
          <span class="label">{e.label}</span>
          <span class="count">{e.count}</span>
        </a>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .rail {
    position: sticky;
    top: 24px;
    font-size: 14px;
  }
  .title {
    margin: 0 0 6px;
    color: var(--ink-3);
    font-weight: 500;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  a {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 5px 0;
    color: var(--ink-2);
    text-decoration: none;
    border-radius: var(--r-s);
  }
  a:hover {
    color: var(--ink);
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }
</style>
