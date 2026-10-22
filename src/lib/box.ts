import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { describeErrors } from "./ajv.ts";
import { BOX_FILE, BOX_SCHEMA_PATH } from "./paths.ts";
import {
  firstLine,
  isError,
  problem,
  warning,
  type Problem,
} from "./problem.ts";

/** A box.yml that has passed schema/box.schema.json. */
export interface Box {
  pinned: boolean;
  /** The sandbox (lbx) release tag, vX.Y.Z. */
  box_release: string;
  /** The commit that tag names, from the release notes block. */
  box_commit: string;
  /** The sha256 of the release's launcher binary (LBX_BINARY), which the action checks before running it. */
  lbx_sha256: string;
  /** The agent image, by digest. */
  image: string;
}

/** The launcher asset every sandbox (lbx) release attaches, beside its .sha256 file. */
export const LBX_BINARY = "lbx-x86_64-unknown-linux-musl";

/** A sandbox (lbx) release tag, as its release workflow accepts it. */
export const BOX_RELEASE_PATTERN =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export const UNPINNED_MESSAGE =
  "is false, so job runs are refused; run the Publish image workflow with a sandbox (lbx) release, then flax agents box-release pin with the values it prints";

let validator: ValidateFunction | undefined;

function boxValidator(): ValidateFunction {
  validator ??= new Ajv2020({
    allErrors: true,
    strict: true,
    verbose: true,
  }).compile(JSON.parse(readFileSync(BOX_SCHEMA_PATH, "utf8")));
  return validator;
}

const PLACEHOLDER = /^0+$/;

/** The part of a pinned value that is all zeros until the first publish. */
function placeholderPart(key: keyof Box, value: string): string {
  if (key === "box_commit" || key === "lbx_sha256") return value;
  if (key === "box_release") return value.replace(/[v.]/g, "");
  return value.split("@sha256:")[1] ?? "";
}

export interface LoadedBox {
  /** Set when box.yml matches the schema, pinned or not. */
  box?: Box;
  /** Errors, plus a warning while the box is not pinned yet. */
  problems: Problem[];
}

export function loadBox(root: string): LoadedBox {
  const path = join(root, BOX_FILE);
  if (!existsSync(path)) return { problems: [problem(BOX_FILE, "is missing")] };
  let data: unknown;
  try {
    data = parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      problems: [problem(BOX_FILE, `is not valid YAML: ${firstLine(err)}`)],
    };
  }
  return checkBox(data);
}

/** The checks loadBox makes on box.yml once it is parsed. */
export function checkBox(data: unknown): LoadedBox {
  const validate = boxValidator();
  if (!validate(data)) {
    return {
      problems: describeErrors(validate.errors).map((e) =>
        problem(BOX_FILE, e.message, e.field),
      ),
    };
  }
  const box = data as Box;
  if (!box.pinned)
    return { box, problems: [warning(BOX_FILE, UNPINNED_MESSAGE, "pinned")] };
  const problems: Problem[] = [];
  for (const key of ["box_release", "box_commit", "lbx_sha256", "image"] as const) {
    if (PLACEHOLDER.test(placeholderPart(key, box[key]))) {
      problems.push(
        problem(
          BOX_FILE,
          "is still the all-zeros placeholder; paste the published value or set pinned: false",
          key,
        ),
      );
    }
  }
  return problems.some(isError) ? { problems } : { box, problems };
}
