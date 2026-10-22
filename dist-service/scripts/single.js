import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_FILES } from "@flax/contract";
import { inlineShots } from "./build.js";
/**
 * The single-file page: the hash-router build with every data file inside it, as dist/index.html, and the same page
 * as a fragment (title, head tags, body) for publishing as an Artifact, as dist/artifact.html.
 */
export function writeSingleFile(options) {
    const html = readFileSync(options.built, "utf8");
    const files = DATA_FILES.map((name) => `${JSON.stringify(name)}:${name === "shots.json"
        ? JSON.stringify(inlineShots(options.dataDir))
        : readFileSync(join(options.dataDir, name), "utf8").trim()}`).join(",");
    // Inside a script element only "</script" could end it early; JSON never needs a raw "<".
    const json = `{"manifest":${JSON.stringify({ version: "single", builtAt: options.builtAt })},"files":{${files}}}`.replaceAll("<", "\\u003c");
    if (!html.includes("<head>"))
        throw new Error(`${options.built} has no head`);
    const page = html.replace("<head>", `<head>\n<script type="application/json" id="explorer-data">${json}</script>`);
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(join(options.outDir, "index.html"), page);
    const head = /<head>([\s\S]*?)<\/head>/.exec(page)?.[1];
    const body = /<body[^>]*>([\s\S]*?)<\/body>/.exec(page)?.[1];
    const title = head && /<title>[\s\S]*?<\/title>/.exec(head)?.[0];
    if (head === undefined || body === undefined || !title)
        throw new Error("the single-file page has no head, body or title");
    const rest = head
        .replace(title, "")
        .replace(/<meta\s+charset[^>]*>/i, "")
        .replace(/<meta\s+name="viewport"[^>]*>/i, "");
    const fragment = `${title}\n${rest.trim()}\n${body.trim()}\n`;
    writeFileSync(join(options.outDir, "artifact.html"), fragment);
    return { page: page.length, fragment: fragment.length };
}
//# sourceMappingURL=single.js.map