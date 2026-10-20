import { join } from "node:path";
import { KIT_ROOT } from "../src/lib/paths.ts";
import { setWorkspaceRoot } from "../src/lib/workspace.ts";

// Every kit test resolves workspace.yml and the root YAMLs against the fixture workspace.
setWorkspaceRoot(join(KIT_ROOT, "test/fixtures/workspace"));
