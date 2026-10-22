import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isRecord } from "@flax/contract";
import { parseAllDocuments } from "yaml";
import type { Pace, Viewport } from "./pace.ts";
import type { StepInfo } from "./steps.ts";

/** A step reference: a 1-based index into the scenario's own steps (Background excluded), or a step's exact text with its keyword as written. */
export type StepRef = number | string;

/** A title or closing card not tied to a step; `text` is narration spoken over it. */
export interface Card {
  chapter?: string;
  heading: string;
  sub?: string;
  items?: (string | CardItem)[];
  text: string;
}

export interface CardItem {
  label: string;
  /** An icon name, interpreted by the renderer. */
  icon?: string;
}

/** What a terminal scene shows instead of what the step ran: a command line to display, and lines typed before it. */
export interface TerminalOverride {
  at: StepRef;
  display?: string;
  preface?: string[];
}

/**
 * A video sidecar as written: `<name>.video.yml` beside `<name>.feature` for one recorded
 * scenario, or `<name>.<id>.video.yml` per scenario when a feature has several; matched on `scenario`.
 */
export interface VideoSidecar {
  /** The exact scenario name in the feature (an outline's name after its example values are filled in). */
  scenario: string;
  /** The media id, stable across re-recordings: the output directory's name. */
  id: string;
  title: string;
  description?: string;
  /** A narration voice id, interpreted by the renderer. */
  voice?: string;
  pace?: Partial<Pace>;
  viewport?: Viewport & { deviceScaleFactor?: number };
  intro?: Card;
  outro?: Card;
  /** Spoken text; each block starts at its step and runs until the next block's. */
  narration?: { at: StepRef; text: string }[];
  chapters?: { at: StepRef; title: string }[];
  /** Which steps get an on-screen highlight: every Then (the default), none, or the steps listed. */
  highlight?: "then" | "none" | StepRef[];
  /** Steps that run but are not filmed; every Given by default. */
  hide?: StepRef[];
  poster?: { at: StepRef; title?: string; kicker?: string };
  terminal?: TerminalOverride | TerminalOverride[];
  /** The name of a stand-in rule set the consumer supplies. */
  standIns?: string;
  /** Passed through untouched to whatever delivers the video. */
  publish?: Record<string, unknown>;
}

/** A sidecar checked against its scenario: every reference an index, every default filled in. */
export interface ResolvedSidecar {
  scenario: string;
  id: string;
  title: string;
  description?: string;
  voice?: string;
  pace: Pace;
  viewport: Viewport & { deviceScaleFactor: number };
  intro: (Card & { items: CardItem[] }) | null;
  outro: (Card & { items: CardItem[] }) | null;
  narration: { at: number; text: string }[];
  chapters: { at: number; title: string }[];
  highlight: number[];
  hide: number[];
  poster: { at: number; title?: string; kicker?: string } | null;
  terminal: { at: number; display?: string; preface: string[] }[];
  standIns?: string;
  publish: Record<string, unknown>;
}

/** One sidecar document read from a file, with the text it was read from. */
export interface SidecarDocument {
  file: string;
  /** The YAML document's own text, for the copy beside the recording. */
  source: string;
  sidecar: VideoSidecar;
}

export const SIDECAR_KEYS = [
  "scenario",
  "id",
  "title",
  "description",
  "voice",
  "pace",
  "viewport",
  "intro",
  "outro",
  "narration",
  "chapters",
  "highlight",
  "hide",
  "poster",
  "terminal",
  "standIns",
  "publish",
] as const;
const PACE_KEYS = ["typeMsPerChar", "afterActionMs", "readMs"] as const;
const CARD_KEYS = ["chapter", "heading", "sub", "items", "text"] as const;
export const SIDECAR_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The sidecar files of a feature file: `<name>.video.yml` and every `<name>.<id>.video.yml`
 * beside `<name>.feature`, leaving out those that belong to a feature `<name>.<id>.feature`.
 * Each file's id part, when it has one, is returned to check against the sidecar's id.
 */
export function sidecarFiles(
  featureFile: string,
): { file: string; id?: string }[] {
  const dir = dirname(featureFile);
  const name = basename(featureFile).replace(/\.feature$/, "");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.sort().flatMap((e): { file: string; id?: string }[] => {
    if (e === `${name}.video.yml`) return [{ file: join(dir, e) }];
    if (!e.startsWith(`${name}.`) || !e.endsWith(".video.yml")) return [];
    const id = e.slice(name.length + 1, -".video.yml".length);
    if (id === "" || entries.includes(`${name}.${id}.feature`)) return [];
    return [{ file: join(dir, e), id }];
  });
}

