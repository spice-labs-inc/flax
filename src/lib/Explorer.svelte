<script lang="ts">
  import { tick, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import Crumbs, { type Crumb } from "./Crumbs.svelte";
  import FeaturesPanel from "./doors/FeaturesPanel.svelte";
  import NowPanel from "./doors/NowPanel.svelte";
  import PersonasPanel from "./doors/PersonasPanel.svelte";
  import PlannedPanel from "./doors/PlannedPanel.svelte";
  import JourneyLedger from "./JourneyLedger.svelte";
  import Journeys, { type JourneyFocus } from "./Journeys.svelte";
  import Ledger from "./Ledger.svelte";
  import LiveStrip from "./LiveStrip.svelte";
  import MapCanvas from "./MapCanvas.svelte";
  import ScenarioLedger from "./ScenarioLedger.svelte";
  import ScenarioView from "./ScenarioView.svelte";
  import Timeline from "./Timeline.svelte";
  import {
    formatPacific,
    type EnvChoice,
    type Item,
    ENVS,
    ENV_LABEL,
  } from "./data.ts";
  import { focusDistrict, focusIsland, parentOf, type Focus } from "./focus.ts";
  import type { World } from "./layout.ts";
  import { live } from "./live.svelte.ts";
  import { search } from "./shell/search.svelte.ts";
  import type { Model } from "./model.ts";
  import {
    absoluteOf,
    format,
    hrefOf,
    parse,
    type Dest,
    type Lens,
    type Nav,
    type Opener,
    type Route,
  } from "./nav.ts";
  import type { View } from "./location.ts";
  import { sectorPath } from "./glyph.ts";

  let {
    model,
    location,
  }: {
    model: Model;
    /** The path and query the page's URL names. */
    location: string;
  } = $props();
  let {
    LATEST,
    snapshots,
    items,
    detailOf,
    claimed,
    orphans,
    personas,
    surfaces,
    mapItems,
    holders,
    holderOf,
    holderChain,
    insideOf,
    surfaceTitleOf,
    documentsOf,
    documentedBy,
  } = $derived(model);

  const ENV_OPTS: { key: EnvChoice; label: string }[] = [
    { key: "all", label: ENVS.length === 1 ? "All" : `All ${ENVS.length}` },
    ...ENVS.map((e) => ({ key: e, label: ENV_LABEL[e]! })),
  ];

  let env = $state<EnvChoice>("all");
  let snap = $state(untrack(() => model.LATEST));
  /** Items the scenarios running right now touch, in the envs on show; they pulse on the map. */
  let liveItems = $derived.by(() => {
    const out = new Set<number>();
    for (const s of live.runningScenarios(env)) {
      const d = model.detailOf(s.id);
      if (d) for (const it of model.scenarioItems(d)) out.add(it.idx);
    }
    return out;
  });
  /** This scenario in each env's run in progress, and in a finished run until the data has it. */
  const liveFor = (id: string) =>
    live
      .scenarioRuns(id)
      .filter(
        (r) =>
          r.run.state === "running" ||
          !model.runs.some((x) => x.id === r.run.runId),
      );
  let focus = $state.raw<Focus>({ level: "world" });
  let world = $state.raw<World | null>(null);
  /** The holder whose contents the map shows, or null for the product; the chain above it feeds the crumbs. */
  let inside = $state.raw<Item | null>(null);
  let insideChain = $derived(inside ? [...holderChain(inside), inside] : []);
  let level = $derived(inside ? insideOf(inside) : null);
  let levelSurfaces = $derived(level ? [level.info] : surfaces);
  let levelItems = $derived(level ? level.items : mapItems);
  /** Entering or leaving a level: the rebuilt world flies to the place the route names. */
  let levelChanged = false;
  /** The item in focus and each thing it documents or is documented by, as the hexes that stand for them on this level. */
  let docTies = $derived.by((): [number, number][] => {
    if (focus.level !== "item" || !world) return [];
    const w = world;
    const here = focus.cell.item;
    const standIn = (it: Item): number | undefined => {
      for (const x of [it, ...holderChain(it).reverse()])
        if (w.cellOf.has(x.idx)) return x.idx;
      return undefined;
    };
    const out = new Map<number, [number, number]>();
    for (const other of [...documentsOf(here), ...documentedBy(here)]) {
      const idx = standIn(other);
      if (idx !== undefined && idx !== here.idx) out.set(idx, [here.idx, idx]);
    }
    return [...out.values()];
  });
  let flyKey = $state(0);
  let overlay: HTMLDivElement | undefined = $state();
  let view = $state<View>("map");
  /** What the door itself names in the URL beyond the map's own focus: a feature, a surface list, a search, the gaps page, a grouping, the lines alone. */
  let door = $state.raw<
    Pick<Route, "feature" | "surface" | "q" | "gaps" | "by" | "lines">
  >({});
  let lens = $state<Lens>("all");
  let jfocus = $state.raw<JourneyFocus>({ kind: "none" });
  let scenarioId = $state<string | null>(null);
  let scenarioFrom = $state.raw<Item | null>(null);
  let step = $state<number | null>(null);
  let scenario = $derived(scenarioId ? detailOf(scenarioId) : undefined);
  /** The view a scenario was opened from and the element or search that opened it; Esc goes back there. */
  let returnTo = $state.raw<{ route: Route; opener?: Opener } | null>(null);
  let back = $derived.by(() => {
    const r = returnTo?.route;
    const jf = r?.view === "personas" ? journeyFocusFor(r) : null;
    const label = jf
      ? jf.kind === "station"
        ? jf.station.name
        : "Personas"
      : (scenarioFrom?.label ?? "Surface map");
    return {
      label,
      href: r
        ? hrefOf(format(r, model))
        : nav.href(
            scenarioFrom
              ? { view: "map", itemId: scenarioFrom.id }
              : { view: "map" },
          ),
    };
  });

  const SIDE_KEY = "flax-explorer:side-width";
  const SIDE_MIN = 280;
  const sideMax = () => Math.max(SIDE_MIN, Math.round(window.innerWidth * 0.6));
  let sideUser = $state<number | null>(readSide());
  let sideW = $derived(sideUser ?? 480);
  /** The map's lens for the door on show: Planned dims everything built; the inventory keeps its own choice. */
  let mapLens = $derived<"all" | "orphans" | "planned">(
    view === "planned" ? "planned" : view === "map" ? lens : "all",
  );
  type LegendMark =
    | "pass"
    | "fail"
    | "planned"
    | "unchecked"
    | "none"
    | "never"
    | "ghost"
    | "holds";
  /** Each door's legend names only the marks that door shows; the map, as the full atlas, shows them all. */
  const DOOR_MARKS: Record<View, readonly LegendMark[]> = {
    now: ["fail", "pass", "unchecked"],
    features: ["pass", "fail", "unchecked", "none"],
    planned: ["planned", "ghost", "none"],
    personas: [],
    map: [
      "pass",
      "fail",
      "planned",
      "unchecked",
      "none",
      "never",
      "ghost",
      "holds",
    ],
  };
  let marks = $derived(new Set(DOOR_MARKS[view]));
  /** On the Map door, a surface drawn as several islands, such as the websites, narrows the side panel to its islands. */
  let ledgerScope = $derived.by(() => {
    if (!world || focus.level !== "set" || !focus.surface) return null;
    const surface = focus.surface;
    return {
      title: focus.label,
      world: {
        ...world,
        islands: world.islands.filter((i) => i.info.surface === surface),
      },
    };
  });
  /** On the Now door, the failures in the environments on show, and what their failing steps block. */
  let nowView = $derived(view === "now" ? model.nowView(snap, env) : null);
  /** On the Now door, every item a failing step touched pulses on the map. */
  let alertItems = $derived(nowView?.from ?? new Set<number>());
  /** The feature on show in the Features door, a surface drawn as several islands, or what Now's failures block, keeps its items lit while the rest of the map dims. */
  let spotItems = $derived.by(() => {
    if (nowView) return nowView.lit.size > 0 ? nowView.lit : null;
    if (view === "map" && focus.level === "set" && focus.surface)
      return new Set(focus.cells.map((c) => c.item.idx));
    if (view !== "features" || !door.feature) return null;
    const f = model.featureAt(door.feature);
    return f ? new Set(f.items.map((it) => it.idx)) : null;
  });

  function readSide(): number | null {
    try {
      const v = Number(localStorage.getItem(SIDE_KEY));
      return Number.isFinite(v) && v >= SIDE_MIN ? v : null;
    } catch {
      return null;
    }
  }

  function setSide(w: number) {
    sideUser = Math.round(Math.min(sideMax(), Math.max(SIDE_MIN, w)));
    try {
      localStorage.setItem(SIDE_KEY, String(sideUser));
    } catch {
      // Width just is not remembered for next time.
    }
  }

  function startResize(e: PointerEvent) {
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = sideW;
    const move = (ev: PointerEvent) => setSide(startW + (startX - ev.clientX));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  function resizeKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft") setSide(sideW + step);
    else if (e.key === "ArrowRight") setSide(sideW - step);
    else if (e.key === "Home") setSide(SIDE_MIN);
    else if (e.key === "End") setSide(sideMax());
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  let pastText = $derived(
    `Results as of ${formatPacific(snapshots[snap]!.at)}, not the latest.`,
  );

  /** Selecting one item opens the inventory reader for it, whichever door the map was lit for. */
  function setFocus(f: Focus, fly = true) {
    if (f.level === "item" && view !== "map") {
      dropScenario();
      view = "map";
    }
    focus = f;
    if (fly) flyKey++;
  }

  const initial = untrack(() => parse(location, model));
  env = initial.env;
  snap = initial.snap;
  lens = initial.lens;
  view = initial.view;
  let routed = false;

  function journeyFocusFor(r: Route): JourneyFocus {
    if (r.orphans) return { kind: "orphans" };
    const p = personas.find((x) => x.id === r.persona);
    if (!p) return { kind: "none" };
    const s = p.stations.find((x) => x.key === r.station);
    return s
      ? { kind: "station", station: s, persona: p }
      : { kind: "persona", persona: p };
  }

  /** The holder a route's map lives in: the one it names, else the one holding the item it names, else none. */
  function holderFor(r: Route): Item | null {
    if (r.view !== "map") return null;
    if (r.inside) return items.find((x) => x.id === r.inside) ?? null;
    const it = r.itemId ? items.find((x) => x.id === r.itemId) : undefined;
    return it ? (holderOf(it) ?? null) : null;
  }

  function mapFocusFor(r: Route, w: World): Focus {
    if (r.itemId) {
      const it = items.find((x) => x.id === r.itemId);
      const c = it && w.cellOf.get(it.idx);
      if (c) return { level: "item", cell: c };
    }
    if (inside) {
      const isl = w.islands[0];
      if (!isl) return { level: "world" };
      const d = isl.districts.find((x) => x.name === r.area);
      return d
        ? { level: "district", district: d }
        : { level: "island", island: isl };
    }
    const isl =
      w.islands.find((i) => i.info.island === r.surface) ??
      w.islands.find(
        (i) =>
          i.info.surface === r.surface &&
          i.districts.some((x) => x.name === r.area),
      );
    // A surface the map draws as several islands, such as the websites: all of them, lit together.
    const parts = r.area
      ? []
      : w.islands.filter((i) => i.info.surface === r.surface);
    if (!isl && parts.length && r.surface)
      return {
        level: "set",
        cells: parts.flatMap((i) => i.cells),
        label:
          model.featureGroups.find((g) => g.surface === r.surface)?.title ??
          r.surface,
        surface: r.surface,
      };
    if (!isl) return { level: "world" };
    const d = isl.districts.find((x) => x.name === r.area);
    return d
      ? { level: "district", district: d }
      : { level: "island", island: isl };
  }

  /** The cells a feature's scenarios touch, for the camera and the spotlight. */
  function featureCells(w: World, feature: string): Focus {
    const f = model.featureAt(feature);
    if (!f) return { level: "world" };
    return {
      level: "set",
      cells: f.items.flatMap((it) => w.cellOf.get(it.idx) ?? []),
      label: f.name,
    };
  }

  function applyRoute(r: Route, w: World, fly = true) {
    // A scenario the search palette opened goes back to it on Escape, with the query as it was.
    const pending = search.pending;
    search.pending = null;
    if (pending && r.scenario && !scenarioId)
      returnTo = { route: currentRoute(), opener: pending };
    view = r.view;
    env = r.env;
    snap = r.snap;
    if (r.view === "map") {
      lens = r.lens;
    }
    door = {
      ...(r.feature ? { feature: r.feature } : {}),
      ...(r.view === "features" && r.surface ? { surface: r.surface } : {}),
      ...(r.q ? { q: r.q } : {}),
      ...(r.gaps ? { gaps: true } : {}),
      ...(r.by ? { by: r.by } : {}),
      ...(r.view === "personas" && r.lines ? { lines: true } : {}),
    };
    jfocus = journeyFocusFor(r);
    const open = r.view === "map" && r.scenario && detailOf(r.scenario);
    scenarioId = open ? r.scenario! : null;
    scenarioFrom = open
      ? (items.find((it) => it.id === r.itemId) ?? null)
      : null;
    step = open ? (r.step ?? null) : null;
    if (!open) returnTo = null;
    // A scenario opened from search leaves the map where it was.
    if (open && !r.itemId && routed) return;
    const holder = holderFor(r);
    if ((holder?.id ?? null) !== (inside?.id ?? null)) {
      // Another level: the map is rebuilt for it, and the rest of the route is applied to the new world.
      inside = holder;
      levelChanged = true;
      pendingRoute = r;
      return;
    }
    if (r.view === "map") setFocus(mapFocusFor(r, w), fly);
    else if (r.view === "features" && r.feature)
      setFocus(featureCells(w, r.feature), fly);
    else if (!routed || focus.level === "set" || focus.level === "item")
      setFocus({ level: "world" }, fly);
  }

  function dropScenario() {
    scenarioId = null;
    scenarioFrom = null;
    step = null;
    returnTo = null;
  }

  /** Back to the view the scenario was opened from, focus on what opened it: the link, the search result, or the map. */
  async function closeScenario() {
    const from = returnTo;
    const fromItem = scenarioFrom;
    const id = scenarioId;
    if (from && world) applyRoute(from.route, world, false);
    else dropScenario();
    await tick();
    const opener = from?.opener;
    if (opener && "palette" in opener) {
      search.resume = opener.palette;
      search.open = true;
      return;
    }
    const key = opener
      ? opener.focus
      : fromItem && id
        ? `item-scenario:${id}`
        : undefined;
    const el = key
      ? document.querySelector<HTMLElement>(
          `[data-return="${CSS.escape(key)}"]`,
        )
      : null;
    (el ?? document.querySelector<HTMLElement>(".map canvas"))?.focus();
  }

  function showView(v: View) {
    dropScenario();
    view = v;
    if (focus.level === "item" || focus.level === "set")
      focus = { level: "world" };
  }

  const PATH_KEYS = [
    "view",
    "surface",
    "area",
    "itemId",
    "inside",
    "scenario",
    "persona",
    "station",
    "orphans",
    "feature",
    "gaps",
    "by",
    "lines",
  ] as const;

  /** Where a link goes: a new place starts from the map with today's env, point and lens; a modifier keeps the place. */
  function routeFor(d: Dest): Route {
    if (!PATH_KEYS.some((k) => k in d)) return { ...currentRoute(), ...d };
    const r: Route = { view: "map", env, snap, lens, ...d };
    const it = r.itemId ? items.find((x) => x.id === r.itemId) : undefined;
    if (it && r.lens === "orphans" && claimed.has(it.idx)) r.lens = "all";
    return r;
  }

  const nav: Nav = {
    href: (d) => hrefOf(format(routeFor(d), model)),
    url: (d) => absoluteOf(format(routeFor(d), model)),
    go: (d, from) => {
      if (d.scenario && !scenarioId)
        returnTo = { route: currentRoute(), opener: from };
      if (!PATH_KEYS.some((k) => k in d)) {
        if (d.env) env = d.env;
        if (d.snap !== undefined && d.snap >= 0) snap = d.snap;
        if (d.lens) lens = d.lens;
        return;
      }
      if (world) applyRoute(routeFor(d), world);
    },
  };

  let panelRoute = $derived.by(currentRoute);
  /** The journey lines with the personas table beside them again, the persona in focus kept. */
  let tableHref = $derived.by(() => {
    const r = currentRoute();
    delete r.lines;
    return hrefOf(format(r, model));
  });

  function currentRoute(): Route {
    const r: Route = {
      view,
      env,
      snap,
      lens: view === "map" ? lens : "all",
    };
    if (view === "personas") {
      if (door.lines) r.lines = true;
      if (door.gaps) r.gaps = true;
      else if (jfocus.kind === "orphans") r.orphans = true;
      else if (jfocus.kind === "persona") r.persona = jfocus.persona.id;
      else if (jfocus.kind === "station") {
        r.persona = jfocus.persona.id;
        r.station = jfocus.station.key;
      }
    } else if (view === "features") {
      if (door.feature) r.feature = door.feature;
      else if (door.surface) r.surface = door.surface;
      if (door.q) r.q = door.q;
    } else if (view === "planned") {
      if (door.by) r.by = door.by;
    } else if (view === "now") {
      // Nothing beyond the environment and the timeline point.
    } else if (scenarioId) {
      r.scenario = scenarioId;
      if (scenarioFrom) r.itemId = scenarioFrom.id;
      if (step) r.step = step;
    } else if (inside) {
      r.inside = inside.id;
      if (focus.level === "item") r.itemId = focus.cell.item.id;
      else {
        const d = focusDistrict(focus);
        if (d) r.area = d.name;
      }
    } else if (focus.level === "item") r.itemId = focus.cell.item.id;
    else if (focus.level === "set" && focus.surface) r.surface = focus.surface;
    else {
      const isl = focusIsland(focus);
      const d = focusDistrict(focus);
      if (isl) r.surface = isl.info.island;
      if (d) r.area = d.name;
    }
    return r;
  }

  /** Into a holder's own map, with it in focus; up to the holder's level with its hex in focus. */
  function enter(it: Item) {
    nav.go({ view: "map", inside: it.id });
  }
  function leave() {
    if (!inside) return;
    const up = holderOf(inside);
    nav.go(
      up
        ? { view: "map", inside: up.id, itemId: inside.id }
        : { view: "map", itemId: inside.id },
    );
  }

  /** The trail over the map: the product, the holders opened on the way in, then the island, area and item in focus. */
  let trail = $derived.by((): Crumb[] => {
    const out: Crumb[] = [
      {
        label: "Product",
        go: () =>
          inside ? nav.go({ view: "map" }) : setFocus({ level: "world" }),
        current: !inside && focus.level === "world",
      },
    ];
    if (inside) {
      const top = insideChain[0]!;
      out.push({
        label: surfaceTitleOf(top),
        go: () => nav.go({ view: "map", surface: top.island }),
      });
      insideChain.forEach((h, i) => {
        const last = i === insideChain.length - 1;
        out.push({
          label: insideOf(h)?.info.title ?? h.label,
          go: last
            ? () => setFocus({ level: "world" })
            : () => nav.go({ view: "map", inside: h.id }),
          current:
            last && (focus.level === "world" || focus.level === "island"),
        });
      });
    } else {
      const isl = focusIsland(focus);
      if (isl)
        out.push({
          label: isl.info.title,
          go: () => setFocus({ level: "island", island: isl }),
          current: focus.level === "island",
        });
    }
    const d = focusDistrict(focus);
    if (d)
      out.push({
        label: d.name,
        go: () => setFocus({ level: "district", district: d }),
        current: focus.level === "district",
      });
    if (focus.level === "item") out.push({ label: focus.cell.item.label });
    else if (focus.level === "set") out.push({ label: focus.label });
    return out;
  });

  /** The place to go back to once the map is rebuilt for new data. */
  // Reactive, so the URL effect wakes up again once the rebuilt map has restored the place.
  let pendingRoute = $state.raw<Route | null>(null);
  let lastPath = "";
  /** The location this page last put in the URL, or last followed there. */
  let written = untrack(() => location);
  let shownWorld: World | null = null;
  let shownModel = untrack(() => model);
  $effect(() => {
    if (!world) return;
    // While new data is being placed, the route is not the page's to write; the restored place writes it.
    if (pendingRoute) {
      void focus;
      return;
    }
    // Falls through after the first route so this effect tracks every piece of the route from then on.
    if (!routed) {
      applyRoute(initial, world);
      routed = true;
      shownWorld = world;
      // A first route into a holder waits for its world; writing the URL now would lose the place it names.
      if (pendingRoute) return;
    }
    const r = currentRoute();
    const path = JSON.stringify([
      r.view,
      r.surface,
      r.area,
      r.itemId,
      r.inside,
      r.scenario,
      r.persona,
      r.station,
      r.orphans,
      r.feature,
      r.gaps,
      r.by,
      r.lines,
    ]);
    const push = lastPath !== "" && path !== lastPath;
    lastPath = path;
    const target = format(r, model);
    if (target === untrack(() => location) || target === written) return;
    written = target;
    // The single-file page's frame may refuse history; navigation still works inside the page.
    goto(hrefOf(target), {
      replaceState: !push,
      noScroll: true,
      keepFocus: true,
    }).catch(() => undefined);
  });

  // Back, forward, and links the page did not handle itself change the URL; the view follows it.
  $effect(() => {
    const loc = location;
    untrack(() => {
      if (!world || !routed || loc === written) return;
      written = loc;
      applyRoute(parse(loc, model), world);
    });
  });

  // New data keeps the timeline point (the latest stays the latest) and, once the map is rebuilt, the place.
  // Before the panels draw: they index the new data by the timeline point and by the items in focus.
  $effect.pre(() => {
    const m = model;
    untrack(() => {
      if (m === shownModel) return;
      const prev = shownModel;
      shownModel = m;
      pendingRoute = currentRoute();
      focus = { level: "world" };
      inside = null;
      scenarioFrom = null;
      // The persona and station come from the new data by id; the map's place waits for the world to be rebuilt.
      jfocus = journeyFocusFor(pendingRoute);
      if (snap === prev.LATEST) snap = m.LATEST;
      else {
        const id = prev.snapshots[snap]?.runId;
        const i = m.snapshots.findIndex((x) => x.runId === id);
        snap = i >= 0 ? i : m.LATEST;
      }
    });
  });
  $effect(() => {
    const w = world;
    untrack(() => {
      if (!w || !routed || w === shownWorld) return;
      shownWorld = w;
      const r = pendingRoute ?? currentRoute();
      pendingRoute = null;
      const fly = levelChanged;
      levelChanged = false;
      applyRoute({ ...r, snap }, w, fly);
    });
  });

  function pickItem(it: Item) {
    if (lens === "orphans" && claimed.has(it.idx)) lens = "all";
    nav.go({ view: "map", itemId: it.id });
  }

  function showOrphans() {
    lens = "orphans";
    view = "map";
    setFocus({ level: "world" });
  }

  function onkeydown(e: KeyboardEvent) {
    if (search.open || document.querySelector("dialog[open]")) return;
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type !== "range") return;
    if (e.key === "Escape") {
      if (scenarioId) {
        // Otherwise this same Escape closes the search it may reopen.
        e.preventDefault();
        void closeScenario();
      } else if (view === "personas") jfocus = { kind: "none" };
      else if (inside && (focus.level === "world" || focus.level === "island"))
        leave();
      else setFocus(parentOf(focus));
    } else if (e.key === "m") showView("map");
    else if (e.key === "p") showView("personas");
    else if (/^[1-9]$/.test(e.key) && ENV_OPTS[Number(e.key) - 1])
      env = ENV_OPTS[Number(e.key) - 1]!.key;
    else if (!(t instanceof HTMLInputElement) && e.key === "ArrowRight")
      snap = Math.min(LATEST, snap + 1);
    else if (!(t instanceof HTMLInputElement) && e.key === "ArrowLeft")
      snap = Math.max(0, snap - 1);
  }
</script>

<svelte:window {onkeydown} />

<div
  class="app"
  class:scen={!!scenario}
  class:wide={view === "personas" && door.lines}
  style:--side-w="{sideW}px"
>
  <LiveStrip {model} {nav} />

  <div class="map" hidden={view === "personas" || !!scenario}>
    <MapCanvas
      {model}
      running={liveItems}
      alert={alertItems}
      spot={spotItems}
      spotFrom={alertItems}
      {env}
      {snap}
      {focus}
      {flyKey}
      lens={mapLens}
      surfaces={levelSurfaces}
      items={levelItems}
      place={level?.place ?? null}
      levelKey={inside?.id ?? ""}
      inside={!!inside}
      enterable={holders}
      ties={docTies}
      bind:world
      onfocus={setFocus}
      onenter={(c) => enter(c.item)}
      onleave={leave}
      clearTop={() =>
        overlay ? overlay.offsetTop + overlay.offsetHeight + 22 : 100}
    />
    <div class="overlay" bind:this={overlay}>
      <Crumbs {trail} />
      <div
        class="lens seg"
        role="group"
        aria-label="View"
        hidden={view !== "map"}
      >
        <button
          type="button"
          aria-pressed={lens === "all"}
          onclick={() => (lens = "all")}>All items</button
        >
        <button
          type="button"
          aria-pressed={lens === "orphans"}
          onclick={() => (lens = "orphans")}
          >Not on any journey ({orphans.length})</button
        >
      </div>
    </div>
    <div class="foot">
      <div class="legend">
        {#if marks.has("pass")}<span><i class="sw pass"></i>Verified</span>{/if}
        {#if marks.has("fail")}<span><i class="sw fail"></i>Failing</span>{/if}
        {#if marks.has("planned")}<span
            ><i class="sw planned"></i>Planned scenario</span
          >{/if}
        {#if marks.has("unchecked")}<span
            ><i class="sw unchecked"></i>Not checked here</span
          >{/if}
        {#if marks.has("none")}<span
            ><i class="sw none"></i>No scenario yet</span
          >{/if}
        {#if marks.has("never")}<span
            ><i class="sw never"></i>Never run here</span
          >{/if}
        {#if marks.has("ghost")}<span
            ><i class="sw ghost"></i>Open issue, not built yet</span
          >{/if}
        {#if marks.has("holds")}<span
            ><svg class="tri" viewBox="-10 -10 20 20" aria-hidden="true"
              ><path
                d="M0 -10 L8.66 -5 L8.66 5 L0 10 L-8.66 5 L-8.66 -5 Z"
                fill="currentColor"
                opacity=".55"
              ></path><path
                d="M0 -5.5 L4.76 -2.75 L4.76 2.75 L0 5.5 L-4.76 2.75 L-4.76 -2.75 Z"
                fill="none"
                stroke="var(--ground)"
                stroke-width="1.6"
              ></path></svg
            >Opens as a map of what it holds</span
          >{/if}
        {#if env === "all"}
          <span class="envkey"
            ><svg class="tri" viewBox="-10 -10 20 20" aria-hidden="true"
              >{#each ENVS as e, i (e)}<path
                  d={sectorPath(i, ENVS.length, 10)}
                  fill="currentColor"
                  opacity={1 - (0.55 * i) / Math.max(1, ENVS.length - 1)}
                ></path>{/each}</svg
            >Each hex: {ENVS.map(
              (e, i) => `${ENV_LABEL[e]}${i === 0 ? " on top" : ""}`,
            ).join(", ")}, clockwise</span
          >
        {/if}
      </div>
      <div class="hint" hidden={snap !== LATEST}>
        <span><kbd>1</kbd>-<kbd>{ENVS.length + 1}</kbd> environment</span><span
          ><kbd>&larr;</kbd><kbd>&rarr;</kbd> timeline</span
        ><span>Double-click to zoom or open</span><span
          ><kbd>Esc</kbd> zoom out</span
        >
      </div>
    </div>
  </div>

  {#if view === "map" && scenario}
    <div class="sview">
      {#if snap !== LATEST}
        <div class="pastbar">
          {pastText}
          <button type="button" class="linkish" onclick={() => (snap = LATEST)}
            >Show the latest</button
          >
        </div>
      {/if}
      {#key scenario.id}
        <ScenarioView
          {model}
          detail={scenario}
          liveRuns={liveFor(scenario.id)}
          {env}
          {snap}
          bind:step
          from={scenarioFrom}
          {back}
          {nav}
          onclose={closeScenario}
        />
      {/key}
    </div>
  {/if}
  {#if view === "personas"}
    <div class="jview">
      {#if door.lines}
        <p class="linesbar">
          <a href={tableHref}>Show the personas table with the lines</a>
        </p>
      {/if}
      {#if snap !== LATEST}
        <div class="pastbar">
          {pastText}
          <button type="button" class="linkish" onclick={() => (snap = LATEST)}
            >Show the latest</button
          >
        </div>
      {/if}
      <Journeys
        {model}
        {env}
        {snap}
        focus={jfocus}
        onfocus={(f) => (jfocus = f)}
      />
    </div>
  {/if}
  {#if snap !== LATEST && view !== "personas" && !scenario}
    <div class="flagspot">
      <div class="pastflag">
        <span class="short">{formatPacific(snapshots[snap]!.at)}</span><span
          class="long">{pastText}</span
        >
      </div>
    </div>
  {/if}
  {#if view === "now" || scenario}
    <div class="timeline"><Timeline {model} bind:snap {env} /></div>
  {/if}
  <div class="ledger">
    <button
      type="button"
      class="resize"
      aria-label="Resize the side panel ({sideW} pixels wide). Drag, or use the left and right arrow keys; double-click resets."
      onpointerdown={startResize}
      onkeydown={resizeKey}
      ondblclick={() => {
        sideUser = null;
        try {
          localStorage.removeItem(SIDE_KEY);
        } catch {
          // Nothing stored to clear.
        }
      }}
    ></button>
    {#if view === "personas" && jfocus.kind === "orphans"}
      <JourneyLedger
        {model}
        focus={jfocus}
        {env}
        {snap}
        onfocus={(f) => (jfocus = f)}
        {nav}
        onitem={pickItem}
        onorphans={showOrphans}
      />
    {:else if view === "personas"}
      <PersonasPanel {model} route={panelRoute} />
    {:else if scenario}
      <ScenarioLedger {model} detail={scenario} {env} {snap} {nav} />
    {:else if view === "now"}
      <NowPanel {model} route={panelRoute} />
    {:else if view === "features"}
      <FeaturesPanel {model} route={panelRoute} />
    {:else if view === "planned"}
      <PlannedPanel {model} route={panelRoute} />
    {:else if world}
      <Ledger
        {model}
        world={ledgerScope?.world ?? world}
        title={ledgerScope?.title}
        holder={inside}
        focus={focus.level === "set" ? { level: "world" } : focus}
        {env}
        {snap}
        {lens}
        {nav}
        onfocus={setFocus}
      />
    {/if}
  </div>
</div>

<style>
  .tri {
    width: 14px;
    height: 14px;
    flex: none;
  }
  .app {
    height: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--side-w, 360px);
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas: "live live" "map side" "time side";
  }

  .seg {
    display: inline-flex;
    border: 1px solid var(--rule);
    border-radius: var(--r-s);
    overflow: hidden;
    background: var(--panel);
  }
  .seg button {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    padding: 6px 11px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .seg button + button {
    border-left: 1px solid var(--rule);
  }
  .seg button[aria-pressed="true"] {
    background: var(--accent-soft);
    color: var(--ink);
    font-weight: 600;
  }
  .map {
    grid-area: map;
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .jview,
  .sview {
    grid-area: map;
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }
  .linesbar {
    margin: 0;
    padding: 10px 20px 0;
    font-size: 14px;
  }
  .linesbar a {
    color: var(--accent);
  }
  .app.wide {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "live" "map" "time";
  }
  .app.wide .ledger {
    display: none;
  }
  .pastbar {
    background: var(--accent-soft);
    color: var(--ink);
    font-size: 13px;
    font-weight: 600;
    padding: 6px 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .linkish {
    appearance: none;
    border: 0;
    background: transparent;
    padding: 0;
    margin-left: 6px;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }
  /* Crumbs and the view bar stack in flow, so a long crumb can never sit on the bar. */
  .overlay {
    position: absolute;
    left: 16px;
    right: 16px;
    top: 14px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    pointer-events: none;
  }
  .overlay > :global(*) {
    max-width: 100%;
  }
  .lens {
    pointer-events: auto;
    font-size: 12px;
  }
  .timeline {
    grid-area: time;
    min-width: 0;
  }
  .ledger {
    grid-area: side;
    min-height: 0;
    position: relative;
    overflow: auto;
  }
  .resize {
    appearance: none;
    border: 0;
    padding: 0;
    background: transparent;
    position: absolute;
    left: -4px;
    top: 0;
    bottom: 0;
    width: 8px;
    cursor: col-resize;
    z-index: 4;
    touch-action: none;
  }
  .resize::after {
    content: "";
    position: absolute;
    left: 3px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: transparent;
    transition: background 0.15s;
  }
  .resize:hover::after,
  .resize:focus-visible::after {
    background: var(--accent);
  }
  .resize:focus-visible {
    outline: none;
  }
  .flagspot {
    grid-area: map;
    position: relative;
    pointer-events: none;
    z-index: 2;
  }
  .pastflag {
    position: absolute;
    right: 16px;
    bottom: 12px;
    background: var(--accent-soft);
    color: var(--ink);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 600;
    max-width: min(440px, calc(100% - 32px));
    text-align: right;
    pointer-events: none;
  }
  .pastflag .short {
    display: none;
  }
  .foot {
    position: absolute;
    left: 16px;
    right: 14px;
    bottom: 14px;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: flex-end;
    gap: 8px 12px;
    pointer-events: none;
  }
  .foot > * {
    pointer-events: auto;
  }
  .foot > [hidden] {
    display: none;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    font-size: 12px;
    color: var(--ink-2);
    background: color-mix(in srgb, var(--ground) 86%, transparent);
    padding: 6px 10px;
    border-radius: var(--r-s);
    max-width: 560px;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .sw {
    width: 11px;
    height: 11px;
    border-radius: 2px;
    display: inline-block;
    box-sizing: border-box;
  }
  .sw.pass {
    background: var(--pass);
  }
  .sw.fail {
    background: var(--fail);
  }
  .sw.planned {
    border: 1.5px dashed var(--planned);
  }
  .sw.none {
    background: var(--none);
    border: 1px solid var(--land-edge);
  }
  .sw.ghost {
    border: 2px dotted var(--issue);
    border-radius: 3px;
  }
  .sw.unchecked {
    background: repeating-linear-gradient(
      135deg,
      var(--land-edge) 0 1.5px,
      var(--none) 1.5px 3.5px
    );
  }
  .sw.never {
    background: var(--never);
    border: 1px dashed var(--land-edge);
  }
  .hint {
    margin-left: auto;
    font-size: 12px;
    color: var(--ink-3);
    display: flex;
    gap: 10px;
  }
  @media (max-width: 1180px) {
    .hint {
      display: none;
    }
  }
  @media (max-width: 860px) {
    .app {
      height: auto;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto 62vh auto auto;
      grid-template-areas: "live" "map" "time" "side";
    }
    .app.scen {
      grid-template-rows: auto auto auto auto;
    }
    .app.wide {
      grid-template-rows: auto 80vh auto;
      grid-template-areas: "live" "map" "time";
    }
    .pastflag {
      font-size: 12px;
      padding: 3px 10px;
      left: auto;
      right: 16px;
      transform: none;
      top: 12px;
      bottom: auto;
    }
    .pastflag .long {
      display: none;
    }
    .pastflag .short {
      display: inline;
    }
    .envkey {
      display: none !important;
    }
    .resize {
      display: none;
    }
  }
  .ledger {
    container-type: inline-size;
  }
</style>
