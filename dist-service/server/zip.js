import { inflateRawSync } from "node:zlib";
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/**
 * The named files of a zip archive (a workflow artifact), by name. Only stored and deflated entries
 * of the archive's top level are read; anything else, folders and paths with a slash included, is left out.
 */
export function unzip(zip, wanted, maxBytes) {
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--)
        if (zip.readUInt32LE(i) === EOCD) {
            eocd = i;
            break;
        }
    if (eocd < 0)
        throw new Error("not a zip archive");
    const count = zip.readUInt16LE(eocd + 10);
    let at = zip.readUInt32LE(eocd + 16);
    const out = new Map();
    for (let n = 0; n < count; n++) {
        if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL)
            throw new Error("the zip archive's directory is damaged");
        const method = zip.readUInt16LE(at + 10);
        const compressed = zip.readUInt32LE(at + 20);
        const size = zip.readUInt32LE(at + 24);
        const nameLen = zip.readUInt16LE(at + 28);
        const extraLen = zip.readUInt16LE(at + 30);
        const commentLen = zip.readUInt16LE(at + 32);
        const local = zip.readUInt32LE(at + 42);
        const name = zip.toString("utf8", at + 46, at + 46 + nameLen);
        at += 46 + nameLen + extraLen + commentLen;
        if (!wanted.has(name))
            continue;
        if (size > maxBytes)
            throw new Error(`${name} in the zip archive is over ${maxBytes} bytes`);
        if (local + 30 > zip.length || zip.readUInt32LE(local) !== LOCAL)
            throw new Error(`${name} in the zip archive is damaged`);
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const raw = zip.subarray(start, start + compressed);
        const body = method === 0
            ? Buffer.from(raw)
            : method === 8
                ? inflateRawSync(raw, { maxOutputLength: maxBytes })
                : undefined;
        if (!body)
            throw new Error(`${name} uses a zip method this cannot read`);
        if (body.length !== size)
            throw new Error(`${name} in the zip archive has the wrong size`);
        out.set(name, body);
    }
    return out;
}
//# sourceMappingURL=zip.js.map