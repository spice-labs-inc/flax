/** A tar writer for tests, as git archive writes them: ustar with a pax global header, pax headers for long paths, everything under one top directory. */

function header(name: string, size: number, type: string, prefix = "") {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

function pad(data: Buffer) {
  return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function paxData(records: Record<string, string>) {
  let out = "";
  for (const [k, v] of Object.entries(records)) {
    const body = ` ${k}=${v}\n`;
    let len = body.length + 1;
    while (`${len}${body}`.length !== len) len += 1;
    out += `${len}${body}`;
  }
  return Buffer.from(out);
}

export type TarEntry =
  { path: string; data: string | Buffer } | { dir: string } | { link: string };

export function tarArchive(
  entries: TarEntry[],
  top = "notes-co-engine-ccccccc",
): Buffer {
  const parts: Buffer[] = [];
  const g = paxData({ comment: "c".repeat(40) });
  parts.push(header("pax_global_header", g.length, "g"), pad(g));
  parts.push(header(`${top}/`, 0, "5"));
  for (const e of entries) {
    if ("dir" in e) parts.push(header(`${top}/${e.dir}/`, 0, "5"));
    else if ("link" in e) parts.push(header(`${top}/${e.link}`, 0, "2"));
    else {
      const data = Buffer.from(e.data);
      const full = `${top}/${e.path}`;
      if (Buffer.byteLength(full) > 100) {
        const x = paxData({ path: full });
        parts.push(header("PaxHeader", x.length, "x"), pad(x));
        parts.push(header(full.slice(0, 99), data.length, "0"));
      } else parts.push(header(full, data.length, "0"));
      parts.push(pad(data));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
