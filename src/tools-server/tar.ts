/** One regular file of a tar archive, its data only when it was wanted. */
export interface TarFile {
  /** The path inside the archive, without GitHub's top directory. */
  path: string;
  size: number;
  data: Buffer | undefined;
}

export interface TarLimits {
  /** The most bytes the archive may unpack to. */
  maxBytes: number;
  /** The most entries it may hold. */
  maxEntries: number;
}

const BLOCK = 512;

/** Reads exact byte counts from a stream of chunks, counting what it read. */
class ByteReader {
  private chunks: Buffer[] = [];
  private have = 0;
  private done = false;
  total = 0;
  private readonly it: AsyncIterator<Buffer>;
  private readonly maxBytes: number;

  constructor(source: AsyncIterable<Buffer>, maxBytes: number) {
    this.it = source[Symbol.asyncIterator]();
    this.maxBytes = maxBytes;
  }

  private async fill(n: number): Promise<boolean> {
    while (this.have < n && !this.done) {
      const next = await this.it.next();
      if (next.done === true) this.done = true;
      else {
        const chunk = Buffer.from(next.value);
        this.total += chunk.length;
        if (this.total > this.maxBytes)
          throw new Error(
            `the archive unpacks to more than ${this.maxBytes} bytes`,
          );
        this.chunks.push(chunk);
        this.have += chunk.length;
      }
    }
    return this.have >= n;
  }

  async take(n: number): Promise<Buffer | undefined> {
    if (!(await this.fill(n))) return undefined;
    const all =
      this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const rest = all.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.have = rest.length;
    return all.subarray(0, n);
  }

  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.have === 0 && !(await this.fill(1)))
        throw new Error("the archive ends inside an entry");
      const first = this.chunks[0]!;
      if (first.length <= left) {
        this.chunks.shift();
        this.have -= first.length;
        left -= first.length;
      } else {
        this.chunks[0] = first.subarray(left);
        this.have -= left;
        left = 0;
      }
    }
  }
}

function text(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function number(block: Buffer, start: number, length: number): number {
  const field = block.subarray(start, start + length);
  if ((field[0]! & 0x80) !== 0) {
    // Base-256, for sizes past the octal field's 8 GiB.
    let n = field[0]! & 0x7f;
    for (const byte of field.subarray(1)) n = n * 256 + byte;
    return n;
  }
  const digits = text(block, start, length).trim();
  if (digits === "") return 0;
  if (!/^[0-7]+$/.test(digits)) throw new Error("the archive is not tar");
  return parseInt(digits, 8);
}

/** The records of a pax extended header: "<length> <key>=<value>\n". */
function paxRecords(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(data.subarray(at, space).toString("ascii"));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    at += length;
  }
  return out;
}

function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/**
 * The regular files of a tar archive, as git archive writes them (ustar
 * with pax headers), read as a stream. A file's data is read only when
 * want(path, size) says so; others are skipped. GitHub's archives put
 * everything under one top directory, which the paths leave out.
 */
export async function* tarFiles(
  source: AsyncIterable<Buffer>,
  want: (path: string, size: number) => boolean,
  limits: TarLimits,
): AsyncGenerator<TarFile> {
  const reader = new ByteReader(source, limits.maxBytes);
  let entries = 0;
  let pax = new Map<string, string>();
  let longName: string | undefined;
  for (;;) {
    const header = await reader.take(BLOCK);
    if (header === undefined || header.every((b) => b === 0)) return;
    if (++entries > limits.maxEntries)
      throw new Error(
        `the archive holds more than ${limits.maxEntries} entries`,
      );
    if (!text(header, 257, 6).startsWith("ustar"))
      throw new Error("the archive is not tar");
    const type = String.fromCharCode(header[156]!);
    let size = number(header, 124, 12);
    if (type === "x" || type === "g" || type === "L") {
      const data = await reader.take(size);
      if (data === undefined)
        throw new Error("the archive ends inside an entry");
      await reader.skip(padding(size));
      if (type === "x") pax = paxRecords(data);
      if (type === "L") longName = text(data, 0, data.length);
      continue;
    }
    const prefix = text(header, 345, 155);
    const name = text(header, 0, 100);
    const full =
      pax.get("path") ??
      longName ??
      (prefix === "" ? name : `${prefix}/${name}`);
    const paxSize = Number(pax.get("size"));
    if (pax.has("size") && Number.isInteger(paxSize)) size = paxSize;
    pax = new Map();
    longName = undefined;
    const slash = full.indexOf("/");
    const path = slash === -1 ? "" : full.slice(slash + 1);
    const regular = type === "0" || type === "\0" || type === "7";
    if (!regular || path === "") {
      await reader.skip(size + padding(size));
      continue;
    }
    if (want(path, size)) {
      const data = await reader.take(size);
      if (data === undefined)
        throw new Error("the archive ends inside an entry");
      await reader.skip(padding(size));
      yield { path, size, data: Buffer.from(data) };
    } else {
      await reader.skip(size + padding(size));
      yield { path, size, data: undefined };
    }
  }
}
