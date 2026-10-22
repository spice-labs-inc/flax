import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { describeErrors } from "./ajv.ts";
import { MCP_SERVERS_FILE, MCP_SERVERS_SCHEMA_PATH } from "./paths.ts";
import { firstLine, problem, type Problem } from "./problem.ts";

export const PLATFORMS = ["linux-amd64", "linux-arm64"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const SERVER_NAMES = [
  "kubernetes-mcp-server",
  "github-mcp-server",
] as const;
export type ServerName = (typeof SERVER_NAMES)[number];

export interface ServerAsset {
  asset: string;
  sha256: string;
  binary?: string;
}

export interface ServerPin {
  repository: string;
  version: string;
  platforms: Record<Platform, ServerAsset>;
}

/** An mcp-servers.yml that has passed its schema and the checks below. */
export type ServerPins = Record<ServerName, ServerPin>;

let validator: ValidateFunction | undefined;

function pinsValidator(): ValidateFunction {
  validator ??= new Ajv2020({
    allErrors: true,
    strict: true,
    verbose: true,
  }).compile(JSON.parse(readFileSync(MCP_SERVERS_SCHEMA_PATH, "utf8")));
  return validator;
}

/** The release download URL of one pinned asset. */
export function assetUrl(pin: ServerPin, asset: ServerAsset): string {
  return `https://github.com/${pin.repository}/releases/download/v${pin.version}/${asset.asset}`;
}

export function isArchive(asset: ServerAsset): boolean {
  return asset.asset.endsWith(".tar.gz");
}

export function loadServerPins(root: string): {
  pins?: ServerPins;
  problems: Problem[];
} {
  const file = MCP_SERVERS_FILE;
  const path = join(root, file);
  if (!existsSync(path)) return { problems: [problem(file, "is missing")] };
  let data: unknown;
  try {
    data = parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      problems: [problem(file, `is not valid YAML: ${firstLine(err)}`)],
    };
  }
  const validate = pinsValidator();
  if (!validate(data))
    return {
      problems: describeErrors(validate.errors).map((e) =>
        problem(file, e.message, e.field),
      ),
    };
  const pins = data as ServerPins;
  const problems: Problem[] = [];
  for (const name of SERVER_NAMES) {
    for (const platform of PLATFORMS) {
      const asset = pins[name].platforms[platform];
      const field = `${name}.platforms.${platform}`;
      if (/^0+$/.test(asset.sha256))
        problems.push(
          problem(file, "is the all-zeros placeholder", `${field}.sha256`),
        );
      if (isArchive(asset) && asset.binary === undefined)
        problems.push(
          problem(
            file,
            "is required for a .tar.gz asset: the binary's path inside it",
            `${field}.binary`,
          ),
        );
      if (!isArchive(asset) && asset.binary !== undefined)
        problems.push(
          problem(file, "applies only to a .tar.gz asset", `${field}.binary`),
        );
    }
  }
  return problems.length > 0 ? { problems } : { pins, problems };
}
