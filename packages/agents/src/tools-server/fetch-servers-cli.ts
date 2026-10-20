import { workspaceRoot } from "../lib/workspace.ts";
import { resolve } from "node:path";
import { firstLine } from "../lib/problem.ts";
import { fetchServers } from "./fetch-servers.ts";

const dir = process.argv[2];
if (dir === undefined) {
  console.error("usage: flax agents fetch-servers <directory>");
  process.exit(2);
}
try {
  const paths = await fetchServers({ root: workspaceRoot(), dir: resolve(dir) });
  for (const [name, path] of Object.entries(paths))
    console.log(`${name}: ${path}`);
} catch (err) {
  console.error(`fetch-servers: ${firstLine(err)}`);
  process.exit(1);
}
