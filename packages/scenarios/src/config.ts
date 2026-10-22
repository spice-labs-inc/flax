import { resolve } from "node:path";
import {
  loadWorkspace,
  parseWorkspace,
  section,
  type Workspace,
} from "@flax/core";
import type {
  CadenceConfig,
  EnvConfig,
  KindNaming,
  ScenariosConfig,
  SurfaceConfig,
} from "@flax/contract/config";
import { isRecord } from "@flax/contract";
import type { RecorderConfig } from "@flax/contract/config";
import { DEFAULT_PACE, DEFAULT_VIEWPORT } from "./record/pace.ts";

/** Names the workspace directory (the one holding flax.yml) when the command does not run in it. */
export const WORKSPACE_VARIABLE = "FLAX_WORKSPACE";

const DEFAULT_TOUCHES_MEDIA_TYPE = "application/vnd.flax.touches+json";

const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const rec = (v: unknown): Record<string, string> =>
  isRecord(v)
    ? Object.fromEntries(
        Object.entries(v).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      )
    : {};

/**
 * The scenarios configuration of a workspace: the shared keys of flax.yml (org, github, environments)
 * plus its `scenarios:` section, with every omitted value filled in. The `explorer:` section lends
 * its title and description, which the coverage report and the page both show.
 */
export function fromWorkspace(ws: Workspace): ScenariosConfig {
  const r = section(ws, "scenarios");
  const explorer = section(ws, "explorer");
  const perEnv = isRecord(r["envs"]) ? r["envs"] : {};
  const envs: EnvConfig[] = ws.environments.map((env) => {
    const raw = perEnv[env.id];
    const e: Record<string, unknown> = isRecord(raw) ? raw : {};
    return {
      name: env.id,
      label: env.label ?? env.id,
      hosts: rec(e["hosts"]),
      excludeTags: list(e["excludeTags"]),
      fixtures:
        e["fixtures"] === "never" || e["fixtures"] === false
          ? "never"
          : e["fixtures"] === "when-asked"
            ? "when-asked"
            : "always",
    };
  });
  const kinds = (v: unknown): KindNaming => ({
    bySegment: rec(isRecord(v) ? v["bySegment"] : undefined),
    byDetailKind: rec(isRecord(v) ? v["byDetailKind"] : undefined),
    default: str(isRecord(v) ? v["default"] : undefined, "Item"),
  });
  const surfaces: SurfaceConfig[] = (
    Array.isArray(r["surfaces"]) ? r["surfaces"] : []
  ).flatMap((s): SurfaceConfig[] => {
    if (!isRecord(s) || typeof s["name"] !== "string") return [];
    const role = s["role"];
    return [
      {
        name: s["name"],
        title: str(s["title"], s["name"]),
        role:
          role === "service" || role === "site" || role === "other"
            ? role
            : "ui",
        envs: list(s["envs"]),
        singleHome: s["singleHome"] === true,
        ...(typeof s["linkHost"] === "string"
          ? { linkHost: s["linkHost"] }
          : {}),
        kinds: kinds(s["kinds"]),
        ...(typeof s["pageKind"] === "string"
          ? { pageKind: s["pageKind"] }
          : {}),
        ...(typeof s["elementKind"] === "string"
          ? { elementKind: s["elementKind"] }
          : {}),
        islands: (Array.isArray(s["islands"]) ? s["islands"] : []).flatMap(
          (i) =>
            isRecord(i) && typeof i["island"] === "string"
              ? [
                  {
                    island: i["island"],
                    title: str(i["title"], i["island"]),
                    areas: list(i["areas"]),
                    features: list(i["features"]),
                    notes: str(i["notes"], "(?!)"),
                  },
                ]
              : [],
        ),
      },
    ];
  });
  if (surfaces.length === 0)
    throw new Error(
      "flax.yml: scenarios.surfaces must name at least one surface",
    );
  const http = isRecord(r["http"]) ? r["http"] : {};
  const vocab = isRecord(r["vocabulary"]) ? r["vocabulary"] : {};
  const paths = isRecord(r["paths"]) ? r["paths"] : {};
  const cucumber = isRecord(r["cucumber"]) ? r["cucumber"] : {};
  const probe = isRecord(r["versionProbe"]) ? r["versionProbe"] : undefined;
  const matchers = isRecord(r["matchers"]) ? r["matchers"] : {};
  const recorder = isRecord(r["recorder"]) ? r["recorder"] : {};
  const name = str(r["name"], `${ws.org}-scenarios`);
  return {
    workspaceDir: ws.dir,
    org: ws.org,
    repo: {
      owner: ws.github ?? "",
      workspace: str(r["repo"], ws.github ? `${ws.github}/${name}` : ""),
    },
    http: {
      userAgent: str(http["userAgent"], name),
      syntheticHeader: str(http["syntheticHeader"], "x-scenario-client"),
      syntheticValue: str(http["syntheticValue"], name),
    },
    envPrefix: str(r["envPrefix"], "FLAX_SCENARIOS"),
    envs,
    versionProbe: probe
      ? {
          host: str(probe["host"], "api"),
          path: str(probe["path"], "/version"),
        }
      : null,
    surfaces,
    vocabulary: {
      personaTypes: list(vocab["personaTypes"]),
      stages: list(vocab["stages"]),
      stationKinds: list(vocab["stationKinds"]).length
        ? list(vocab["stationKinds"])
        : ["surface", "planned", "elsewhere"],
      editions: list(vocab["editions"]),
      editionTitles: rec(vocab["editionTitles"]),
      elsewhere: str(
        vocab["elsewhere"],
        "Verified per release outside these runs",
      ),
    },
    personaRequiredFields: list(r["personaRequiredFields"]),
    textRules: (Array.isArray(r["textRules"]) ? r["textRules"] : []).flatMap(
      (t) =>
        isRecord(t) && typeof t["pattern"] === "string"
          ? [
              {
                pattern: t["pattern"],
                message: str(t["message"], t["pattern"]),
              },
            ]
          : [],
    ),
    matchers: { apiPath: matchers["apiPath"] !== false },
    touchesMediaType: str(r["touchesMediaType"], DEFAULT_TOUCHES_MEDIA_TYPE),
    cucumber: {
      imports: list(cucumber["imports"]).length
        ? list(cucumber["imports"])
        : ["support/**/*.ts", "steps/**/*.ts"],
      features: str(cucumber["features"], "features"),
      stripTypes: cucumber["stripTypes"] !== false,
      loaders: list(cucumber["loaders"]),
    },
    paths: {
      surfaces: str(paths["surfaces"], "surface"),
      features: str(paths["features"], "features"),
      personas: str(paths["personas"], "personas"),
      journeys: str(paths["journeys"], "journeys"),
      results: str(paths["results"], "results"),
      coverageMap: str(paths["coverageMap"], "coverage-map.json"),
      gaps: str(paths["gaps"], "GAPS.md"),
      journeysOut: str(paths["journeysOut"], "journeys.json"),
      board: str(paths["board"], "board.json"),
      documentation: str(paths["documentation"], "documentation.json"),
    },
    timezone: str(r["timezone"], "UTC"),
    branding: {
      title: str(explorer["title"], `${ws.org} scenarios`),
      description: str(explorer["description"], ""),
    },
    tagLabels: rec(r["tagLabels"]),
    recorder: recorderConfig(recorder, name),
    cadences: cadencesConfig(
      r["cadences"],
      envs.map((e) => e.name),
    ),
  };
}

