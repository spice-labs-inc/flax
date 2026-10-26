// A module loader that lets Node run a workspace's TypeScript step files without a transpiler on the
// path: each `.ts` file is type-stripped with Node's own stripTypeScriptTypes (erasable syntax only:
// no enums, namespaces or parameter properties; imports name their `.ts` extension). The runner
// registers it in the main thread and in every worker of a parallel run through cucumber's loaders.
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !/\.[mc]?ts(\?.*)?$/.test(url)) {
    return nextLoad(url, context);
  }
  const source = await readFile(fileURLToPath(url), "utf8");
  return {
    format: url.endsWith(".cts") ? "commonjs" : "module",
    shortCircuit: true,
    source: stripTypeScriptTypes(source, { mode: "strip" }),
  };
}
