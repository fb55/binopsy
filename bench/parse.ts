/**
 * Decoding benchmark: a record format shaped like a typical game database
 * record (header fields, strings, counted arrays of structs, optional parts,
 * nested parsers), encoded with binopsy itself and decoded back.
 *
 *   NODE_OPTIONS=--max-old-space-size=1536 node bench/parse.ts [records]
 */
import {
  array,
  bin,
  bytes,
  decodeStream,
  f32le,
  match,
  Reader,
  string,
  u16le,
  u32le,
  u8,
  type Input,
} from "../src/index.ts";

const Str = string(u32le);
const Ref = bin().u32le("row").u32le("uid");
const Item = bin().u8("kind").u16le("a").u32le("b").i8("c").field("d", f32le);

const Record = bin()
  .u32le("rowId")
  .u8("cls")
  .field("ratings", array(u16le, 5))
  .field("club", Ref)
  .field("attributes", array(u8, 69))
  .field("name", Str)
  .field("fullName", Str)
  .field("items", array(Item, u8))
  .u8("hasExtra")
  .field(
    "extra",
    match("hasExtra")
      .case(0, bin())
      .case(1, bin().u32le("x").field("y", bytes(12))),
  )
  .field("history", array(u8, u32le))
  .f64le("value")
  .u32le("uniqueId");

function makeRecord(i: number): Input<typeof Record> {
  const hasExtra = i % 3 === 0;
  return {
    rowId: i,
    cls: 2,
    ratings: [1, 2, 3, 4, 5],
    club: { row: i % 1000, uid: i * 13 },
    attributes: Array.from({ length: 69 }, (_, k) => (i + k) % 21),
    name: `Player ${i}`,
    fullName: `Some Fairly Long Full Name ${i}`,
    items: Array.from({ length: i % 7 }, (_, k) => ({
      kind: k,
      a: i & 0xffff,
      b: i * 7,
      c: -3,
      d: 1.5,
    })),
    ...(hasExtra
      ? { hasExtra: 1, extra: { x: i, y: new Uint8Array(12).fill(1) } }
      : { hasExtra: 0, extra: {} }),
    history: Array.from({ length: i % 5 }, (_, k) => k),
    value: i * 1.25,
    uniqueId: i * 31,
  };
}

const n = Number(process.argv[2] ?? 50_000);
const values = Array.from({ length: n }, (_, i) => makeRecord(i));
const parts = values.map((value) => Record.encode(value));
const data = new Uint8Array(
  parts.reduce((size, part) => size + part.length, 0),
);
for (let i = 0, o = 0; i < n; o += parts[i++].length) data.set(parts[i], o);

console.log(`${n} records, ${(data.length / 1e6).toFixed(1)} MB`);

/**
 * Logs the median time of 10 runs (after 3 to warm up).
 *
 * @param label The name of what is measured.
 * @param fn The code to time (its result is awaited).
 */
async function run(label: string, fn: () => unknown): Promise<void> {
  const times: number[] = [];
  for (let i = 0; i < 13; i++) {
    const start = performance.now();
    await fn();
    if (i >= 3) times.push(performance.now() - start);
  }
  const ms = times.toSorted((a, b) => a - b)[5];
  console.log(
    `${label.padEnd(28)} ${ms.toFixed(0).padStart(6)} ms  ${(((n / ms) * 1e3) / 1e6).toFixed(2)} M records/s  ${(((data.length / ms) * 1e3) / 1e6).toFixed(0)} MB/s`,
  );
}

function readAll(codec: Parameters<Reader["read"]>[0]): void {
  const reader = new Reader(data);
  let count = 0;
  while (!reader.done) {
    reader.read(codec);
    count++;
  }
  if (count !== n) throw new Error("bad record count");
}

/**
 * The data in chunks.
 *
 * @yields Chunks of 64 KiB.
 */
function* chunks(): Generator<Uint8Array> {
  for (let i = 0; i < data.length; i += 65_536) {
    yield data.subarray(i, i + 65_536);
  }
}

async function streamAll(): Promise<void> {
  let count = 0;
  for await (const _ of decodeStream(Record, chunks())) count++;
  if (count !== n) throw new Error("bad record count");
}

const TwoFields = Record.pick("name", "uniqueId");
const Skip = Record.pick();

await run("stream (64 KiB chunks)", streamAll);
await run("decode", () => readAll(Record));
// (New views, as of bytes received one after the other.)
await run("decode (each from its bytes)", () => {
  for (const { buffer, byteOffset, length } of parts) {
    Record.decode(new Uint8Array(buffer, byteOffset, length));
  }
});
await run("decode (2 fields)", () => readAll(TwoFields));
await run("decode (skip)", () => readAll(Skip));
await run("encode", () => {
  for (const value of values) Record.encode(value);
});
