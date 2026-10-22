import type { Check } from "./types.ts";

/** Every job.yml matches schema/job.schema.json and names its own folder. */
export const jobSchemaCheck: Check = {
  id: "job-schema",
  title: "job.yml matches the schema",
  run: (repo) => repo.jobs.flatMap((job) => job.problems),
};