/**
 * Reads the sidecar documents of one file, checking their shape only (their step references
 * need the scenario: see resolveSidecar). Every problem is reported, prefixed with the file and
 * the key it is about.
 */
export function parseSidecars(
  text: string,
  file: string,
): { documents: SidecarDocument[]; errors: string[] } {
  const documents: SidecarDocument[] = [];
  const errors: string[] = [];
  const docs = parseAllDocuments(text);
  if (!Array.isArray(docs)) return { documents, errors };
  docs.forEach((doc, n) => {
    const where = docs.length > 1 ? `${file} (document ${n + 1})` : file;
    if (doc.errors.length > 0) {
      for (const e of doc.errors) errors.push(`${where}: ${e.message}`);
      return;
    }
    const value: unknown = doc.toJS();
    if (value === null || value === undefined) return;
    const problems = sidecarShapeErrors(value);
    if (problems.length > 0) {
      for (const p of problems) errors.push(`${where}: ${p}`);
      return;
    }
    documents.push({
      file: where,
      source: docs.length > 1 ? doc.toString().replace(/^---\s*\n/, "") : text,
      sidecar: value as VideoSidecar,
    });
  });
  return { documents, errors };
}

const nonEmpty = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/** What is wrong with a parsed sidecar's shape, one message per problem; the JSON schema says the same. */
export function sidecarShapeErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["a sidecar is a mapping of keys to values"];
  const errors: string[] = [];
  const unknownKeys = (
    v: Record<string, unknown>,
    allowed: readonly string[],
    where: string,
  ) => {
    for (const k of Object.keys(v))
      if (!allowed.includes(k))
        errors.push(`${where}unknown key ${k}; use ${allowed.join(", ")}`);
  };
  unknownKeys(value, SIDECAR_KEYS, "");
  const text = (
    v: Record<string, unknown>,
    k: string,
    required: boolean,
    where = "",
  ) => {
    if (v[k] === undefined) {
      if (required) errors.push(`${where}${k} is required`);
    } else if (!nonEmpty(v[k]))
      errors.push(`${where}${k} must be a non-empty string`);
  };
  text(value, "scenario", true);
  text(value, "id", true);
  text(value, "title", true);
  text(value, "description", false);
  text(value, "voice", false);
  text(value, "standIns", false);
  if (typeof value["id"] === "string" && !SIDECAR_ID.test(value["id"]))
    errors.push(
      `id ${value["id"]} must be lowercase letters, digits and dashes, starting with a letter or digit`,
    );

  const ref = (v: unknown, where: string) => {
    if (typeof v === "number" ? !Number.isInteger(v) || v < 1 : !nonEmpty(v))
      errors.push(`${where} must be a step number from 1 or a step's text`);
  };
  const blocks = (k: string, field: "text" | "title") => {
    const v = value[k];
    if (v === undefined) return;
    if (!Array.isArray(v)) return errors.push(`${k} must be a list`);
    v.forEach((b: unknown, i) => {
      if (!isRecord(b))
        return errors.push(`${k}[${i}] must have at and ${field}`);
      unknownKeys(b, ["at", field], `${k}[${i}]: `);
      ref(b["at"], `${k}[${i}].at`);
      if (!nonEmpty(b[field]))
        errors.push(`${k}[${i}].${field} must be a non-empty string`);
    });
  };
  blocks("narration", "text");
  blocks("chapters", "title");

  for (const k of ["intro", "outro"]) {
    const card = value[k];
    if (card === undefined) continue;
    if (!isRecord(card)) {
      errors.push(`${k} must be a mapping with heading and text`);
      continue;
    }
    unknownKeys(card, CARD_KEYS, `${k}: `);
    text(card, "heading", true, `${k}.`);
    text(card, "text", true, `${k}.`);
    text(card, "chapter", false, `${k}.`);
    text(card, "sub", false, `${k}.`);
    const items = card["items"];
    if (items === undefined) continue;
    if (!Array.isArray(items)) {
      errors.push(`${k}.items must be a list`);
      continue;
    }
    items.forEach((item: unknown, i) => {
      if (nonEmpty(item)) return;
      if (!isRecord(item))
        return errors.push(`${k}.items[${i}] must be a label or have label`);
      unknownKeys(item, ["label", "icon"], `${k}.items[${i}]: `);
      text(item, "label", true, `${k}.items[${i}].`);
      text(item, "icon", false, `${k}.items[${i}].`);
    });
  }

  const pace = value["pace"];
  if (pace !== undefined) {
    if (!isRecord(pace)) errors.push("pace must be a mapping");
    else {
      unknownKeys(pace, PACE_KEYS, "pace: ");
      for (const k of PACE_KEYS) {
        const v = pace[k];
        if (
          v !== undefined &&
          (typeof v !== "number" || !Number.isFinite(v) || v < 0)
        )
          errors.push(`pace.${k} must be a number of milliseconds, 0 or more`);
      }
    }
  }
  const viewport = value["viewport"];
  if (viewport !== undefined) {
    if (!isRecord(viewport)) errors.push("viewport must be a mapping");
    else {
      unknownKeys(
        viewport,
        ["width", "height", "deviceScaleFactor"],
        "viewport: ",
      );
      for (const k of ["width", "height"]) {
        const v = viewport[k];
        if (
          typeof v !== "number" ||
          !Number.isInteger(v) ||
          v < 200 ||
          v > 7680
        )
          errors.push(
            `viewport.${k} must be a whole number of pixels, 200 to 7680`,
          );
      }
      const dsf = viewport["deviceScaleFactor"];
      if (
        dsf !== undefined &&
        (typeof dsf !== "number" || !(dsf >= 1 && dsf <= 4))
      )
        errors.push("viewport.deviceScaleFactor must be a number from 1 to 4");
    }
  }
  const highlight = value["highlight"];
  if (highlight !== undefined && highlight !== "then" && highlight !== "none") {
    if (!Array.isArray(highlight))
      errors.push("highlight must be then, none or a list of steps");
    else highlight.forEach((v: unknown, i) => ref(v, `highlight[${i}]`));
  }
  const hide = value["hide"];
  if (hide !== undefined) {
    if (!Array.isArray(hide)) errors.push("hide must be a list of steps");
    else hide.forEach((v: unknown, i) => ref(v, `hide[${i}]`));
  }
  const poster = value["poster"];
  if (poster !== undefined) {
    if (!isRecord(poster)) errors.push("poster must be a mapping with at");
    else {
      unknownKeys(poster, ["at", "title", "kicker"], "poster: ");
      ref(poster["at"], "poster.at");
      text(poster, "title", false, "poster.");
      text(poster, "kicker", false, "poster.");
    }
  }
  const terminal = value["terminal"];
  if (terminal !== undefined) {
    const list = Array.isArray(terminal) ? terminal : [terminal];
    list.forEach((t: unknown, i) => {
      const where = Array.isArray(terminal) ? `terminal[${i}]` : "terminal";
      if (!isRecord(t))
        return errors.push(`${where} must be a mapping with at`);
      unknownKeys(t, ["at", "display", "preface"], `${where}: `);
      ref(t["at"], `${where}.at`);
      text(t, "display", false, `${where}.`);
      const preface = t["preface"];
      if (
        preface !== undefined &&
        (!Array.isArray(preface) ||
          !preface.every((l) => typeof l === "string"))
      )
        errors.push(`${where}.preface must be a list of lines`);
      if (t["display"] === undefined && preface === undefined)
        errors.push(`${where} needs display, preface or both`);
    });
  }
  if (value["publish"] !== undefined && !isRecord(value["publish"]))
    errors.push("publish must be a mapping");
  return errors;
}

