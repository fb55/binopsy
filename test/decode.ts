import assert from "node:assert/strict";
import {
  array,
  bin,
  bytes,
  decodeStream,
  DecodeError,
  fail,
  literal,
  map,
  match,
  Reader,
  refine,
  sized,
  string,
  u16le,
  u32le,
  u8,
  when,
  type Codec,
} from "../src/index.ts";
import { bytewise, collect, hex } from "./helpers.ts";

const Str = bin().u8("len").field("text", string("len"));

describe("Reader", () => {
  it("reads consecutive values", () => {
    const reader = new Reader(hex("03 616263 02 6465 00"));
    const texts: string[] = [];
    while (!reader.done) texts.push(reader.read(Str).text);
    assert.deepEqual(texts, ["abc", "de", ""]);
  });

  it("starts at an offset inside the input", () => {
    assert.equal(new Reader(hex("00 01 02"), 2).read(u8), 2);
    for (const offset of [-1, 1.5, 4])
      assert.throws(() => new Reader(hex("000102"), offset), RangeError);
  });
});

describe("pick", () => {
  const Record = bin()
    .u8("n")
    .field("items", array(Str, "n"))
    .u8("tag")
    .field("extra", match("tag").case(0, bin()).case(1, u16le))
    .field("name", string({ terminator: 0 }))
    .u8("last");
  const value = {
    n: 2,
    items: [
      { len: 1, text: "a" },
      { len: 0, text: "" },
    ],
    tag: 1 as const,
    extra: 513,
    name: "xyz",
    last: 9,
  };
  const input = Record.encode(value);

  it("decodes only the named fields, stepping over the others", () => {
    const reader = new Reader(input);
    assert.deepEqual(reader.read(Record.pick("name", "last")), {
      name: "xyz",
      last: 9,
    });
    assert.equal(reader.offset, input.length);
    assert.deepEqual(Record.pick().decode(input), {});
  });

  it("decodes the fields before a function of them", () => {
    const parser = bin()
      .u8("n")
      .field(
        "data",
        bytes((o) => o.n * 2),
      )
      .u8("after");
    assert.deepEqual(parser.pick("after").decode(hex("01 0506 09")), {
      after: 9,
    });
  });

  it("still checks the fields it steps over", () => {
    const parser = bin()
      .field("header", bin().field("magic", literal(u8, 1)))
      .u8("a");
    assert.throws(
      () => parser.pick("a").decode(hex("02 00")),
      /expected 1, got 2 in `header.magic` at offset 0/,
    );
  });
});

describe("Errors", () => {
  it("are located by field path and offset", () => {
    const Item = bin().u8("kind").field("name", string(u8));
    const parser = bin().u32le("id").field("items", array(Item, u8));
    const failures: [string, string, string, number][] = [
      ["01000000 02 01 01 61 02 02", "end-of-input", "items[1].name", 10],
      ["010000", "end-of-input", "id", 0],
    ];
    for (const [bytes, code, path, offset] of failures) {
      assert.throws(
        () => parser.decode(hex(bytes)),
        (e) =>
          e instanceof DecodeError &&
          e.code === code &&
          e.message.includes(`\`${path}\``) &&
          e.offset === offset,
        bytes,
      );
    }
  });

  it("report invalid values, unknown tags and failures of functions", async () => {
    const failures: [Codec<unknown, never>, string, RegExp][] = [
      [
        bin().field(
          "a",
          refine(u8, (v) => v < 3, "too big"),
        ),
        "03",
        /too big in `a` at offset 0/,
      ],
      [
        bin().u8("t").field("v", match("t").case(0, u8)),
        "02 00",
        /no case for 2 in `v`/,
      ],
      [
        bin()
          .u8("t")
          .field("v", match("t").case(0, u8))
          .field("x", fail("unsupported")),
        "00 00",
        /unsupported in `x`/,
      ],
      [
        bin().field(
          "a",
          map(u8, {
            decode: () => {
              throw new Error("oops");
            },
          }),
        ),
        "01",
        /oops in `a`/,
      ],
      [
        bin()
          .u8("n")
          .field(
            "a",
            bytes((o) => o.n - 2),
          ),
        "01",
        /invalid length -1 in `a`/,
      ],
      [
        bin().field("a", string({ terminator: 0 })),
        "6162",
        /unexpected end of input .* in `a`/,
      ],
      [
        bin().field("a", array(u8, { until: (v) => v === 0 })),
        "01 02",
        /unexpected end of input .* in `a\[2\]`/,
      ],
      [
        bin().field("a", array(bin(), Infinity)),
        "00",
        /an item took no bytes in `a\[0\]`/,
      ],
      [
        bin().field("a", sized(1, u16le)).u8("b"),
        "00 00",
        /unexpected end of input .* in `a`/,
      ],
    ];
    for (const [parser, bytes, message] of failures) {
      assert.throws(() => parser.decode(hex(bytes)), message, bytes);
      await assert.rejects(
        collect(parser, bytewise(hex(bytes))),
        message,
        bytes,
      );
    }
  });

  it("reject invalid definitions", () => {
    const definitions: [() => unknown, RegExp][] = [
      [
        () =>
          bin()
            .u8("a")
            .u8("a" as never),
        /duplicate field `a`/,
      ],
      [() => bin().u8("__proto__"), /invalid or duplicate field `__proto__`/],
      [
        () =>
          bin()
            .field("a", bytes("n" as never))
            .decode(hex("00")),
        /`n` is not a field before `a`/,
      ],
      [() => bin().bits("x", 54 as never), /`x` has 54 bits/],
      [
        () =>
          bin()
            .field("a", u8)
            .merge(u8 as never),
        /merge needs a parser/,
      ],
      [
        () => string({ terminator: 0, maxx: 1 } as never),
        /unknown option `maxx`/,
      ],
      [() => string(3, { encoding: "utf16le" }), /odd length 3/],
      [() => bytes(-1), /invalid length -1/],
      [
        () =>
          bin()
            .u8("a")
            .computed("b" as never, () => 0 as never),
        /no field `b`/,
      ],
    ];
    for (const [define, message] of definitions) assert.throws(define, message);
  });
});

