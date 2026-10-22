import { workspaceRoot } from "../lib/workspace.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BOX_FILE } from "../lib/paths.ts";
import { releasePinText } from "./pin.ts";
import { execCommand, resolveRelease } from "./release.ts";

const usage = [
  "usage: flax agents box-release resolve --release <vX.Y.Z> [--commit <sha>] [--notes-out <file>]",
  "       flax agents box-release pin --release <vX.Y.Z> --commit <sha> --sha256 <hex> --image <ref> [--run-id <id>]",
].join("\n");

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

const [command, ...rest] = process.argv.slice(2);
let values: Record<string, string | undefined>;
try {
  ({ values } = parseArgs({
    args: rest,
    options: {
      release: { type: "string" },
      commit: { type: "string" },
      "notes-out": { type: "string" },
      image: { type: "string" },
      sha256: { type: "string" },
      "run-id": { type: "string" },
    },
  }));
} catch (err) {
  fail(`${(err as Error).message}\n${usage}`, 2);
}

function required(...names: string[]): string[] {
  const missing = names.filter((n) => !values[n]);
  if (missing.length > 0)
    fail(`missing ${missing.map((n) => `--${n}`).join(", ")}\n${usage}`, 2);
  return names.map((n) => values[n]!);
}

if (command === "resolve") {
  const [tag] = required("release");
  const result = await resolveRelease({
    tag: tag!,
    ...(values["commit"] === undefined ? {} : { checkoutCommit: values["commit"] }),
    exec: execCommand,
  });
  if (!result.ok) fail(`sandbox (lbx) release ${tag}: ${result.error}`);
  if (values["notes-out"] !== undefined) writeFileSync(values["notes-out"], result.value.notes);
  process.stdout.write(`commit=${result.value.commit}\nbinary=${result.value.binary}\nsha256=${result.value.sha256}\n`);
} else if (command === "pin") {
  const [tag, commit, sha256, image] = required("release", "commit", "sha256", "image");
  const result = await releasePinText(
    {
      box_release: tag!,
      box_commit: commit!,
      lbx_sha256: sha256!,
      image: image!,
    },
    values["run-id"],
  );
  if (!result.ok) fail(`refusing to write ${BOX_FILE}: ${result.error}`);
  writeFileSync(join(workspaceRoot(), BOX_FILE), result.value);
  console.log(`wrote ${BOX_FILE} for sandbox (lbx) release ${tag}`);
} else {
  fail(usage, 2);
}
