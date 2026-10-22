import { X509Certificate } from "node:crypto";
import { workspace, type KeyMode, type Provider } from "./workspace.ts";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { describeErrors } from "./ajv.ts";
import type { Model } from "./allowlists.ts";
import { GATEWAY_FILE } from "./paths.ts";
import { GATEWAY_SCHEMA } from "./schemas.ts";
import { WORKSPACE_FILE } from "./workspace.ts";
import { firstLine, problem, type Problem } from "./problem.ts";

/**
 * Where the runner sends model calls. litellm: a gateway.yml that has
 * passed schema/gateway.schema.json, a LiteLLM deployment that issues one
 * key per run. static: the provider's own Messages API behind one static
 * key (flax.yml agents.provider.baseUrl), with gateway.yml optional.
 */
export interface Gateway {
  /** none is litellm. */
  mode?: KeyMode;
  /** An https address only the runner calls. */
  url: string;
  /** The name the gateway's certificate is issued for. */
  server_name: string;
  /** The LiteLLM team run keys belong to; "static" when there are none. */
  team: string;
  /** File name of the CA root at the repository root; none trusts the system roots. */
  ca?: string;
  key_max_usd: number;
  key_max_minutes: number;
}

/** What a static provider's key may last and spend: the kit caps nothing beyond the per-run worst case. */
export const STATIC_KEY_MAX_MINUTES = 24 * 60;

/**
 * The only model secret the runner needs: a LiteLLM team
 * service account key that can issue, block and read keys of its team. It
 * stays in the runner process, never reaching lbx, the box, collect.ts or
 * render.ts.
 */
export const GATEWAY_ISSUER_KEY_ENV = "LLM_GATEWAY_ISSUER_KEY";

/** The one model secret of a static provider: the key every run sends as is; the runner never writes it anywhere. */
export const MODEL_API_KEY_ENV = "MODEL_API_KEY";

/** The secret the runner's model calls need, by the workspace's key mode. */
export function modelKeyEnv(
  provider: Pick<Provider, "keyMode"> = workspace().provider,
): string {
  return provider.keyMode === "static"
    ? MODEL_API_KEY_ENV
    : GATEWAY_ISSUER_KEY_ENV;
}

/** Both model key names, whichever mode a workspace is in: neither may reach the box. */
export const MODEL_KEY_ENVS: readonly string[] = [
  GATEWAY_ISSUER_KEY_ENV,
  MODEL_API_KEY_ENV,
];

