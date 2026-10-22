import assert from "node:assert/strict";
import { Bin } from "../src/index.ts";
import { collect, hex, Str } from "./helpers.ts";

/** Bytes from binary digits (spaces are ignored). */
function bits(text: string): Buffer {
  const digits = text.replace(/\s/g, "");
  return Buffer.from(digits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
}

interface Case {
  name: string;
  parser: Bin;
  input: Buffer;
  value: object;
}

function test<T extends object>(
  name: string,
  parser: Bin<T>,
  input: string | Buffer,
  value: NoInfer<T>,
): Case {
  return {
    name,
    parser: parser as unknown as Bin,
    input: typeof input === "string" ? hex(input) : input,
    value,
  };
}

const Pair = Bin.start().uint8("key").int16le("value");

class Point {
  x = 0;
}

interface Tree {
  count: number;
  children: Tree[];
}
const Tree: Bin<Tree> = Bin.start()
  .uint8("count")
  .array("children", { type: Bin.lazy(() => Tree), length: "count" });

const cases: Case[] = [
  // Primitives
  test(
    "integers",
    Bin.start()
      .uint8("a")
      .int8("b")
      .uint16le("c")
      .uint16be("d")
      .int16le("e")
      .int16be("f")
      .uint32le("g")
      .uint32be("h")
      .int32le("i")
      .int32be("j"),
    "ff ff dcfe fedc feff fffe efcdab89 89abcdef eb32a4f8 fffffffe",
    {
      a: 255,
      b: -1,
      c: 0xfedc,
      d: 0xfedc,
      e: -2,
      f: -2,
      g: 0x89abcdef,
      h: 0x89abcdef,
      i: -123456789,
      j: -2,
    },
  ),
  test(
    "floats",
    Bin.start().floatbe("a").doublele("b"),
    "3fc00000 000000000000d0bf",
    { a: 1.5, b: -0.25 },
  ),
  test(
    "64-bit integers as bigints",
    Bin.start().uint64le("a").int64be("b"),
    "ffffffffffffffff 8000000000000000",
    { a: 2n ** 64n - 1n, b: -(2n ** 63n) },
  ),
  test(
    "endianness of unsuffixed methods",
    Bin.start()
      .endianness("little")
      .uint16("a")
      .int32("b")
      .uint64("c")
      .double("d")
      .endianness("big")
      .uint16("e"),
    "0100 feffffff 0300000000000000 000000000000f83f 0001",
    { a: 1, b: -2, c: 3n, d: 1.5, e: 1 },
  ),

  // Bit fields
  test(
    "bit fields, big endian",
    Bin.start().bit1("a").bit2("b").bit4("c").bit1("d"),
    bits("1 10 1010 0"),
    { a: 1, b: 2, c: 10, d: 0 },
  ),
  test(
    "bit fields, little endian (later fields first)",
    Bin.start().endianness("little").bit1("a").bit2("b").bit4("c").bit1("d"),
    bits("1 10 1010 0"),
    { a: 0, b: 2, c: 10, d: 1 },
  ),
  test(
    "bit fields across bytes",
    Bin.start().bit3("a").bit9("b").bit4("c"),
    bits("101 111000111 0111"),
    { a: 5, b: 455, c: 7 },
  ),
  test(
    "bit fields across bytes, little endian",
    Bin.start().endianness("little").bit3("a").bit9("b").bit4("c"),
    bits("101 111000111 0111"),
    { a: 7, b: 398, c: 11 },
  ),
  test(
    "little-endian bit fields are stored in order",
    Bin.start()
      .endianness("little")
      .bit4("a")
      .bit4("b", {
        formatter(b) {
          return b + this.a;
        },
        deformatter: (b, obj) => b - obj.a,
      }),
    "21",
    { a: 1, b: 3 },
  ),
  test(
    "bit fields keep the byte order of their definition",
    Bin.start().bit4("a").bit4("b").endianness("little").uint16("c"),
    "12 0300",
    { a: 1, b: 2, c: 3 },
  ),
  test(
    "bit fields with padding, followed by a byte",
    Bin.start().bit1("a").bit24("b").bit2("c").uint8("d"),
    bits("1 101010101010101010101010 01 00000 00000100"),
    { a: 1, b: 0xaaaaaa, c: 1, d: 4 },
  ),
  test(
    "unsigned 32-bit fields in runs longer than 53 bits",
    Bin.start().bit32("a").bit32("b"),
    "fffffffe 89abcdef",
    { a: 0xfffffffe, b: 0x89abcdef },
  ),
  test(
    "bit fields of nested parsers are their own run",
    Bin.start()
      .bit1("a")
      .nest("x", { type: Bin.start().bit2("b") })
      .bit1("c"),
    bits("1 0000000 10 000000 1 0000000"),
    { a: 1, x: { b: 2 }, c: 1 },
  ),
  test(
    "bit fields before a nested parser",
    Bin.start().bit4("a").bit4("b").nest("x", { type: Pair }),
    "12 01 0200",
    { a: 1, b: 2, x: { key: 1, value: 2 } },
  ),

  // Strings
  test(
    "fixed-length strings",
    Bin.start()
      .string("a", { length: 5, encoding: "ascii" })
      .string("b", { length: 4, encoding: "hex" })
      .string("c", { length: 5 }),
    Buffer.concat([Buffer.from("hello"), hex("cafebabe"), Buffer.from("ü€")]),
    { a: "hello", b: "cafebabe", c: "ü€" },
  ),
  test("length from a field", Str, "03 616263", { len: 3, text: "abc" }),
  test(
    "zero-terminated strings",
    Bin.start()
      .string("a", { zeroTerminated: true })
      .string("b", { zeroTerminated: true })
      .uint8("c"),
    Buffer.from("Müller\0\0\x07"),
    { a: "Müller", b: "", c: 7 },
  ),
  test(
    "zero-terminated strings with a maximum length",
    Bin.start()
      .string("a", { length: 5, zeroTerminated: true })
      .string("b", { length: 5, zeroTerminated: true })
      .string("c", { length: 5, zeroTerminated: true }),
    Buffer.from("abc\0defghij\0"),
    { a: "abc", b: "defgh", c: "ij" },
  ),
  test(
    "stripNull",
    Bin.start().string("a", { length: 6, stripNull: true }),
    Buffer.from("test\0\0"),
    { a: "test" },
  ),
  test(
    "strings up to the end of the input",
    Bin.start().uint8("a").string("b", { length: Infinity }),
    Buffer.from("\x01rest"),
    { a: 1, b: "rest" },
  ),

  // Buffers
  test(
    "buffers",
    Bin.start()
      .uint8("len")
      .buffer("a", { length: "len" })
      .buffer("b", { readUntil: "eof" }),
    "02 dead beef",
    { len: 2, a: hex("dead"), b: hex("beef") },
  ),

  // Arrays
  test(
    "arrays of primitives and parsers",
    Bin.start()
      .uint8("n")
      .array("a", { type: "int16le", length: "n" })
      .array("b", { type: Pair, length: 2 })
      .array("c", { type: "uint8", length: 0 }),
    "02 ffff 0100 01 0200 02 feff",
    {
      n: 2,
      a: [-1, 1],
      b: [
        { key: 1, value: 2 },
        { key: 2, value: -2 },
      ],
      c: [],
    },
  ),
  test(
    "arrays of arrays",
    Bin.start().array("rows", {
      type: Bin.start()
        .uint8("n")
        .array("cols", { type: "uint8", length: "n" }),
      length: 2,
    }),
    "02 0102 00",
    {
      rows: [
        { n: 2, cols: [1, 2] },
        { n: 0, cols: [] },
      ],
    },
  ),
  test(
    "arrays up to the end of the input",
    Bin.start()
      .uint8("n")
      .array("a", { type: Pair, length: "n" })
      .array("b", { type: "uint16le", length: Infinity }),
    "01 01 0200 0300 0400",
    { n: 1, a: [{ key: 1, value: 2 }], b: [3, 4] },
  ),
  test(
    "arrays of parsers up to the end of the input",
    Bin.start().array("a", { type: Pair, readUntil: "eof" }),
    "01 0200 02 0300",
    {
      a: [
        { key: 1, value: 2 },
        { key: 2, value: 3 },
      ],
    },
  ),
  test(
    "arrays up to an item",
    Bin.start()
      .uint8("b")
      .array("a", { type: "uint8", readUntil: (item) => item === 0 }),
    "07 ff 01 00",
    { b: 7, a: [255, 1, 0] },
  ),
  test(
    "arrays keyed by a field of their items",
    Bin.start().array("a", { type: Str, length: 2, key: "text" }),
    "01 61 02 6263",
    { a: { a: { len: 1, text: "a" }, bc: { len: 2, text: "bc" } } },
  ),
  test(
    "arrays keyed by a number",
    Bin.start().array("a", { type: Pair, length: 2, key: "key" }),
    "01 0200 02 0300",
    {
      a: {
        1: { key: 1, value: 2 },
        2: { key: 2, value: 3 },
      },
    },
  ),
  test(
    "arrays keyed by `__proto__`",
    Bin.start().array("a", { type: Str, length: 1, key: "text" }),
    Buffer.from("\x09__proto__"),
    { a: Object.fromEntries([["__proto__", { len: 9, text: "__proto__" }]]) },
  ),

  // Nesting
  test(
    "nested parsers",
    Bin.start().nest("a", { type: Str }).nest("b", { type: "int8" }),
    "01 61 ff",
    { a: { len: 1, text: "a" }, b: -1 },
  ),
  test(
    "flattened formatted values",
    Bin.start()
      .nest("s", {
        type: Str,
        flatten: true,
        formatter: (s) => ({ label: s.text }),
        deformatter: ({ label }) => ({
          len: Buffer.byteLength(label),
          text: label,
        }),
      })
      .nest("n", {
        type: "uint8",
        flatten: true,
        formatter: (n) => ({ double: n * 2 }),
        deformatter: ({ double }) => double / 2,
      }),
    "02 6869 05",
    { label: "hi", double: 10 },
  ),
  test(
    "flattened parsers",
    Bin.start()
      .nest("a", { type: Str, flatten: true })
      .fixedSizeNest("b", { type: Pair, length: 4, flatten: true }),
    "01 61 02 0300 00",
    { len: 1, text: "a", key: 2, value: 3 },
  ),
  test(
    "fixed-size nesting with padding",
    Bin.start()
      .fixedSizeNest("a", { type: "int8", length: 2 })
      .fixedSizeNest("b", {
        type: Bin.start().string("text", { length: Infinity }),
        length: 3,
      })
      .uint8("c"),
    "ff 00 616263 09",
    { a: -1, b: { text: "abc" }, c: 9 },
  ),
  test(
    "objects of a class",
    Bin.start()
      .create(Point)
      .uint8("x")
      .nest("p", { type: Bin.start().create(Point).uint8("x") }),
    "03 04",
    Object.assign(new Point(), {
      x: 3,
      p: Object.assign(new Point(), { x: 4 }),
    }),
  ),
  test(
    "bit fields stay one run when the parser is used in between",
    (() => {
      const parser = Bin.start().bit4("a");
      parser.sizeOf();
      return parser.bit4("b");
    })(),
    "12",
    { a: 1, b: 2 },
  ),
  test("recursive parsers", Tree, "02 01 00 00", {
    count: 2,
    children: [
      { count: 1, children: [{ count: 0, children: [] }] },
      { count: 0, children: [] },
    ],
  }),

  // Choices
  test(
    "choices",
    Bin.start()
      .uint8("tag")
      .choice("a", {
        tag: "tag",
        choices: { 0: "int32le", 1: Str },
        defaultChoice: "uint8",
      })
      .choice("b", {
        tag(obj) {
          return obj.tag === 1 ? "x" : "y";
        },
        choices: { x: "uint8", y: "int16be" },
      }),
    "01 02 6162 07",
    { tag: 1, a: { len: 2, text: "ab" }, b: 7 },
  ),
  test(
    "default choices",
    Bin.start()
      .uint8("tag")
      .choice("a", {
        tag: "tag",
        choices: { 0: "int32le" },
        defaultChoice: "uint8",
      })
      .uint8("b"),
    "05 ff 01",
    { tag: 5, a: 255, b: 1 },
  ),
  test(
    "flattened choices",
    Bin.start()
      .uint8("tag")
      .choice("a", {
        tag: "tag",
        choices: { 1: Str, 2: Pair },
        flatten: true,
      }),
    "02 03 0400",
    { tag: 2, key: 3, value: 4 },
  ),

  // Options
  test(
    "formatters and deformatters",
    Bin.start()
      .uint8("a", {
        formatter: (v) => v === 1,
        deformatter: (v) => (v ? 1 : 0),
      })
      .bit4("b", { formatter: (v) => v * 10, deformatter: (v) => v / 10 })
      .bit4("c")
      .array("ip", {
        type: "uint8",
        length: 4,
        formatter: (bytes) => bytes.join("."),
        deformatter: (ip) => ip.split(".").map(Number),
      })
      .nest("name", {
        type: Str,
        formatter: (s) => s.text,
        deformatter: (text) => ({ len: Buffer.byteLength(text), text }),
      }),
    "01 32 0a000001 02 6869",
    { a: true, b: 30, c: 2, ip: "10.0.0.1", name: "hi" },
  ),
  test(
    "asserts",
    Bin.start()
      .uint8("magic", { assert: 0x42 })
      .uint8("n", { assert: (v) => v < 10 })
      .int64be("big", { assert: -1n }),
    "42 09 ffffffffffffffff",
    { magic: 0x42, n: 9, big: -1n },
  ),
];

describe("Round trips", () => {
  for (const { name, parser, input, value } of cases) {
    it(name, async () => {
      assert.deepEqual(parser.parse(input), value);
      // Skipping covers the code that steps over each kind of field.
      assert.equal(
        parser.parseFrom(input, 0, { fields: [] }).offset,
        input.length,
      );
      assert.deepEqual(parser.serialize(value), input);
      assert.equal(parser.sizeOf(value), input.length);
      // Byte by byte, so that every field spans chunks.
      const chunks = Array.from(input, (byte) => Buffer.from([byte]));
      assert.deepEqual(await collect(parser, chunks), [value]);
    });
  }

  it("copies buffers with clone", () => {
    const input = Buffer.from([1, 2]);
    const { a } = Bin.start()
      .buffer("a", { length: 2, clone: true })
      .parse(input);
    input[0] = 9;
    assert.deepEqual(a, Buffer.from([1, 2]));
  });

  it("reports the size of fixed-size parsers", () => {
    const sizes: [Bin, number][] = [
      [Bin.start().int8("a").string("b", { length: 10 }), 11],
      [Bin.start().array("a", { type: Pair, length: 3 }).bit4("b"), 10],
      [Bin.start().fixedSizeNest("a", { type: Str, length: 4 }), 4],
      [Str, NaN],
      [Bin.start().string("a", { length: 4, zeroTerminated: true }), NaN],
      [Tree, NaN],
    ];
    for (const [parser, size] of sizes) assert.equal(parser.sizeOf(), size);
  });
});
