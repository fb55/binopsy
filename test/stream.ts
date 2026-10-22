import assert from "node:assert/strict";
import { Bin, type ValueOf } from "../src/index.ts";
import { collect, Str } from "./helpers.ts";
const Item = Bin.start().uint8("kind").int16le("a").floatle("f");

/** A parser using every kind of field. */
const Record = Bin.start()
  .uint32le("id")
  .bit3("flags")
  .bit5("level")
  .int8("signed")
  .nest("name", {
    type: Str,
    formatter: (s) => s.text,
    deformatter: (text) => ({ len: Buffer.byteLength(text), text }),
  })
  .string("tag", { zeroTerminated: true })
  .uint8("count")
  .array("items", { type: Item, length: "count" })
  .array("bytes", { type: "uint8", length: 3 })
  .uint8("kind")
  .choice("extra", {
    tag: "kind",
    choices: {
      0: Bin.start(),
      1: Bin.start().uint16be("x"),
      2: Bin.start().buffer("raw", { length: 4 }),
    },
    defaultChoice: Bin.start().uint8("other"),
  })
  .nest("inline", { type: Bin.start().uint8("p"), flatten: true })
  .fixedSizeNest("fixed", { type: Str, length: 5 })
  .array("rest", { type: "uint16le", readUntil: (v) => v === 0 })
  .uint64le("big");

function makeRecord(i: number): ValueOf<typeof Record> {
  const kind = i % 4;
  return {
    id: i * 7919,
    flags: i % 8,
    level: i % 32,
    signed: (i % 256) - 128,
    name: `name ${i} ü`,
    tag: `tag${i}`,
    count: i % 3,
    items: Array.from({ length: i % 3 }, (_, k) => ({
      kind: k,
      a: 1 - k,
      f: k / 2,
    })),
    bytes: [i & 255, (i >> 8) & 255, 7],
    kind,
    extra: [{}, { x: i }, { raw: Buffer.from([1, 2, 3, 4]) }, { other: 9 }][
      kind
    ],
    p: i % 5,
    fixed: { len: 2, text: "ab" },
    rest: [i + 1, 0],
    big: BigInt(i) * 1000000007n,
  } as ValueOf<typeof Record>;
}

describe("Streams", () => {
  it("parse like parseFrom, with values spanning chunks", async () => {
    const values = Array.from({ length: 100 }, (_, i) => makeRecord(i));
    const input = Buffer.concat(values.map((v) => Record.serialize(v)));
    let offset = 0;
    for (const value of values) {
      const parsed = Record.parseFrom(input, offset);
      assert.deepEqual(parsed.result, value);
      offset = parsed.offset;
    }
    for (const size of [1, 7, 1000]) {
      const chunks: Buffer[] = [];
      for (let i = 0; i < input.length; i += size) {
        chunks.push(input.subarray(i, i + size));
      }
      assert.deepEqual(await collect(Record, chunks), values);
    }
  });

  it("read nothing when a value needs no input yet", async () => {
    // The empty string is read before the next chunk arrives.
    const parser = Bin.start()
      .uint8("len")
      .string("text", { length: "len" })
      .uint8("z");
    const chunks = [Buffer.from([0]), Buffer.from([5])];
    assert.deepEqual(await collect(parser, chunks), [
      { len: 0, text: "", z: 5 },
    ]);
  });

  it("read many values, long arrays and long strings", async () => {
    const count = 100_000;
    const Short = Bin.start().uint16le("a");
    assert.equal(
      (await collect(Short, [Buffer.alloc(2 * count)])).length,
      count,
    );

    const Long = Bin.start()
      .uint32le("n")
      .array("items", { type: Bin.start().uint8("x"), length: "n" })
      .string("text", { zeroTerminated: true });
    const input = Buffer.alloc(4 + count + count + 1, 0x61);
    input.writeUInt32LE(count);
    input[input.length - 1] = 0;
    const [value] = await collect(Long, [input]);
    assert.equal(value.items.length, count);
    assert.equal(value.text.length, count);
  });

  it("wait for a slow reader", async () => {
    const stream = Bin.start().uint8("a").stream();
    stream.write(Buffer.alloc(1000));
    await new Promise((resolve) => setImmediate(resolve));
    // Values are parsed as they are read, not all at once.
    assert.ok(stream.readableLength <= stream.readableHighWaterMark);
    let count = 0;
    stream.on("data", () => count++);
    await new Promise((resolve) => stream.end(resolve));
    assert.equal(count, 1000);
  });

  it("end values that read to the end of the input when it ends", async () => {
    const parser = Bin.start().array("a", { type: "uint8", readUntil: "eof" });
    const chunks = [Buffer.from([1]), Buffer.from([2, 3])];
    assert.deepEqual(await collect(parser, chunks), [{ a: [1, 2, 3] }]);
    assert.deepEqual(await collect(parser, []), []);
  });

  it("fail on incomplete values, and on parsers that read nothing", async () => {
    await assert.rejects(
      collect(Str, [Buffer.from("\x02a")]),
      /unexpected end of input/,
    );
    await assert.rejects(
      collect(Bin.start(), [Buffer.from([1])]),
      /without reading input/,
    );
  });
});
