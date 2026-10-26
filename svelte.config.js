import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// EXPLORER_SINGLE_FILE=1: one self-contained page with its data inside, for the Artifact; paths ride after a #.
const single = process.env.EXPLORER_SINGLE_FILE === "1";
// Where the built page goes: `flax explorer build` names the workspace's explorer-site directory.
const out = process.env.EXPLORER_SITE_DIR ?? (single ? ".single" : "build");

/** @type {import("@sveltejs/kit").Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: out,
      assets: out,
      fallback: "index.html",
      strict: true,
    }),
    router: { type: single ? "hash" : "pathname" },
    output: { bundleStrategy: single ? "inline" : "split" },
    files: {
      appTemplate: "src/app.html",
      routes: single ? ".single-routes" : "src/routes",
    },
  },
};