describe("Streams", () => {
  const Record = bin()
    .u32le("id")
    .field("name", string(u8))
    .field("data", bytes(u16le));
  const values = Array.from({ length: 50 }, (_, i) => ({
    id: i,
    name: `name ${i}`,
    data: new Uint8Array(i * 10).fill(i),
  }));
  const input = Uint8Array.from(
    Buffer.concat(values.map((v) => Record.encode(v))),
  );

  it("decode values that span any number of chunks", async () => {
    for (const size of [1, 7, 100, 1 << 20]) {
      const chunks = [];
      for (let i = 0; i < input.length; i += size)
        chunks.push(input.subarray(i, i + size));
      assert.deepEqual(await collect(Record, chunks), values);
    }
  });

  it("decode from Node.js streams", async () => {
    const { Readable } = await import("node:stream");
    // Bytes are views of the input, here Buffers.
    const buffers = values.map((value) => ({
      ...value,
      data: Buffer.from(value.data),
    }));
    assert.deepEqual(
      await collect(Record, Readable.from([Buffer.from(input)])),
      buffers,
    );
  });

  it("fail when the input ends in a value, or values read nothing", async () => {
    await assert.rejects(
      collect(Record, [input.subarray(0, 10)]),
      /unexpected end of input \(6 bytes needed, 5 left\) in `name` at offset 5/,
    );
    await assert.rejects(
      collect(bin(), [hex("00")]),
      /values of no bytes cannot be streamed/,
    );
    // A value of no bytes, of a size not known before.
    const empty = bin().field("a", string({ terminator: 0, max: 0 }));
    await assert.rejects(collect(empty, [hex("00")]), /a value took no bytes/);
    assert.deepEqual(await collect(Record, []), []);
  });

  it("close the source when the iteration stops, and serve concurrent calls in order", async () => {
    let closed = false;
    function* chunks() {
      try {
        yield input;
      } finally {
        closed = true;
      }
    }
    for await (const value of decodeStream(Record, chunks())) {
      assert.equal(value.id, 0);
      break;
    }
    assert.ok(closed);
    const two =
      Record.encode(values[0]).length + Record.encode(values[1]).length;
    const iterator = decodeStream(Record, bytewise(input.subarray(0, two)));
    const [a, b, c] = await Promise.all([
      iterator.next(),
      iterator.next(),
      iterator.next(),
    ]);
    assert.deepEqual([a.value?.id, b.value?.id, c.done], [0, 1, true]);
  });

  it("report errors at their offset in the stream", async () => {
    const parser = bin().field(
      "a",
      refine(u8, (v) => v < 5),
    );
    await assert.rejects(
      collect(parser, [hex("01 02"), hex("03 09")]),
      /in `a` at offset 3/,
    );
  });
});

