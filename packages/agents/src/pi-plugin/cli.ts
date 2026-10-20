import { KIT_ROOT } from "../lib/paths.ts";
import { resolve } from "node:path";
import { firstLine } from "../lib/problem.ts";
import { bundlePiPlugin } from "./bundle.ts";

const out = process.argv[2];
if (out === undefined) {
  console.error("usage: flax agents bundle-pi-plugin <output file>");
  process.exit(2);
}
try {
  const bundle = await bundlePiPlugin(KIT_ROOT, resolve(out));
  console.log(
    `${bundle.path}: pi-mcp-mailbox ${bundle.version}, ${bundle.bytes} bytes, sha256 ${bundle.sha256}`,
  );
} catch (err) {
  console.error(`bundle-pi-plugin: ${firstLine(err)}`);
  process.exit(1);
}
