import { readFileSync } from "node:fs";

/** A setting from the environment, or from the file `<name>_FILE` names, as Docker secrets are mounted. */
export function setting(env: NodeJS.ProcessEnv, k: string): string {
  const file = env[`${k}_FILE`]?.trim();
  return (file ? readFileSync(file, "utf8") : (env[k] ?? "")).trim();
}
