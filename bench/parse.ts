/**
 * Parsing benchmark: a record format shaped like a typical game database
 * record (header fields, strings, counted arrays of structs, optional parts,
 * nested parsers), serialized with binopsy itself and parsed back.
 *
 *   node bench/parse.ts [records]
 */
import { Bin, type ValueOf } from "../src/index.ts";

const Str = Bin.start()
  .uint32le("length")
  .string("value", { length: "length" });
const STRING = {
  type: Str,
  formatter: (s: { value: string }) => s.value,
  deformatter: (value: string) => ({ length: Buffer.byteLength(value), value }),
};
const Ref = Bin.start().uint32le("row").uint32le("uid");
const Item = Bin.start()
  .uint8("kind")
  .uint16le("a")
  .uint32le("b")
  .int8("c")
  .floatle("d");

const Record = Bin.start()
  .uint32le("rowId")
  .uint8("cls")
  .array("ratings", { type: "uint16le", length: 5 })
  .nest("club", { type: Ref })
  .array("attributes", { type: "uint8", length: 69 })
  .nest("name", STRING)
  .nest("fullName", STRING)
  .uint8("itemCount")
  .array("items", { type: Item, length: "itemCount" })
  .uint8("hasExtra")
  .choice("extra", {
    tag: "hasExtra",
    choices: {
      0: Bin.start(),
      1: Bin.start().uint32le("x").buffer("y", { length: 12 }),
    },
  })
  .uint32le("historyCount")
  .array("history", { type: "uint8", length: "historyCount" })
  .doublele("value")
  .uint32le("uniqueId");

type Rec = ValueOf<typeof Record>;

function makeRecord(i: number): Rec {
  const items = Array.from({ length: i % 7 }, (_, k) => ({
    kind: k,
    a: i & 0xffff,
    b: i * 7,
    c: -3,
    d: 1.5,
  }));
  const hasExtra = i % 3 === 0 ? 1 : 0;
  return {
    rowId: i,
    cls: 2,
    ratings: [1, 2, 3, 4, 5],
    club: { row: i % 1000, uid: i * 13 },
    attributes: Array.from({ length: 69 }, (_, k) => (i + k) % 21),
    name: `Player ${i}`,
    fullName: `Some Fairly Long Full Name ${i}`,
    itemCount: items.length,
    items,
    hasExtra,
    extra: hasExtra ? { x: i, y: Buffer.alloc(12, 1) } : {},
    historyCount: i % 5,
    history: Array.from({ length: i % 5 }, (_, k) => k),
    value: i * 1.25,
    uniqueId: i * 31,
  } as unknown as Rec;
}

const n = Number(process.argv[2] ?? 200_000);
const parts: Buffer[] = [];
for (let i = 0; i < n; i++) parts.push(Record.serialize(makeRecord(i)));
const data = Buffer.concat(parts);

async function run(label: string, fn: () => unknown) {
  await fn(); // Warm up
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  console.log(
    `${label.padEnd(28)} ${ms.toFixed(0).padStart(6)} ms  ${(((n / ms) * 1000) / 1e6).toFixed(2)} M records/s  ${(((data.length / ms) * 1000) / 1e6).toFixed(0)} MB/s`,
  );
}

console.log(`${n} records, ${(data.length / 1e6).toFixed(1)} MB`);

function parseAll(fields?: readonly (keyof Rec & string)[]) {
  let count = 0;
  for (let o = 0; o < data.length; count++) {
    o = fields
      ? Record.parseFrom(data, o, { fields }).offset
      : Record.parseFrom(data, o).offset;
  }
  if (count !== n) throw new Error("bad record count");
}

/** Parses `data` with the stream reader, in 64 KiB chunks. */
function streamAll(): Promise<void> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const stream = Record.stream()
      .on("data", () => count++)
      .on("error", reject)
      .on("end", () => {
        if (count === n) resolve();
        else reject(new Error("bad record count"));
      });
    for (let i = 0; i < data.length; i += 65536) {
      stream.write(data.subarray(i, i + 65536));
    }
    stream.end();
  });
}

await run("stream (64 KiB chunks)", streamAll);
await run("parseFrom", () => parseAll());
await run("parseFrom (2 fields)", () => parseAll(["name", "uniqueId"]));
await run("parseFrom (skip)", () => parseAll([]));
