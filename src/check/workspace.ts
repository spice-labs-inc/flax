import type { Check } from "./types.ts";

/** flax.yml is well formed: shared keys, known agents keys, a repo under the GitHub owner, a usable provider. */
export const workspaceCheck: Check = {
  id: "workspace",
  title: "flax.yml is well formed",
  run: (repo) => repo.workspaceProblems,
};
