import { ENVS, type EnvChoice, REFERENCE_ENV } from "./data.ts";

/**
 * Everything a person can navigate to, as a path. Four doors:
 *   /now                                   what is broken, what changed, what ran
 *   /features, /features/<surface>, /features/<surface>/<feature>   the product in its own words
 *   /personas, /personas/gaps, /personas/<persona>, /personas/<persona>/<station>, /personas/no-persona,
 *   /personas/lines, /personas/lines/<persona>, /personas/lines/<persona>/<station>   the journey lines across the page
 *   /planned                               what is not built yet
 * and the inner views they open:
 *   /map, /map/<surface>, /map/<surface>/<area>, /map/item/<item id>, /map/item/<item id>/scenario/<scenario id>
 *   /map/in/<holder id>, /map/in/<holder id>/area/<district>, /map/in/<holder id>/item/<item id>   a holder opened as a sub-map
 *   /scenarios/<scenario id>
 * plus ?env=<all|an env id>&at=<run id of an earlier point>&view=orphans&step=<n>&q=<search>&by=<persona|area>;
 * no env means the reference env on personas and all elsewhere, and no at means the latest results.
 * The single-file page cannot own the path, so there the same path rides after a #.
 */
export type View = "now" | "features" | "personas" | "planned" | "map";

export interface Route {
  view: View;
  surface?: string;
  area?: string;
  itemId?: string;
  /** The holder whose contents the map shows, such as a page opened to its elements. */
  inside?: string;
  scenario?: string;
  /** 1-based step of the open scenario. */
  step?: number;
  /** A feature file by its surface folder and its path below it: "api/portfolios", "cli/local/edition-gates". */
  feature?: string;
  /** Words to search the feature catalog for. */
  q?: string;
  persona?: string;
  station?: string;
  orphans?: boolean;
  gaps?: boolean;
  /** The journey lines on their own, across the whole page. */
  lines?: boolean;
  by?: "persona" | "area";
  env: EnvChoice;
  snap: number;
  lens: Lens;
}

export type Lens = "all" | "orphans";

/** What reading and writing a location needs of the data: the timeline points. */
export interface RouteData {
  snapshots: { runId: string }[];
  LATEST: number;
}

export const DOORS: { view: View; label: string; path: string }[] = [
  { view: "now", label: "Now", path: "/now" },
  { view: "features", label: "Features", path: "/features" },
  { view: "personas", label: "Personas", path: "/personas" },
  { view: "planned", label: "Planned", path: "/planned" },
];

/** The door a view belongs to: the map and the scenario views are inner views of Features. */
export function doorOf(view: View): View {
  return view === "map" ? "features" : view;
}

/** Personas open on the reference env, the customer's truth; the other doors open on every env. */
export function defaultEnv(view: View): EnvChoice {
  return view === "personas" ? REFERENCE_ENV : "all";
}

