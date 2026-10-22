import { writeFileSync } from "node:fs";
import { join } from "node:path";

// lbx ignores a value outside this set with only a warning and falls back to
// its default image, so a bad value must stop the run here instead.
const CONFIG_VALUE = /^[A-Za-z0-9._:/@+][A-Za-z0-9._:/@+-]*$/;

/** The lbx configuration file: the run box image, nothing else. */
export function lbxConfig(image: string): string {
  if (!CONFIG_VALUE.test(image))
    throw new Error(`"${image}" is not a value lbx accepts for image.docker`);
  return `image.docker=${image}\n`;
}

/** lbx refuses a configuration file that is a link, not ours, or writable by others. */
export function writeLbxConfig(dir: string, image: string): string {
  const path = join(dir, "config");
  writeFileSync(path, lbxConfig(image), { mode: 0o600 });
  return path;
}