describe("Encoding", () => {
  it("computes fields and fills in literals", () => {
    const parser = bin()
      .field("magic", literal(u32le, 0x46464952))
      .u8("size")
      .field("data", bytes("size"))
      .computed("size", (v) => v.data.length);
    assert.deepEqual(
      parser.encode({ data: hex("0102") }),
      hex("52494646 02 0102"),
    );
    assert.throws(
      () => parser.encode({ size: 3, data: hex("0102") }),
      /is 3, but computed as 2 in `size`/,
    );
  });

  it("returns bytes that stay as they are", () => {
    const results = Array.from({ length: 2000 }, (_, i) => u32le.encode(i));
    results.forEach((bytes, i) => assert.equal(u32le.decode(bytes), i));
    // Big enough for the writer to grow (compared without deepEqual, whose diffs of big arrays are huge).
    const Big = bin().u8("a").field("data", bytes(u32le));
    const data = new Uint8Array(100_000).fill(1);
    const big = Big.decode(Big.encode({ a: 7, data }));
    assert.equal(big.a, 7);
    assert.ok(Buffer.compare(big.data, data) === 0);
    assert.equal(u32le.decode(results[1999]), 1999);
  });

  it("writes into a given buffer", () => {
    const bytes = new Uint8Array(6).fill(0xff);
    assert.equal(
      bin().u16le("a").u8("b").encodeInto({ a: 1, b: 2 }, bytes, 2),
      5,
    );
    assert.deepEqual(bytes, hex("ffff 0100 02 ff"));
    assert.throws(() => u32le.encodeInto(1, bytes, 4), /does not fit/);
  });

  it("checks values against lengths, ranges and conditions", () => {
    const failures: [Codec<unknown, never>, object, RegExp][] = [
      [
        bin().u8("n").field("a", array(u8, "n")),
        { n: 2, a: [1] },
        /has 1 items, but its length is 2 in `a`/,
      ],
      [
        bin().field("a", bytes(2)),
        { a: hex("010203") },
        /has 3 bytes, but its length is 2 in `a`/,
      ],
      [
        bin().field("a", string(2)),
        { a: "abc" },
        /has 3 bytes, more than its length 2 in `a`/,
      ],
      [
        bin().field("a", string({ terminator: 0 })),
        { a: "a\0b" },
        /contains its terminator in `a`/,
      ],
      [
        bin().field("a", array(u8, u8)),
        { a: [256] },
        /expected u8, got 256 in `a\[0\]`/,
      ],
      [bin().u8("a").u8("b"), { a: 1 }, /expected u8, got undefined in `b`/],
      [
        bin().field("a", bin().bits("x", 3).bits("y", 5)),
        { a: { x: 8, y: 0 } },
        /expected an unsigned integer of 3 bits, got 8 in `a.x`/,
      ],
      [
        bin().u8("t").field("v", match("t").case(0, u8)),
        { t: 1, v: 0 },
        /no case for 1 in `v`/,
      ],
      [
        bin()
          .u8("v")
          .field(
            "x",
            when((o) => o.v > 0, u8),
          ),
        { v: 0, x: 1 },
        /must be null/,
      ],
      [
        bin().field("a", map(u8, { decode: String })),
        { a: "1" },
        /can only be decoded/,
      ],
      [
        bin().field("a", sized(2, string(Infinity))),
        { a: "abc" },
        /needs 3 bytes, more than its size 2 in `a`/,
      ],
      [
        bin().field("a", array(u8, { until: (v) => v === 0 })),
        { a: [0, 1] },
        /an item before the last ends the array in `a\[0\]`/,
      ],
      [
        bin().field("a", array(u8, { until: (v) => v === 0 })),
        { a: [1] },
        /the last item does not end the array in `a\[0\]`/,
      ],
      [
        bin().field("a", string({ terminator: 0, max: 2 })),
        { a: "abc" },
        /more than its maximum 2/,
      ],
      [
        bin().field("a", string(u8, { encoding: "ascii" })),
        { a: "é" },
        /is not ascii/,
      ],
    ];
    for (const [parser, value, message] of failures)
      assert.throws(() => parser.encode(value as never), message);
  });
});
