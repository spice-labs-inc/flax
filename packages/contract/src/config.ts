/** What the scenarios runner and the explorer read from a workspace's flax.yml, after defaults. */

import type { UseClass } from "./usage.ts";

export interface EnvConfig {
  /** Short name, used in run ids, tags (@env:<name>), results/<name>/ and the data files. */
  name: string;
  /** What people see. */
  label: string;
  /** Hosts a scenario or a builder reaches by key: api, web, admin... */
  hosts: Record<string, string>;
  /** Tags a scheduled run never runs in this env (the runner's tag policy and the page's reasons). */
  excludeTags: string[];
  /** Tags that run here all the same: a scenario carrying one runs even if it also carries an excluded tag. */
  allowTags: string[];
  /** Fixture scenarios here: `always` (runs create them and the page assumes so), `when-asked` (only a run started with --fixtures, so the page assumes it only after seeing one), `never` (the runner refuses --fixtures). */
  fixtures: "always" | "when-asked" | "never";
}

/** A slower schedule for scenarios too heavy for every run: a scenario with the tag runs only in a run started with `--cadence <name>`. */
export interface CadenceConfig {
  name: string;
  tag: string;
  /** Envs a run on this cadence runs in; empty means every env. */
  envs: string[];
}

/** How a surface's items are named, in product words, from the shape of their ids and details. */
export interface KindNaming {
  /** By the second segment of the id (`<surface>:<segment>:...`). */
  bySegment: Record<string, string>;
  /** By `details.kind`; wins over the segment. */
  byDetailKind: Record<string, string>;
  /** When nothing matches. */
  default: string;
}

/** A surface drawn as several islands, each taking the areas it names; the rest stays on the surface's own island. */
export interface IslandSplit {
  island: string;
  title: string;
  areas: string[];
  /** Planned scenario feature files that land on this island. */
  features: string[];
  /** A regular expression (source text) matching the surface notes and out-of-scope labels that belong to it. */
  notes: string;
}

export interface SurfaceConfig {
  name: string;
  title: string;
  /** `service` for an API-like surface: its operations carry needs and the `api:* <path>` station matcher applies. */
  role: "ui" | "service" | "site" | "other";
  /** Envs this surface exists in; empty means every env. */
  envs: string[];
  /** One deployment for all envs (a public website): panels name it by its area, never by an env. */
  singleHome: boolean;
  /** The env host key an item's `details.routeId` is appended to, for a link per env; none for no links. */
  linkHost?: string;
  kinds: KindNaming;
  /** The kind that opens as a sub-map holding elements (a page), and the kind its parts are (an element). */
  pageKind?: string;
  elementKind?: string;
  islands: IslandSplit[];
}

export interface DatasetVocabulary {
  personaTypes: string[];
  stages: string[];
  stationKinds: string[];
  editions: string[];
  /** What people see for each edition id. */
  editionTitles: Record<string, string>;
  /** How the page describes a station or scenario verified outside these runs (station kind `elsewhere`). */
  elsewhere: string;
}

export interface ScenariosConfig {
  /** Absolute path of the workspace directory, the one holding flax.yml. */
  workspaceDir: string;
  /** The organization's short name from flax.yml. */
  org: string;
  /** K10 repo identity: the GitHub owner builders clone from, and this workspace's own repo for links. */
  repo: { owner: string; workspace: string };
  /** K11 HTTP identity: the synthetic-client header and user agent every scenario request carries. */
  http: { userAgent: string; syntheticHeader: string; syntheticValue: string };
  /** K9 env-var prefix for the variables the runner hands the steps. */
  envPrefix: string;
  /** K1, K2, K8, K13: envs in display and merge-precedence order; the first is the reference env. */
  envs: EnvConfig[];
  /** K13: the path on the `api` host whose answer run.json records as the API version. */
  versionProbe: { host: string; path: string } | null;
  /** K3, K19, K20, K21: surfaces in display order. */
  surfaces: SurfaceConfig[];
  /** K4 */
  vocabulary: DatasetVocabulary;
  /** K5: persona fields beyond the core that must be present. */
  personaRequiredFields: string[];
  /** K6: text rules as regular expressions (source) with the message to give. */
  textRules: { pattern: string; message: string }[];
  /** K7: station matcher extensions; `api-path` turns `api:* <path>` into every method of a service surface. */
  matchers: { apiPath: boolean };
  /** K12 */
  touchesMediaType: string;
  /** Cucumber: import globs and the features directory, relative to the workspace; whether the runner type-strips `.ts` step files itself (default) and any extra loader modules to register (such as `tsx/esm`). */
  cucumber: {
    imports: string[];
    features: string;
    stripTypes: boolean;
    loaders: string[];
  };
  /** K15 */
  paths: {
    surfaces: string;
    features: string;
    personas: string;
    journeys: string;
    results: string;
    coverageMap: string;
    gaps: string;
    journeysOut: string;
    board: string;
    documentation: string;
  };
  /** K16 */
  timezone: string;
  /** K17 */
  branding: { title: string; description: string };
  /** The project's own glossary entries, from the explorer section, in flax.yml order. */
  glossary: GlossaryEntry[];
  /** The usage view, from `explorer.usage`; null when the workspace has none. */
  usage: UsageConfig | null;
  /** K22 */
  tagLabels: Record<string, string>;
  /** K24 */
  recorder: RecorderConfig;
  /** Screenshots taken by `flax scenarios run --capture`. */
  capture: CaptureConfig;
  /** Slower schedules, in flax.yml order; ordinary runs leave their scenarios out. */
  cadences: CadenceConfig[];
}

/** One glossary entry of the project's own; `section` names a built-in heading to join, else it lands under "This project". */
export interface GlossaryEntry {
  term: string;
  /** Plain text; a link is written `[label](url)`. */
  text: string;
  section?: string;
}

/** How the explorer shows real use (the contract is @flax/contract/usage). */
export interface UsageConfig {
  /** The environment the use comes from; the reference environment unless flax.yml names another. */
  env: string;
  /** What people see for each class of use: after a count of organizations for `outside`, as the subject of a sentence for the others. */
  labels: Record<UseClass, string>;
  /** What one counted organization is called, and several. */
  org: { one: string; many: string };
  /** Surfaces whose items count requests rather than uses, such as a command line tool that makes several calls per command. */
  requestSurfaces: string[];
  /** A usage history file (relative to the workspace) the data build reads when no service delivered one, such as a demo's. */
  history?: string;
}

/** How `flax scenarios run --capture` selects scenarios and sets up the page its screenshots are taken in. */
export interface CaptureConfig {
  /** The tag that selects a scenario for capture runs; `<tag>:<name>` selects it and limits it to that capture. */
  tag: string;
  viewport: { width: number; height: number };
  /** Device pixels per CSS pixel: a screenshot is the viewport (or element) times this. */
  scale: number;
  colorScheme: "light" | "dark";
  locale: string;
  /** An IANA time zone for the page; empty for the machine's own. */
  timezone: string;
}

/** Defaults for browser recordings (`flax scenarios run --record`); a scenario's video sidecar overrides pace and viewport. */
export interface RecorderConfig {
  name: string;
  pace: { typeMsPerChar: number; afterActionMs: number; readMs: number };
  viewport: { width: number; height: number };
  /** Device pixels per CSS pixel: the video, the screens and the timeline's boxes are the viewport times this. */
  scale: number;
  /** The highlight box and click ripple color. */
  highlightColor: string;
}