/** Tags the runner gives a meaning of its own, so none of them can put a scenario on a cadence. */
const RUNNER_TAGS = ["@planned", "@local", "@fixture", "@dispatch", "@serial"];

/** The `cadences` key: per name, the tag that puts a scenario on it (default `@<name>`) and the envs that run it. */
function cadencesConfig(v: unknown, envNames: string[]): CadenceConfig[] {
  if (v === undefined || v === null) return [];
  const bad = (key: string, why: string) =>
    new Error(`flax.yml: scenarios.cadences${key} ${why}`);
  if (!isRecord(v)) throw bad("", "must map each cadence name to its settings");
  const cadences = Object.entries(v).map(([name, raw]): CadenceConfig => {
    const key = `.${name}`;
    if (!/^[A-Za-z0-9][\w-]*$/.test(name))
      throw bad(key, "is not a name: use letters, digits, - and _");
    if (raw !== null && !isRecord(raw))
      throw bad(key, "must be a mapping (tag, envs)");
    const o = isRecord(raw) ? raw : {};
    const tag = o["tag"] ?? `@${name}`;
    if (typeof tag !== "string" || !/^@\S+$/.test(tag))
      throw bad(`${key}.tag`, "must be one tag starting with @");
    if (RUNNER_TAGS.includes(tag) || tag.startsWith("@env:"))
      throw bad(`${key}.tag`, `${tag} already means something to the runner`);
    const envs = list(o["envs"]);
    const unknown = envs.find((e) => !envNames.includes(e));
    if (unknown)
      throw bad(
        `${key}.envs`,
        `names ${unknown}, which environments does not list`,
      );
    return { name, tag, envs };
  });
  const seen = new Map<string, string>();
  for (const c of cadences) {
    const other = seen.get(c.tag);
    if (other)
      throw bad("", `${other} and ${c.name} both use the tag ${c.tag}`);
    seen.set(c.tag, c.name);
  }
  return cadences;
}