/** The environment prefix the box's Pi provider reads its base URL and key under: <NAME>_BASE_URL, <NAME>_API_KEY. */
export function providerEnvPrefix(
  provider: Pick<Provider, "name"> = workspace().provider,
): string {
  return provider.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/** The gateway a static provider stands for when the workspace keeps no gateway.yml. */
export function staticGateway(
  provider: Provider,
  budgetUsdPerMonth: number,
): Gateway {
  const url = provider.baseUrl ?? "";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  return {
    mode: "static",
    url,
    server_name: host,
    team: "static",
    key_max_usd: budgetUsdPerMonth,
    key_max_minutes: STATIC_KEY_MAX_MINUTES,
  };
}

/**
 * Pi reaches every model through its provider (flax.yml agents.provider.name,
 * an Anthropic Messages API), which talks to the runner's forwarder, and the
 * gateway routes by model name. So Pi's model is <provider>/<gateway model
 * name> whatever serves it.
 */
export function piGatewayProvider(): string {
  return workspace().provider.name;
}

/** The name the gateway knows a model by: its models.yml id without the provider prefix. */
export function gatewayModelName(model: Pick<Model, "id">): string {
  const slash = model.id.indexOf("/");
  return slash === -1 ? model.id : model.id.slice(slash + 1);
}

/** The model Pi is started with: the provider's name for it. */
export function piModel(model: Pick<Model, "id">): string {
  return `${piGatewayProvider()}/${gatewayModelName(model)}`;
}

/** Why a run may not use this model, or undefined when it may. */
export function modelRefusal(model: Model): string | undefined {
  if (model.confirmed === false)
    return `"${model.id}" is marked confirmed: false in models.yml (a placeholder); confirm its id and prices first`;
  return undefined;
}

/** The models a run may use: the confirmed ones. */
export function usableModels(models: readonly Model[]): Model[] {
  return models.filter((m) => modelRefusal(m) === undefined);
}

let validator: ValidateFunction | undefined;

function gatewayValidator(): ValidateFunction {
  validator ??= new Ajv2020({
    allErrors: true,
    strict: true,
    verbose: true,
  }).compile(GATEWAY_SCHEMA);
  return validator;
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----/g;

/**
 * Why this file cannot be the gateway's CA root, or undefined when it can:
 * PEM certificates only (a key or anything else is refused), each a CA
 * certificate valid at `now`.
 */
export function caProblem(text: string, now: Date): string | undefined {
  const blocks = [...text.matchAll(PEM_BLOCK)].map((m) => m[1]!);
  if (blocks.length === 0)
    return "holds no PEM certificate; paste the gateway's CA root (see Model gateway in docs/runtime.md)";
  const other = blocks.find((b) => b !== "CERTIFICATE");
  if (other !== undefined)
    return `holds a PEM "${other}" block; it may hold only the CA root certificate`;
  const pems = text.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  if (pems === null || pems.length !== blocks.length)
    return "holds a certificate block that is not closed";
  for (const pem of pems) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(pem);
    } catch (err) {
      return `holds a certificate that does not parse: ${firstLine(err)}`;
    }
    if (!cert.ca)
      return `holds "${cert.subject.replaceAll("\n", ", ")}", which is not a CA certificate`;
    if (new Date(cert.validTo) <= now)
      return `holds a certificate that expired on ${cert.validTo}`;
    if (new Date(cert.validFrom) > now)
      return `holds a certificate that is not valid before ${cert.validFrom}`;
  }
  return undefined;
}

export interface LoadedGateway {
  /** Set when gateway.yml matches the schema. */
  gateway?: Gateway;
  /** The CA root, set when the file passed caProblem. */
  caPem?: string;
  problems: Problem[];
}

export function loadGateway(
  root: string,
  now: Date = new Date(),
  provider: Provider = workspace().provider,
  budgetUsdPerMonth: number = workspace().budgetUsdPerMonth,
): LoadedGateway {
  const path = join(root, GATEWAY_FILE);
  if (!existsSync(path)) {
    if (provider.keyMode === "static") {
      const gateway = staticGateway(provider, budgetUsdPerMonth);
      return gateway.server_name === ""
        ? {
            problems: [
              problem(
                WORKSPACE_FILE,
                "agents.provider.baseUrl must be an https URL for a static provider",
                "agents.provider.baseUrl",
              ),
            ],
          }
        : { gateway, problems: [] };
    }
    return { problems: [problem(GATEWAY_FILE, "is missing")] };
  }
  let data: unknown;
  try {
    data = parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      problems: [problem(GATEWAY_FILE, `is not valid YAML: ${firstLine(err)}`)],
    };
  }
  const validate = gatewayValidator();
  if (!validate(data)) {
    return {
      problems: describeErrors(validate.errors).map((e) =>
        problem(GATEWAY_FILE, e.message, e.field),
      ),
    };
  }
  const gateway: Gateway = {
    mode: provider.keyMode,
    ...(data as Omit<Gateway, "mode">),
  };
  if (gateway.mode === "static" && provider.baseUrl !== undefined)
    gateway.url = provider.baseUrl;
  const caPath = join(root, gateway.ca!);
  if (!existsSync(caPath) || !lstatSync(caPath).isFile())
    return {
      gateway,
      problems: [
        problem(
          GATEWAY_FILE,
          `names ${gateway.ca}, which is not a file at the repository root`,
          "ca",
        ),
      ],
    };
  const text = readFileSync(caPath, "utf8");
  const reason = caProblem(text, now);
  if (reason !== undefined)
    return { gateway, problems: [problem(gateway.ca!, reason)] };
  return { gateway, caPem: text, problems: [] };
}
