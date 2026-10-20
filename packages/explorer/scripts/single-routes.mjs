// The single-file page uses the hash router, which takes no page options; it renders in the browser all the same.
// So its routes are these routes with the layout's page options left out, in .single-routes/ beside src/.
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const out = new URL("../.single-routes/", import.meta.url);
rmSync(out, { recursive: true, force: true });
cpSync(new URL("../src/routes/", import.meta.url), out, { recursive: true });
const layout = new URL("+layout.ts", out);
const text = readFileSync(layout, "utf8");
const stripped = text.replace(/^export const (ssr|prerender) = [^;]+;\n/gm, "");
if (stripped === text)
  throw new Error("src/routes/+layout.ts sets no page options to leave out");
writeFileSync(layout, stripped);
const view = new URL("+layout.svelte", out);
writeFileSync(
  view,
  readFileSync(view, "utf8").replace(`"../app.css"`, `"../src/app.css"`),
);
