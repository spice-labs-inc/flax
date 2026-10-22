<script lang="ts">
  import type { MarkKind } from "./data.ts";

  let { kind, size = 14 }: { kind: MarkKind; size?: number } = $props();
</script>

<svg
  class="mark"
  width={size}
  height={size}
  viewBox="-10 -10 20 20"
  aria-hidden="true"
>
  {#if kind === "pass"}
    <circle r="8" fill="var(--pass)" stroke="var(--panel)" stroke-width="2"
    ></circle>
  {:else if kind === "fail"}
    <circle r="8.5" fill="var(--fail)" stroke="var(--panel)" stroke-width="2"
    ></circle>
    <path
      d="M-3.5 -3.5 L3.5 3.5 M3.5 -3.5 L-3.5 3.5"
      stroke="var(--panel)"
      stroke-width="2.2"
      stroke-linecap="round"
    ></path>
  {:else if kind === "partial"}
    <circle r="7" fill="var(--panel)" stroke="var(--pass)" stroke-width="2.5"
    ></circle>
    <path d="M0 -5 A5 5 0 0 1 0 5 Z" fill="var(--pass)"></path>
  {:else if kind === "planned"}
    <circle
      r="7"
      fill="var(--ground)"
      stroke="var(--planned)"
      stroke-width="2"
      stroke-dasharray="3 2.4"
    ></circle>
  {:else if kind === "skip"}
    <circle
      r="6.5"
      fill="var(--panel)"
      stroke="var(--ink-3)"
      stroke-width="1.6"
      stroke-dasharray="2.4 2.2"
    ></circle>
  {:else if kind === "other"}
    <circle r="7" fill="var(--panel)" stroke="var(--ink-3)" stroke-width="2"
    ></circle>
    <circle r="2.4" fill="var(--ink-3)"></circle>
  {:else if kind === "never"}
    <path
      d="M-7 0 L7 0"
      stroke="var(--land-edge)"
      stroke-width="2"
      stroke-linecap="round"
    ></path>
  {:else if kind === "unchecked"}
    <circle r="7" fill="var(--panel)" stroke="var(--ink-3)" stroke-width="1.6"
    ></circle>
    <path
      d="M-4.6 4.6 L4.6 -4.6 M-1.4 6.35 L6.35 -1.4 M-6.35 1.4 L1.4 -6.35"
      stroke="var(--ink-3)"
      stroke-width="1.3"
    ></path>
  {:else if kind === "elsewhere"}
    <rect
      x="-6"
      y="-6"
      width="12"
      height="12"
      transform="rotate(45)"
      fill="var(--ground)"
      stroke="var(--ink-3)"
      stroke-width="1.6"
    ></rect>
  {:else}
    <circle r="7" fill="var(--panel)" stroke="var(--ink-2)" stroke-width="2"
    ></circle>
  {/if}
</svg>

<style>
  .mark {
    flex: none;
    display: inline-block;
    vertical-align: -2px;
    overflow: visible;
  }
</style>
