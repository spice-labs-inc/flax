import type { Problem } from "../lib/problem.ts";
import type { Repo } from "../lib/repo.ts";

export interface Check {
  id: string;
  title: string;
  run(repo: Repo): Problem[] | Promise<Problem[]>;
}
