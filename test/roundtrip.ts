import assert from "node:assert/strict";
import {
  array,
  bin,
  bytes,
  i16le,
  i32le,
  lazy,
  literal,
  map,
  match,
  optional,
  Reader,
  refine,
  sized,
  string,
  u16be,
  u16le,
  u32be,
  u8,
  when,
  type Codec,
} from "../src/index.ts";
import { bytewise, collect, hex } from "./helpers.ts";

interface Case {
  name: string;
  codec: Codec<unknown, never>;
  bytes: Uint8Array;
  value: unknown;
}

/** A case: `codec` decodes `bytes` (hex) to `value`, and encodes `value` to `bytes`. */
function test<O>(
  name: string,
  codec: Codec<O, O>,
  bytes: string,
  value: NoInfer<O>,
): Case {
  return {
    name,
    codec: codec as Codec<unknown, never>,
    bytes: hex(bytes),
    value,
  };
}

const Pair = bin().u8("key").i16le("value");

interface Tree {
  count: number;
  children: Tree[];
}
const Tree: Codec<Tree> = bin()
  .u8("count")
  .field(
    "children",
    array(
      lazy(() => Tree),
      "count",
    ),
  );

const cases: Case[] = [
  test(
    "integers",
    bin()
      .u8("a")
      .i8("b")
      .u16le("c")
      .u16be("d")
      .i16le("e")
      .i16be("f")
      .u32le("g")
      .u32be("h")
      .i32le("i")
      .i32be("j"),
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
    "floats and 64-bit integers",
    bin().f32be("a").f64le("b").u64le("c").i64be("d"),
    "3fc00000 000000000000d0bf ffffffffffffffff 8000000000000000",
    { a: 1.5, b: -0.25, c: 2n ** 64n - 1n, d: -(2n ** 63n) },
  ),
  test("a primitive on its own", u32be, "01020304", 0x01020304),

  test(
    "strings of a fixed size, up to a zero byte",
    bin()
      .field("a", string(5, { terminator: 0 }))
      .field("b", string(3, { encoding: "latin1" }))
      .field("c", string(5, { terminator: 0 })),
    "6869000000 e9e9e9 c3bce282ac",
    { a: "hi", b: "ééé", c: "ü€" },
  ),
  test(
    "strings with lengths read before them, from fields and computed",
    bin()
      .field("a", string(u8))
      .u8("n")
      .field("b", string("n"))
      .field(
        "c",
        string((o) => o.n * 2),
      ),
    "02 6869 01 61 0062",
    { a: "hi", n: 1, b: "a", c: "\0b" },
  ),
  test(
    "zero-terminated strings",
    bin()
      .field("a", string({ terminator: 0 }))
      .field("b", string({ terminator: 0 }))
      .u8("c"),
    "4dc3bc6c6c657200 00 07",
    {
      a: "Müller",
      b: "",
      c: 7,
    },
  ),

  test(
    "zero-terminated strings of a maximum size",
    bin()
      .field("a", string({ terminator: 0, max: 4 }))
      .field("b", string({ terminator: 0, max: 4 })),
    "616200 63646566",
    { a: "ab", b: "cdef" },
  ),
  test(
    "strings in other encodings",
    bin()
      .field("a", string(4, { encoding: "utf16le", terminator: 0 }))
      .field("b", string(u8, { encoding: "ascii" }))
      .field("c", string({ terminator: 0, encoding: "utf16le" })),
    "68000000 02 6869 e900 0000",
    { a: "h", b: "hi", c: "é" },
  ),
  test("strings up to the end of the input", string(Infinity), "616263", "abc"),

  test(
    "bytes",
    bin()
      .field("a", bytes(2))
      .field("b", bytes(u8))
      .u8("n")
      .field("c", bytes("n")),
    "dead 01be 02 beef",
    { a: hex("dead"), b: hex("be"), n: 2, c: hex("beef") },
  ),

  test(
    "arrays of primitives and parsers",
    bin()
      .field("a", array(i16le, 2))
      .field("b", array(Pair, u8))
      .u8("n")
      .field("c", array(u8, "n"))
      .field("d", array(u8, 0)),
    "ffff 0100 02 01 0200 02 feff 01 07",
    {
      a: [-1, 1],
      b: [
        { key: 1, value: 2 },
        { key: 2, value: -2 },
      ],
      n: 1,
      c: [7],
      d: [],
    },
  ),
  test(
    "arrays of arrays and strings",
    bin()
      .field("rows", array(array(u8, u8), 2))
      .field("names", array(string(u8), u8)),
    "02 0102 00 02 01 61 00",
    { rows: [[1, 2], []], names: ["a", ""] },
  ),

  test(
    "arrays up to the end of the input",
    bin().u8("n").field("rest", array(u16le, Infinity)),
    "01 0200 0300",
    { n: 1, rest: [2, 3] },
  ),
  test(
    "arrays up to an item",
    bin()
      .field("a", array(u8, { until: (v) => v === 0 }))
      .u8("b"),
    "07 ff 00 09",
    { a: [7, 255, 0], b: 9 },
  ),

  test(
    "values in regions of a size",
    bin()
      .field("a", sized(4, bin().u8("x")))
      .field("b", sized(u16le, string(Infinity)))
      .u8("n")
      .field("c", sized("n", array(u8, Infinity))),
    "01000000 0300 616263 02 0506",
    { a: { x: 1 }, b: "abc", n: 2, c: [5, 6] },
  ),
  test(
    "bytes up to the end of the input",
    sized(2, bytes(Infinity)),
    "dead",
    hex("dead"),
  ),

  test(
    "nested and merged parsers",
    bin().field("a", Pair).merge(bin().u8("b")).field("c", bin()),
    "01 0200 03",
    { a: { key: 1, value: 2 }, b: 3, c: {} },
  ),
  test("recursive parsers", Tree, "02 01 00 00", {
    count: 2,
    children: [
      { count: 1, children: [{ count: 0, children: [] }] },
      { count: 0, children: [] },
    ],
  }),

  test(
    "matches on number tags",
    bin()
      .u8("tag")
      .field("value", match("tag").case(0, i32le).case(1, Pair).case(2, bin()))
      .u8("after"),
    "01 05 0600 07",
    { tag: 1, value: { key: 5, value: 6 }, after: 7 },
  ),
  test(
    "matches on string tags",
    bin()
      .field("tag", string(1))
      .field("value", match("tag").case("a", u8).case("1", u16be)),
    "31 0102",
    { tag: "1", value: 0x0102 },
  ),

  test(
    "matches with a default case, and on computed tags",
    bin()
      .u8("tag")
      .field("v", match("tag").case(1, u8).otherwise(u16le))
      .u8("x")
      .field(
        "w",
        match((o: { x: number }) => (o.x > 5 ? "big" : "small"))
          .case("big", u16le)
          .case("small", u8),
      ),
    "02 0300 09 0400",
    { tag: 2, v: 3, x: 9, w: 4 },
  ),

  test(
    "bit fields, most significant bit first",
    bin().field("a", bin().bits("x", 1).bits("y", 2).bits("z", 5)).u8("b"),
    "d4 ff",
    { a: { x: 1, y: 2, z: 20 }, b: 255 },
  ),
  test(
    "bit fields, least significant bit first",
    bin().field(
      "a",
      bin({ bitOrder: "lsb" }).bits("x", 4).bits("y", 8).bits("z", 4),
    ),
    "21 43",
    { a: { x: 1, y: 0x32, z: 4 } },
  ),
  test(
    "bit fields of more than 32 bits",
    bin().bits("a", 32).bits("b", 32),
    "fffffffe 89abcdef",
    { a: 0xfffffffe, b: 0x89abcdef },
  ),

  test(
    "literals, refinements and conversions",
    bin()
      .field("magic", literal(u8, 0x42))
      .field(
        "n",
        refine(u8, (n) => n < 10),
      )
      .field(
        "on",
        map(u8, {
          decode: (v) => v === 1,
          encode: (v: boolean) => (v ? 1 : 0),
        }),
      )
      .field(
        "ip",
        map(array(u8, 4), {
          decode: (b) => b.join("."),
          encode: (ip: string) => ip.split(".").map(Number),
        }),
      ),
    "42 09 01 0a000001",
    { magic: 0x42, n: 9, on: true, ip: "10.0.0.1" },
  ),
  test(
    "optional values",
    bin()
      .field("a", optional(u8, u16le))
      .field("b", optional(u8, u16le))
      .u8("version")
      .field(
        "c",
        when((o) => o.version > 1, u8),
      )
      .field(
        "d",
        when((o) => o.version > 2, u8),
      ),
    "01 0200 00 02 07",
    { a: 2, b: null, version: 2, c: 7, d: null },
  ),
];

describe("Round trips", () => {
  for (const { name, codec, bytes, value } of cases) {
    it(name, async () => {
      assert.deepEqual(codec.decode(bytes), value);
      assert.deepEqual(codec.encode(value as never), bytes);
      // Stepping over the value, and decoding it from chunks of one byte.
      const reader = new Reader(bytes);
      reader.read(bin().field("value", codec).pick());
      assert.equal(reader.offset, bytes.length);
      assert.deepEqual(await collect(codec, bytewise(bytes)), [value]);
    });
  }
});
