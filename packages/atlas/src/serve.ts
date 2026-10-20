// `flax atlas serve`: a local preview server for the built page.
//
//   --workspace <dir>   the directory holding flax.yml (default: the current directory)
//   --port N            default 8099

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAtlas } from "./config.ts";

export async function main(argv: string[]): Promise<void> {
  const w = argv.indexOf("--workspace");
  const p = argv.indexOf("--port");
  const { vizRoot } = loadAtlas(
    resolve(w === -1 ? process.cwd() : argv[w + 1]),
  );
  const file = join(vizRoot, "dist", "atlas-3d.html");
  const port = Number(p === -1 ? (process.env.PORT ?? 8099) : argv[p + 1]);

  createServer((req, res) => {
    try {
      const html = readFileSync(file);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(html);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`${file} not found; run: flax atlas build`);
    }
  }).listen(port, () => console.log(`atlas 3d: http://localhost:${port}/`));
}