export function parse(location: string, m: RouteData): Route {
  const [pathPart = "/", query = ""] = location.split("?");
  const parts = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(query);
  const envParam = q.get("env");
  const env: EnvChoice = ENVS.find((e) => e === envParam) ?? "all";
  const at = q.get("at");
  const snapIdx = at ? m.snapshots.findIndex((s) => s.runId === at) : -1;
  const lensParam = q.get("view") ?? q.get("lens");
  const route: Route = {
    view: "now",
    env,
    snap: snapIdx >= 0 ? snapIdx : m.LATEST,
    lens: lensParam === "orphans" ? "orphans" : "all",
  };
  const step = Number(q.get("step"));
  const search = q.get("q")?.trim();
  const by = q.get("by");
  if (parts[0] === "features") {
    route.view = "features";
    if (parts[1]) route.surface = parts[1];
    if (parts[1] && parts[2]) route.feature = parts.slice(1).join("/");
    if (search) route.q = search;
  } else if (parts[0] === "personas") {
    route.view = "personas";
    const lines = parts[1] === "lines";
    const rest = lines ? parts.slice(2) : parts.slice(1);
    if (lines) route.lines = true;
    else if (rest[0] === "gaps") route.gaps = true;
    else if (rest[0] === "no-persona") route.orphans = true;
    if (!route.gaps && !route.orphans) {
      if (rest[0]) route.persona = rest[0];
      if (rest[1]) route.station = rest[1];
    }
  } else if (parts[0] === "planned") {
    route.view = "planned";
    if (by === "persona" || by === "area") route.by = by;
  } else if (parts[0] === "scenarios" && parts[1]) {
    route.view = "map";
    route.scenario = parts.slice(1).join("/");
  } else if (parts[0] === "map") {
    route.view = "map";
    if (parts[1] === "in" && parts[2]) {
      // Ids may hold slashes, so the holder runs up to the last "item" or "area" piece.
      const k = Math.max(parts.lastIndexOf("item"), parts.lastIndexOf("area"));
      if (k > 2 && parts[k + 1]) {
        route.inside = parts.slice(2, k).join("/");
        if (parts[k] === "item") route.itemId = parts.slice(k + 1).join("/");
        else route.area = parts.slice(k + 1).join("/");
      } else route.inside = parts.slice(2).join("/");
    } else if (parts[1] === "item" && parts[2]) {
      // An item id may hold slashes itself, so the scenario starts at the last "scenario" piece.
      const k = parts.lastIndexOf("scenario");
      if (k > 2 && parts[k + 1]) {
        route.itemId = parts.slice(2, k).join("/");
        route.scenario = parts.slice(k + 1).join("/");
      } else route.itemId = parts.slice(2).join("/");
    } else {
      if (parts[1]) route.surface = parts[1];
      if (parts[2]) route.area = parts.slice(2).join("/");
    }
  }
  if (route.scenario && Number.isInteger(step) && step > 0) route.step = step;
  if (envParam !== "all" && route.env === "all")
    route.env = defaultEnv(route.view);
  return route;
}

/** A path piece that stays readable: ids keep their colons, slashes and braces; only what would break the path is escaped. */
function seg(s: string): string {
  return s.replace(/[%?#&\s]/g, (ch) => encodeURIComponent(ch));
}

export function format(r: Route, m: RouteData): string {
  let path = "/now";
  if (r.view === "features") {
    path = "/features";
    if (r.feature) {
      path += `/${r.feature.split("/").map(seg).join("/")}`;
    } else if (r.surface) path += `/${seg(r.surface)}`;
  } else if (r.view === "personas") {
    path = "/personas";
    if (r.lines) path += "/lines";
    if (r.gaps && !r.lines) path += "/gaps";
    else if (r.orphans && !r.lines) path += "/no-persona";
    else if (r.persona)
      path += `/${seg(r.persona)}${r.station ? `/${seg(r.station)}` : ""}`;
  } else if (r.view === "planned") path = "/planned";
  else if (r.view === "map") {
    if (r.scenario)
      path = r.itemId
        ? `/map/item/${seg(r.itemId)}/scenario/${seg(r.scenario)}`
        : `/scenarios/${seg(r.scenario)}`;
    else if (r.inside)
      path = `/map/in/${seg(r.inside)}${
        r.itemId
          ? `/item/${seg(r.itemId)}`
          : r.area
            ? `/area/${seg(r.area)}`
            : ""
      }`;
    else if (r.itemId) path = `/map/item/${seg(r.itemId)}`;
    else if (r.surface)
      path = `/map/${seg(r.surface)}${r.area ? `/${seg(r.area)}` : ""}`;
    else path = "/map";
  }
  const q = new URLSearchParams();
  if (r.env !== defaultEnv(r.view)) q.set("env", r.env);
  const at = m.snapshots[r.snap];
  if (r.snap !== m.LATEST && at) q.set("at", at.runId);
  if (r.view === "map" && r.lens !== "all") q.set("view", r.lens);
  if (r.scenario && r.step) q.set("step", String(r.step));
  if (r.view === "features" && r.q) q.set("q", r.q);
  if (r.view === "planned" && r.by) q.set("by", r.by);
  const qs = q.toString();
  return path + (qs ? `?${qs}` : "");
}

/** The same place in another door: a chosen env and the timeline point carry over, nothing else does. */
export function doorRoute(r: Route, view: View): Route {
  const env = r.env === defaultEnv(r.view) ? defaultEnv(view) : r.env;
  return { view, env, snap: r.snap, lens: "all" };
}
