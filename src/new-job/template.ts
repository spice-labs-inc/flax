import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { KIT_ROOT } from "../lib/paths.ts";
import { byCodePoint } from "../lib/sort.ts";
import { workspace, type Workspace } from "../lib/workspace.ts";

/** Where the kit keeps its reference jobs: one folder per template, each with a template.yml beside the job's files. */
export const TEMPLATES_DIR = join(KIT_ROOT, "jobs");
export const TEMPLATE_FILE = "template.yml";
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;
const TEMPLATE_NAME = /^[a-z][a-z0-9-]{1,40}$/;

export interface TemplateField {
  description: string;
  example?: string;
}

export interface Template {
  name: string;
  description: string;
  fields: Record<string, TemplateField>;
  /** What the template leaves to the workspace, in plain words. */
  notes: string[];
  /** Every file of the template, relative to its folder, template.yml left out. */
  files: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    byCodePoint(a.name, b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path, base));
    else out.push(relative(base, path));
  }
  return out;
}

/** The templates the kit ships, by name. */
export function listTemplates(dir: string = TEMPLATES_DIR): Template[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && existsSync(join(dir, e.name, TEMPLATE_FILE)),
    )
    .map((e) => loadTemplate(e.name, dir))
    .sort((a, b) => byCodePoint(a.name, b.name));
}

export function loadTemplate(
  name: string,
  dir: string = TEMPLATES_DIR,
): Template {
  if (!TEMPLATE_NAME.test(name))
    throw new Error(`"${name}" is not a template name`);
  const folder = join(dir, name);
  if (!existsSync(folder) || !statSync(folder).isDirectory())
    throw new Error(
      `there is no template named ${name}; the templates are ${
        listTemplates(dir)
          .map((t) => t.name)
          .join(", ") || "none"
      }`,
    );
  const raw: unknown = parse(readFileSync(join(folder, TEMPLATE_FILE), "utf8"));
  if (!isObject(raw) || typeof raw["description"] !== "string")
    throw new Error(`${name}/${TEMPLATE_FILE} needs a description`);
  const fields: Record<string, TemplateField> = {};
  if (raw["fields"] !== undefined) {
    if (!isObject(raw["fields"]))
      throw new Error(`${name}/${TEMPLATE_FILE}: fields must be a mapping`);
    for (const [key, value] of Object.entries(raw["fields"])) {
      if (
        !/^[a-z][A-Za-z0-9]*$/.test(key) ||
        !isObject(value) ||
        typeof value["description"] !== "string"
      )
        throw new Error(
          `${name}/${TEMPLATE_FILE}: field ${key} needs a description`,
        );
      fields[key] = {
        description: value["description"],
        ...(typeof value["example"] === "string"
          ? { example: value["example"] }
          : {}),
      };
    }
  }
  const notes = Array.isArray(raw["notes"]) ? raw["notes"].map(String) : [];
  const files = listFiles(folder).filter((f) => f !== TEMPLATE_FILE);
  return { name, description: raw["description"], fields, notes, files };
}

/** The staggered crons of a check job: one environment every three hours, an hour apart, keeping clear of the hour. */
export function environmentCrons(
  environments: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  environments.forEach((env, i) => {
    const start = i % 3;
    out[env] = `20 ${start}-${21 + start}/3 * * *`;
  });
  return out;
}

function flowMapping(map: Record<string, string>): string {
  return `{ ${Object.entries(map)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ")} }`;
}

/** The values every placeholder of a template takes: the built-ins from the workspace, the fields from --set. */
export function templateValues(
  template: Template,
  name: string,
  owner: string,
  set: Record<string, string>,
  ws: Workspace = workspace(),
): Record<string, string> {
  const unknown = Object.keys(set).filter((k) => !(k in template.fields));
  if (unknown.length > 0)
    throw new Error(
      `${template.name} has no field ${unknown.join(", ")}; its fields are ${Object.keys(template.fields).join(", ") || "none"}`,
    );
  const missing = Object.keys(template.fields).filter(
    (k) => set[k] === undefined || set[k] === "",
  );
  if (missing.length > 0)
    throw new Error(
      `${template.name} needs ${missing.map((k) => `--set ${k}=<${template.fields[k]!.example ?? "value"}>`).join(" ")}`,
    );
  const envs = ws.environments;
  return {
    name,
    owner,
    github: ws.github,
    repo: ws.repo,
    displayName: ws.displayName,
    environments: flowMapping(environmentCrons(envs)),
    environmentsList: `[${envs.join(", ")}]`,
    firstEnvironment: envs[0] ?? "",
    ...set,
  };
}

/** The template's text with every placeholder filled; a placeholder with no value is an error. */
export function fillTemplate(
  text: string,
  values: Record<string, string>,
  file: string,
): string {
  return text.replace(PLACEHOLDER, (whole, key: string) => {
    const value = values[key];
    if (value === undefined)
      throw new Error(`${file} uses {{${key}}}, which nothing fills`);
    return value;
  });
}

/** Every file of the template filled, keyed by path inside the job folder. */
export function renderTemplate(
  template: Template,
  values: Record<string, string>,
  dir: string = TEMPLATES_DIR,
): Record<string, string | Buffer> {
  const out: Record<string, string | Buffer> = {};
  for (const file of template.files) {
    const raw = readFileSync(join(dir, template.name, file));
    out[file] = /\.(png|jpg|webm|mp4|wav)$/.test(file)
      ? raw
      : fillTemplate(raw.toString("utf8"), values, `${template.name}/${file}`);
  }
  return out;
}
