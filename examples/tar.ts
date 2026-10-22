/**
 * Reads and writes tar archives (ustar), as an example of binopsy: fixed-size
 * strings, octal numbers through formatters, a length taken from a field, a
 * computed field (the padding), serializing and streaming.
 *
 *   node examples/tar.ts pack <archive.tar> <paths…>
 *   node examples/tar.ts list <archive.tar>
 */
import {
  createReadStream,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Bin, type ValueOf } from "../src/index.ts";

/** A number written as octal digits into `length` bytes. */
function octal(length: number) {
  return {
    length,
    encoding: "ascii",
    // Fields of the zero blocks that end an archive hold no digits.
    formatter: (digits: string) => Number.parseInt(digits, 8) || 0,
    deformatter: (value: number) =>
      `${value.toString(8).padStart(length - 1, "0")}\0`,
  } as const;
}

const text = (length: number) => ({ length, stripNull: true }) as const;

/** A header block (512 bytes), followed by the data padded to whole blocks. */
export const Entry = Bin.start()
  .string("name", text(100))
  .string("mode", octal(8))
  .string("uid", octal(8))
  .string("gid", octal(8))
  .string("size", octal(12))
  .string("mtime", octal(12))
  .string("checksum", text(8))
  .string("type", text(1)) // "0": file, "5": directory
  .string("linkname", text(100))
  .string("magic", text(6))
  .string("version", text(2))
  .string("uname", text(32))
  .string("gname", text(32))
  .string("devmajor", octal(8))
  .string("devminor", octal(8))
  .string("prefix", text(155)) // Directories of `name`, if they did not fit
  .buffer("unused", { length: 12 })
  .buffer("data", { length: "size" })
  .buffer("padding", {
    length: (entry) => (512 - (entry.size % 512)) % 512,
    deformatter: (_padding, entry) =>
      Buffer.alloc((512 - (entry.size % 512)) % 512),
  });

export type TarEntry = ValueOf<typeof Entry>;

/** The bytes of an entry; the checksum is the sum of the header's bytes, counting itself as spaces. */
export function pack(entry: Omit<TarEntry, "checksum">): Buffer {
  const blank = Entry.serialize({ ...entry, checksum: " ".repeat(8) });
  const sum = blank.subarray(0, 512).reduce((a, b) => a + b, 0);
  const checksum = `${sum.toString(8).padStart(6, "0")}\0 `;
  return Entry.serialize({ ...entry, checksum });
}

function* entries(path: string): Generator<Buffer> {
  const stat = statSync(path);
  const directory = stat.isDirectory();
  const data = directory ? Buffer.alloc(0) : readFileSync(path);
  yield pack({
    name: directory ? `${path}/` : path,
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    gid: stat.gid,
    size: data.length,
    mtime: Math.floor(stat.mtimeMs / 1000),
    type: directory ? "5" : "0",
    linkname: "",
    magic: "ustar\0",
    version: "00",
    uname: "",
    gname: "",
    devmajor: 0,
    devminor: 0,
    prefix: "",
    unused: Buffer.alloc(12),
    data,
    padding: Buffer.alloc(0), // Computed by its deformatter
  });
  if (directory) {
    for (const name of readdirSync(path)) yield* entries(join(path, name));
  }
}

const [command, archive, ...paths] = process.argv.slice(2);
if (command === "pack") {
  const blocks = paths.flatMap((path) => [...entries(path)]);
  // Two zero blocks end the archive.
  writeFileSync(archive, Buffer.concat([...blocks, Buffer.alloc(1024)]));
} else if (command === "list") {
  createReadStream(archive)
    .pipe(Entry.stream())
    .on("data", (entry: TarEntry) => {
      if (!entry.name) return;
      const path = entry.prefix ? `${entry.prefix}/${entry.name}` : entry.name;
      console.log(entry.type, entry.size, path);
    });
} else {
  console.error("usage: node examples/tar.ts pack|list <archive.tar> [paths…]");
  process.exitCode = 1;
}
