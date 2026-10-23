import assert from "node:assert/strict";
import {
  array,
  bin,
  bytes,
  literal,
  map,
  match,
  sized,
  string,
  u16le,
  u8,
  when,
  type Codec,
} from "../src/index.ts";
import { bytewise, collect, hex } from "./helpers.ts";

/** Checks that `codec` decodes `bytes` to `value` (also from a stream), and encodes `input` to them. */
async function roundtrip<O>(
  codec: Codec<O, never>,
  bytes: string,
  value: unknown,
  input: unknown = value,
): Promise<void> {
  assert.deepEqual(codec.decode(hex(bytes)), value);
  assert.deepEqual(await collect(codec, bytewise(hex(bytes))), [value]);
  assert.deepEqual(
    (codec as unknown as Codec<O, unknown>).encode(input),
    hex(bytes),
  );
}

describe("Fields around codecs", () => {
  it("are read by parsers merged into others (and match cases)", async () => {
    const Raw = bin<{ length: number }>().field("raw", bytes("length"));
    const Text = bin<{ length: number }>()
      .field(
        "text",
        string((o) => o.length - 1),
      )
      .u8("end");
    const Message = bin()
      .u8("tag")
      .u8("length")
      .merge(match("tag").case(1, Raw).case(2, Text));
    await roundtrip(Message, "01 02 abcd", {
      tag: 1,
      length: 2,
      raw: hex("abcd"),
    });
    await roundtrip(Message, "02 03 6869 07", {
      tag: 2,
      length: 3,
      text: "hi",
      end: 7,
    });
    // The same parser, in another one.
    await roundtrip(bin().u16le("length").merge(Raw), "0100 ff", {
      length: 1,
      raw: hex("ff"),
    });
  });

  it("are read by nested parsers, items and regions", async () => {
    await roundtrip(
      bin()
        .u8("n")
        .field(
          "inner",
          bin<{ n: number }>().field(
            "data",
            bytes((o) => o.n),
          ),
        ),
      "02 0102",
      { n: 2, inner: { data: hex("0102") } },
    );
    await roundtrip(
      bin()
        .u8("size")
        .u8("count")
        .field(
          "items",
          array(
            bytes((o) => o.size),
            "count",
          ),
        ),
      "01 02 05 06",
      { size: 1, count: 2, items: [hex("05"), hex("06")] },
    );
    await roundtrip(
      bin()
        .u8("n")
        .field("region", sized(2, bytes("n"))),
      "01 0700",
      { n: 1, region: hex("07") },
    );
    // Local fields hide those around them.
    await roundtrip(
      bin()
        .u8("n")
        .field(
          "inner",
          bin<{ n: number }>().u16le("n").field("data", bytes("n")),
        ),
      "05 0100 09",
      { n: 5, inner: { n: 1, data: hex("09") } },
    );
  });

  it("are the fields before, when encoding as when decoding", () => {
    const seen: string[][] = [];
    const parser = bin()
      .u8("a")
      .field(
        "b",
        bytes((o) => (seen.push(Object.keys(o)), 1)),
      )
      .u8("c");
    parser.encode({ a: 1, b: hex("02"), c: 3 });
    parser.decode(hex("01 02 03"));
    assert.deepEqual(seen, [["a"], ["a"]]);
  });

  it("are not found when nothing around has them", () => {
    assert.throws(
      () =>
        bin()
          .field("a", bytes("n" as never))
          .encode({ a: hex("") } as never),
      /`n` is not a field before `a`/,
    );
  });
});

describe("Defaults", () => {
  it("are the literals of omitted fields, which later fields read", async () => {
    await roundtrip(
      bin().field("n", literal(u8, 2)).field("d", bytes("n")),
      "02 0102",
      { n: 2, d: hex("0102") },
      { d: hex("0102") },
    );
    await roundtrip(
      bin().field("t", literal(u8, 1)).field("v", match("t").case(1, u16le)),
      "01 0500",
      { t: 1, v: 5 },
      { v: 5 },
    );
  });

  it("are the literals of the case a value is in", async () => {
    const parser = bin()
      .u8("t")
      .field("v", match("t").case(1, literal(u8, 7)).case(2, u8))
      .field("w", bytes("v"));
    await roundtrip(
      parser,
      "01 07 00000000000000",
      {
        t: 1,
        v: 7,
        w: new Uint8Array(7),
      },
      { t: 1, w: new Uint8Array(7) },
    );
  });

  it("are not given for values that only accept undefined", () => {
    const Count = map(u8, {
      decode: (n) => n,
      encode: (n: number | undefined) => n ?? 0,
    });
    const parser = bin()
      .field("count", Count)
      .field(
        "body",
        bytes((o) => o.count ?? 0),
      );
    assert.deepEqual(
      parser.encode({ count: undefined, body: hex("") }),
      hex("00"),
    );
  });
});

describe("Computed fields", () => {
  const Chunk = bin()
    .u8("count")
    .u8("size")
    .field("parts", array(bytes("size"), "count"))
    .computed({
      count: (v) => v.parts.length,
      size: (v) => v.parts[0]?.length ?? 0,
    });

  it("are computed from the rest of the value, each on its own", async () => {
    await roundtrip(
      Chunk,
      "02 01 0a 0b",
      { count: 2, size: 1, parts: [hex("0a"), hex("0b")] },
      { parts: [hex("0a"), hex("0b")] },
    );
    const seen: string[][] = [];
    bin()
      .u8("a")
      .u8("b")
      .u8("c")
      .computed({
        a: (v) => (seen.push(Object.keys(v)), 1),
        b: (v) => (seen.push(Object.keys(v)), 2),
      })
      .encode({ c: 3 });
    assert.deepEqual(seen, [["c"], ["c"]]);
  });

  it("must agree with values given, and be defined", () => {
    assert.throws(
      () => Chunk.encode({ count: 3, parts: [hex("0a")] }),
      /is 3, but computed as 1 in `count`/,
    );
    assert.throws(
      () =>
        (
          bin()
            .u8("a")
            .computed("a", () => undefined as never) as unknown as Codec<
            unknown,
            unknown
          >
        ).encode({}),
      /is computed as undefined in `a`/,
    );
  });

  it("only see the fields of their parser when it is merged", () => {
    let seen: string[] = [];
    const Inner = bin()
      .u8("n")
      .field("d", bytes("n"))
      .computed("n", (v) => ((seen = Object.keys(v)), v.d.length));
    const Outer = bin().u8("tag").merge(Inner).u8("after");
    assert.deepEqual(
      Outer.encode({ tag: 1, d: hex("0203"), after: 9 }),
      hex("01 02 0203 09"),
    );
    assert.deepEqual(seen, ["d"]);
  });
});

describe("Conditions", () => {
  it("name fields, or are functions returning booleans", async () => {
    const parser = bin()
      .u8("flags")
      .field("x", when("flags", u8))
      .field(
        "y",
        when((o) => o.flags > 1, u8),
      );
    await roundtrip(parser, "00", { flags: 0, x: null, y: null });
    await roundtrip(parser, "02 07 08", { flags: 2, x: 7, y: 8 });
    assert.throws(
      () => parser.encode({ flags: 1, x: null, y: null }),
      /is null, but its condition holds in `x`/,
    );
    assert.throws(
      () => parser.encode({ flags: 0, x: undefined as never, y: null }),
      /expected a value, or null in `x`/,
    );
  });
});
