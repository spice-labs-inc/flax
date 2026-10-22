<script module lang="ts">
  import {
    ENV_ORDER,
    type Env,
    type HexStates,
    type MarkKind,
  } from "$lib/data.ts";

  import { sectorPath } from "$lib/glyph.ts";

  // One sector of the hex per env, the first env centered on top; with three envs these are the three rhombi.
  const WEDGE: Record<Env, string> = Object.fromEntries(
    ENV_ORDER.map((e, i) => [e, sectorPath(i, ENV_ORDER.length, 10)]),
  ) as Record<Env, string>;
</script>

<script lang="ts">
  let {
    states,
    size = 14,
    label,
  }: {
    states: HexStates;
    size?: number;
    /** Read out to assistive tech; without it the glyph is decoration beside its text. */
    label?: string;
  } = $props();
  const uid = $props.id();
  let hatched = $derived(ENV_ORDER.some((e) => states[e] === "unchecked"));

  const fill = (k: MarkKind) =>
    k === "unchecked"
      ? `url(#hatch-${uid})`
      : k === "pass"
        ? "var(--pass)"
        : k === "fail"
          ? "var(--fail)"
          : k === "partial"
            ? "color-mix(in srgb, var(--pass) 45%, var(--panel))"
            : k === "planned"
              ? "var(--ground)"
              : k === "never"
                ? "transparent"
                : k === "elsewhere"
                  ? "var(--ground-2)"
                  : "var(--none)";
  const stroke = (k: MarkKind) =>
    k === "planned"
      ? "var(--planned)"
      : k === "never"
        ? "transparent"
        : k === "none" || k === "elsewhere" || k === "unchecked"
          ? "var(--land-edge)"
          : "var(--panel)";
</script>

<svg
  class="hex"
  width={size}
  height={size}
  viewBox="-10.5 -10.5 21 21"
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
>
  {#if hatched}
    <defs>
      <pattern
        id="hatch-{uid}"
        width="3"
        height="3"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width="3" height="3" fill="var(--none)"></rect>
        <path d="M0 0 V3" stroke="var(--land-edge)" stroke-width="1.6"></path>
      </pattern>
    </defs>
  {/if}
  {#each ENV_ORDER as env (env)}
    <path
      d={WEDGE[env]}
      fill={fill(states[env])}
      stroke={stroke(states[env])}
      stroke-width="1"
      stroke-linejoin="round"
      stroke-dasharray={states[env] === "planned" ? "2 1.6" : undefined}
    ></path>
  {/each}
</svg>

<style>
  .hex {
    flex: none;
    display: inline-block;
    vertical-align: -2px;
    overflow: visible;
  }
</style>
