/**
 * Reads and writes tar archives (ustar), as an example of binopsy:
 * strings of a fixed size ending with a zero, numbers converted from octal
 * digits, a length taken from a field, computed fields, and decoding a stream.
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

import {
  bin,
  bytes,
  decodeStream,
  map,
  string,
  type Codec,
  type Input,
} from "../src/index.ts";

/**
 * A number written as octal digits into `length` bytes, followed by `end`.
 *
 * @param length The size of the field in bytes.
 * @param end The characters after the digits.
 * @returns A codec of the number.
 */
function octal(length: number, end = "\0"): Codec<number> {
  return map(bytes(length), {
    // The zero blocks that end an archive hold no digits.
    decode: (digits) => Number.parseInt(String.fromCharCode(...digits), 8) || 0,
    encode: (value: number) =>
      Uint8Array.from(
        value.toString(8).padStart(length - end.length, "0") + end,
        (c) => c.charCodeAt(0),
      ),
  });
}

/**
 * The number of bytes padding `size` bytes to whole blocks of 512 bytes.
 *
 * @param size The size of the data in bytes.
 * @returns The number of bytes, from 0 to 511.
 */
const padding = (size: number): number => (512 - (size % 512)) % 512;

/** A header block (512 bytes), followed by the data, padded to whole blocks. */
export const Entry = bin()
  .field("name", string(100, { terminator: 0 }))
  .field("mode", octal(8))
  .field("uid", octal(8))
  .field("gid", octal(8))
  .field("size", octal(12))
  .field("mtime", octal(12))
  .field("checksum", octal(8, "\0 "))
  .field("type", string(1)) // "0": a file, "5": a directory
  .field("linkname", string(100, { terminator: 0 }))
  .field("magic", string(6, { terminator: 0 }))
  .field("version", string(2))
  .field("uname", string(32, { terminator: 0 }))
  .field("gname", string(32, { terminator: 0 }))
  .field("devmajor", octal(8))
  .field("devminor", octal(8))
  .field("prefix", string(155, { terminator: 0 })) // The directories of `name`, if they do not fit in it
  .field("unused", bytes(12))
  .field("data", bytes("size"))
  .field(
    "padding",
    bytes((entry) => padding(entry.size)),
  )
  .computed({
    size: (entry) => entry.data.length,
    padding: (entry) => new Uint8Array(padding(entry.data.length)),
  });

/**
 * The bytes of an entry; the checksum is the sum of the header's bytes, with
 * its own counted as spaces.
 *
 * @param entry The fields of the entry, without its checksum.
 * @returns The header block, then the data padded to whole blocks.
 */
export function pack(entry: Omit<Input<typeof Entry>, "checksum">): Uint8Array {
  const header = Entry.encode({ ...entry, checksum: 0 }).subarray(0, 512);
  const sum =
    header.reduce((a, b) => a + b, 0) -
    header.subarray(148, 156).reduce((a, b) => a + b, 0) +
    8 * 32;
  return Entry.encode({ ...entry, checksum: sum });
}

function* entries(path: string): Generator<Uint8Array> {
  const stat = statSync(path);
  const directory = stat.isDirectory();
  yield pack({
    name: directory ? `${path}/` : path,
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    gid: stat.gid,
    mtime: Math.floor(stat.mtimeMs / 1000),
    type: directory ? "5" : "0",
    linkname: "",
    magic: "ustar",
    version: "00",
    uname: "",
    gname: "",
    devmajor: 0,
    devminor: 0,
    prefix: "",
    unused: new Uint8Array(12),
    data: directory ? new Uint8Array(0) : readFileSync(path),
  });
  if (directory) {
    for (const name of readdirSync(path)) yield* entries(join(path, name));
  }
}

/**
 * The archive of `paths`.
 *
 * @param paths The files and directories to archive.
 * @yields The entries of `paths`, then the two zero blocks that end an archive.
 */
function* tarball(paths: string[]): Generator<Uint8Array> {
  for (const path of paths) yield* entries(path);
  yield new Uint8Array(1024);
}

const [command, archive, ...paths] = process.argv.slice(2);
if (command === "pack") {
  writeFileSync(archive, Buffer.concat([...tarball(paths)]));
} else if (command === "list") {
  for await (const entry of decodeStream(Entry, createReadStream(archive))) {
    if (entry.name) {
      console.log(
        entry.type,
        entry.size,
        entry.prefix ? `${entry.prefix}/${entry.name}` : entry.name,
      );
    }
  }
} else {
  console.error("usage: node examples/tar.ts pack|list <archive.tar> [paths…]");
  process.exitCode = 1;
}
