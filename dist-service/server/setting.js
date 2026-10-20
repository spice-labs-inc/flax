import { readFileSync } from "node:fs";
/** A setting from the environment, or from the file `<name>_FILE` names, as Docker secrets are mounted. */
export function setting(env, k) {
    const file = env[`${k}_FILE`]?.trim();
    return (file ? readFileSync(file, "utf8") : (env[k] ?? "")).trim();
}
//# sourceMappingURL=setting.js.map