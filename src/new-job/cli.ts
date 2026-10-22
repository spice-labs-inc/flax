import { workspaceRoot } from "../lib/workspace.ts";
import { parseArgs } from "node:util";
import { OWNER_PLACEHOLDER, scaffoldJob } from "./scaffold.ts";
import { listTemplates } from "./template.ts";

const usage = [
  "usage: flax agents new-job <name> [--owner <github-handle>] [--template <template> [--set field=value ...]]",
  "       flax agents new-job --templates",
].join("\n");
let name: string | undefined;
let owner: string | undefined;
let template: string | undefined;
const set: Record<string, string> = {};
try {
  const { values, positionals } = parseArgs({
    options: {
      owner: { type: "string" },
      template: { type: "string" },
      set: { type: "string", multiple: true },
      templates: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.templates) {
    for (const t of listTemplates()) {
      console.log(`${t.name}: ${t.description}`);
      for (const [field, spec] of Object.entries(t.fields))
        console.log(
          `  --set ${field}=<${spec.example ?? "value"}>  ${spec.description}`,
        );
      for (const note of t.notes) console.log(`  note: ${note}`);
    }
    process.exit(0);
  }
  if (positionals.length !== 1) throw new Error(usage);
  name = positionals[0];
  owner = values.owner;
  template = values.template;
  for (const pair of values.set ?? []) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new Error(`--set takes field=value, not "${pair}"`);
    set[pair.slice(0, at)] = pair.slice(at + 1);
  }
  if (Object.keys(set).length > 0 && template === undefined)
    throw new Error("--set goes with --template");
} catch (err) {
  console.error(
    (err as Error).message === usage
      ? usage
      : `${(err as Error).message}\n${usage}`,
  );
  process.exit(2);
}

try {
  const files = scaffoldJob(workspaceRoot(), name!, {
    ...(owner === undefined ? {} : { owner }),
    ...(template === undefined ? {} : { template, set }),
  });
  for (const file of files) console.log(`created ${file}`);
  console.log("");
  if (owner === undefined)
    console.log(
      `Set owner in jobs/${name}/job.yml (it is ${OWNER_PLACEHOLDER}).`,
    );
  console.log(
    `Edit the job, then run flax agents generate and flax agents check.`,
  );
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