/** The `recorder` key: defaults for browser recordings, each value that is missing or out of range taking the default. */
function recorderConfig(
  r: Record<string, unknown>,
  name: string,
): RecorderConfig {
  const num = (v: unknown, d: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : d;
  const pace = isRecord(r["pace"]) ? r["pace"] : {};
  const viewport = isRecord(r["viewport"]) ? r["viewport"] : {};
  const ms = (k: keyof RecorderConfig["pace"]) =>
    num(pace[k], DEFAULT_PACE[k], 0, 60_000);
  const px = (k: "width" | "height") =>
    Math.round(num(viewport[k], DEFAULT_VIEWPORT[k], 200, 7680));
  return {
    name: str(r["name"], name),
    pace: {
      typeMsPerChar: ms("typeMsPerChar"),
      afterActionMs: ms("afterActionMs"),
      readMs: ms("readMs"),
    },
    viewport: { width: px("width"), height: px("height") },
    scale: num(r["scale"], 1, 1, 4),
    highlightColor: str(r["highlightColor"], "#2f6fed"),
  };
}

/** The configuration a flax.yml text gives, for tests and tools that hold the file in memory. */
export function parseConfig(text: string, dir = "."): ScenariosConfig {
  return fromWorkspace(parseWorkspace(text, dir));
}

/** The workspace directory: FLAX_WORKSPACE when set, else the current directory. */
export function workspaceRoot(): string {
  return resolve(process.env[WORKSPACE_VARIABLE] ?? ".");
}

export function loadConfig(dir = workspaceRoot()): ScenariosConfig {
  return fromWorkspace(loadWorkspace(dir));
}

let cached: ScenariosConfig | undefined;

/** The config, read once per process. */
export function config(): ScenariosConfig {
  cached ??= loadConfig();
  return cached;
}

/** For tests: use this config instead of a file. */
export function setConfig(c: ScenariosConfig | undefined): void {
  cached = c;
}

export function envNames(c = config()): Env[] {
  return c.envs.map((e) => e.name);
}
export function surfaceNames(c = config()): string[] {
  return c.surfaces.map((s) => s.name);
}
/** The reference env: the first one. */
export function referenceEnv(c = config()): Env {
  return c.envs[0]!.name;
}
export function envConfig(env: Env, c = config()): EnvConfig {
  const e = c.envs.find((x) => x.name === env);
  if (!e) throw new Error(`unknown environment ${env}`);
  return e;
}
export function surfaceConfig(
  name: string,
  c = config(),
): SurfaceConfig | undefined {
  return c.surfaces.find((s) => s.name === name);
}
/** Envs where a run may create fixtures. */
export function fixtureEnvs(c = config()): Env[] {
  return c.envs.filter((e) => e.fixtures !== "never").map((e) => e.name);
}
/** The env-var names the runner hands the steps. */
export function envVariables(c = config()) {
  const p = c.envPrefix;
  return {
    env: `${p}_ENV`,
    runId: `${p}_RUN_ID`,
    fixtures: `${p}_FIXTURES`,
    record: `${p}_RECORD`,
  };
}
type Env = string;
