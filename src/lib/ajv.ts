import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { cronProblem, isValidCron } from "./cron.ts";
import { JOB_SCHEMA } from "./schemas.ts";

/** An Ajv instance for schemas that jobs write themselves (output.json). */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, verbose: true });
  formats.default(ajv);
  return ajv;
}

let jobValidator: ValidateFunction | undefined;

export function jobSchemaValidator(): ValidateFunction {
  if (jobValidator === undefined) {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      verbose: true,
      discriminator: true,
    });
    ajv.addFormat("cron", isValidCron);
    jobValidator = ajv.compile(JOB_SCHEMA);
  }
  return jobValidator;
}

function fieldPath(instancePath: string, key?: string): string | undefined {
  const parts = instancePath
    .split("/")
    .slice(1)
    .map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (key !== undefined) parts.push(key);
  if (parts.length === 0) return undefined;
  return parts.reduce(
    (path, part) =>
      /^\d+$/.test(part) ? `${path}[${part}]` : path ? `${path}.${part}` : part,
    "",
  );
}

export interface FieldError {
  field?: string;
  message: string;
}

/** Turns Ajv errors into one short message per field. */
export function describeErrors(
  errors: readonly ErrorObject[] | null | undefined,
): FieldError[] {
  const seen = new Set<string>();
  const out: FieldError[] = [];
  for (const e of errors ?? []) {
    // The branch that failed reports its own errors; the if says nothing more.
    if (e.keyword === "if") continue;
    let field = fieldPath(e.instancePath);
    let message: string;
    switch (e.keyword) {
      // The job schema forbids keys only for a job with model: none.
      case "false schema":
        message = "is not taken by a job with model: none";
        break;
      case "maxItems":
        message =
          e.params.limit === 0
            ? "must be empty for a job with model: none"
            : (e.message ?? "is invalid");
        break;
      case "required":
        field = fieldPath(e.instancePath, String(e.params.missingProperty));
        message = "is required";
        break;
      case "additionalProperties":
        field = fieldPath(e.instancePath, String(e.params.additionalProperty));
        message = "is not an allowed key";
        break;
      case "minProperties":
      case "maxProperties":
        message = `must have exactly one of ${Object.keys(
          (e.parentSchema as { properties?: object } | undefined)?.properties ??
            {},
        ).join(", ")}`;
        break;
      case "discriminator": {
        const schema = e.parentSchema as {
          oneOf?: { properties?: { kind?: { const?: string } } }[];
        };
        const kinds = (schema.oneOf ?? [])
          .map((b) => b.properties?.kind?.const)
          .filter(Boolean);
        field = fieldPath(e.instancePath, String(e.params.tag));
        message = `must be one of ${kinds.join(", ")}`;
        break;
      }
      case "const":
        message = `must be ${JSON.stringify(e.params.allowedValue)}`;
        break;
      case "enum":
        message = `must be one of ${(e.params.allowedValues as unknown[]).map(String).join(", ")}`;
        break;
      case "not":
        message = `${JSON.stringify(e.data)} is a placeholder; replace it`;
        break;
      case "format":
        message =
          e.params.format === "cron"
            ? `"${String(e.data)}" is not a valid cron expression: ${cronProblem(String(e.data))}`
            : `must be a valid ${String(e.params.format)}`;
        break;
      case "pattern":
        message = `${JSON.stringify(e.data)} must match ${String(e.params.pattern)}`;
        break;
      default:
        message = e.message ?? "is invalid";
    }
    const key = `${field ?? ""}\0${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(field === undefined ? { message } : { field, message });
  }
  return out;
}
