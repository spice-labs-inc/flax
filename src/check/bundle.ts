import { manifestProblems } from "../bundle/manifest.ts";
import { BUNDLE_ROOT } from "../lib/bundled.ts";
import type { Check } from "./types.ts";

/**
 * In the bundled runner, the committed bundles match the tree it runs in
 * (dist/manifest.json). From source, flax agents check only builds the bundles
 * (src/check/cli.ts), and runs from source do not use them.
 */
export const bundleManifestCheck: Check = {
  id: "bundle-manifest",
  title: "the runner bundles match the tree",
  run(repo) {
    return BUNDLE_ROOT === undefined ? [] : manifestProblems(repo.root);
  },
};