/** The sidecar a run that records every selected scenario gives one that has none. */
export function defaultSidecar(name: string, id: string): VideoSidecar {
  return { scenario: name, id, title: name };
}

/** A scenario name as a media id: lowercase words joined by dashes. */
export function slug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "scenario"
  );
}

const card = (c: Card | undefined) =>
  c
    ? {
        ...c,
        items: (c.items ?? []).map((i) =>
          typeof i === "string" ? { label: i } : i,
        ),
      }
    : null;

/**
 * Checks a sidecar against the scenario it names and resolves it: step references become
 * indexes, defaults are filled in. Narration and chapters must start at visible steps, each
 * block at a later step than the one before (a block runs until the next one starts, so two
 * at one step, or out of order, would overlap).
 */
export function resolveSidecar(
  sidecar: VideoSidecar,
  steps: readonly StepInfo[],
  defaults: { pace: Pace; viewport: Viewport; scale: number },
  file = "sidecar",
): { sidecar?: ResolvedSidecar; errors: string[] } {
  const own = steps.filter((s) => !s.background);
  const errors: string[] = [];
  const listing = () =>
    own.map((s) => `${s.index} ${s.keyword} ${s.text}`).join("; ");
  const resolve = (ref: StepRef, where: string): number | undefined => {
    if (typeof ref === "number") {
      if (ref >= 1 && ref <= own.length) return ref;
      errors.push(
        `${file}: ${where}: step ${ref} is out of range; "${sidecar.scenario}" has ${own.length} steps (Background steps are not counted): ${listing()}`,
      );
      return undefined;
    }
    const wanted = ref.trim().replace(/\s+/g, " ");
    const found = own.filter(
      (s) => `${s.keyword} ${s.text}`.replace(/\s+/g, " ") === wanted,
    );
    if (found.length === 1) return found[0]!.index;
    errors.push(
      found.length === 0
        ? `${file}: ${where}: no step of "${sidecar.scenario}" reads "${ref}" (keyword as written included); its steps: ${listing()}`
        : `${file}: ${where}: "${ref}" is steps ${found.map((s) => s.index).join(" and ")}; use the step number`,
    );
    return undefined;
  };
  const refs = (list: readonly StepRef[] | undefined, key: string) =>
    (list ?? []).flatMap((r, i) => {
      const n = resolve(r, `${key}[${i}]`);
      return n === undefined ? [] : [n];
    });

  const hide = new Set(
    sidecar.hide === undefined
      ? own.filter((s) => s.kind === "context").map((s) => s.index)
      : refs(sidecar.hide, "hide"),
  );
  const highlight =
    sidecar.highlight === "none"
      ? []
      : sidecar.highlight === undefined || sidecar.highlight === "then"
        ? own
            .filter((s) => s.kind === "outcome" && !hide.has(s.index))
            .map((s) => s.index)
        : refs(sidecar.highlight, "highlight");
  const visible = (at: number, where: string) => {
    if (hide.has(at))
      errors.push(
        `${file}: ${where}: step ${at} is hidden (every Given is unless hide lists the steps to hide), so nothing on screen would go with it`,
      );
  };

  const ordered = <T extends { at: StepRef }>(
    list: readonly T[] | undefined,
    key: string,
  ): (T & { at: number })[] => {
    const out: (T & { at: number })[] = [];
    let previous: { at: number; i: number } | undefined;
    (list ?? []).forEach((b, i) => {
      const at = resolve(b.at, `${key}[${i}].at`);
      if (at === undefined) return;
      visible(at, `${key}[${i}].at`);
      if (previous && at <= previous.at)
        errors.push(
          `${file}: ${key}[${i}].at: step ${at} overlaps ${key}[${previous.i}] at step ${previous.at}; each block runs until the next one starts, so each must start at a later step`,
        );
      previous = { at, i };
      out.push({ ...b, at });
    });
    return out;
  };
  const narration = ordered(sidecar.narration, "narration").map((b) => ({
    at: b.at,
    text: b.text,
  }));
  const chapters = ordered(sidecar.chapters, "chapters").map((b) => ({
    at: b.at,
    title: b.title,
  }));
  let poster: ResolvedSidecar["poster"] = null;
  if (sidecar.poster) {
    const at = resolve(sidecar.poster.at, "poster.at");
    if (at !== undefined) {
      visible(at, "poster.at");
      poster = { ...sidecar.poster, at };
    }
  }
  const overrides =
    sidecar.terminal === undefined
      ? []
      : Array.isArray(sidecar.terminal)
        ? sidecar.terminal
        : [sidecar.terminal];
  const terminal: ResolvedSidecar["terminal"] = [];
  overrides.forEach((t, i) => {
    const where = Array.isArray(sidecar.terminal)
      ? `terminal[${i}]`
      : "terminal";
    const at = resolve(t.at, `${where}.at`);
    if (at === undefined) return;
    visible(at, `${where}.at`);
    if (terminal.some((x) => x.at === at))
      errors.push(
        `${file}: ${where}.at: step ${at} already has a terminal override`,
      );
    terminal.push({
      at,
      ...(t.display !== undefined ? { display: t.display } : {}),
      preface: t.preface ?? [],
    });
  });
  if (errors.length > 0) return { errors };
  return {
    errors,
    sidecar: {
      scenario: sidecar.scenario,
      id: sidecar.id,
      title: sidecar.title,
      ...(sidecar.description !== undefined
        ? { description: sidecar.description }
        : {}),
      ...(sidecar.voice !== undefined ? { voice: sidecar.voice } : {}),
      pace: { ...defaults.pace, ...sidecar.pace },
      viewport: {
        width: sidecar.viewport?.width ?? defaults.viewport.width,
        height: sidecar.viewport?.height ?? defaults.viewport.height,
        deviceScaleFactor:
          sidecar.viewport?.deviceScaleFactor ?? defaults.scale,
      },
      intro: card(sidecar.intro),
      outro: card(sidecar.outro),
      narration,
      chapters,
      highlight: [...new Set(highlight)].sort((a, b) => a - b),
      hide: [...hide].sort((a, b) => a - b),
      poster,
      terminal: terminal.sort((a, b) => a.at - b.at),
      ...(sidecar.standIns !== undefined ? { standIns: sidecar.standIns } : {}),
      publish: sidecar.publish ?? {},
    },
  };
}
