import type { Check } from "./types.ts";

/** box.yml is well formed; a box that is not pinned yet is only a warning. */
export const boxCheck: Check = {
  id: "box",
  title: "box.yml pins the box every job runs in",
  run: (repo) => repo.boxProblems,
};
