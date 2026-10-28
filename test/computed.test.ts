import { describe, expect, it } from "vitest";

import {
  array,
  bin,
  bits,
  bytes,
  lazy,
  literal,
  map,
  match,
  sized,
  u16le,
  u32le,
  u8,
} from "../src/index.ts";
import { hex, roundtrip, type Standalone } from "./helpers.ts";

describe("Defaults", () => {
  it.each<
    [
      name: string,
      codec: Standalone,
      bytes: string,
      value: unknown,
      input: unknown,
    ]
  >([
    [
      "are the literals of omitted fields, which lengths read",
      bin().field("n", literal(u8, 2)).field("d", bytes("n")),
      "02 0102",
      { n: 2, d: hex("0102") },
      { d: hex("0102") },
    ],
    [
      "are the literals of omitted fields, which tags read",
      bin().field("t", literal(u8, 1)).field("v", match("t").case(1, u16le)),
      "01 0500",
      { t: 1, v: 5 },
      { v: 5 },
    ],
  ])("%s", (_, codec, wire, value, input) =>
    roundtrip(codec, wire, value, input),
  );

  it.each([
    ["", literal(u8, 2)],
    [", through sized", sized(1, literal(u8, 2))],
    [", through lazy", lazy(() => literal(u8, 2))],
  ])(
    "are the literals of the case a value is in%s, which later fields read",
    (_, codec) =>
      roundtrip(
        bin()
          .u8("t")
          .field("n", match("t").case(1, codec).case(2, u8))
          .field("data", bytes("n"))
          .field(
            "tail",
            bytes((o) => o.n),
          ),
        "01 02 0708 090a",
        { t: 1, n: 2, data: hex("0708"), tail: hex("090a") },
        { t: 1, data: hex("0708"), tail: hex("090a") },
      ),
  );

  it("are not given through map", () => {
    let seen: unknown = null;
    const parser = bin()
      .field(
        "count",
        map(literal(u8, 2), {
          decode: (n) => n,
          encode: (n: 2 | undefined) => n,
        }),
      )
      .field(
        "body",
        bytes((o) => {
          seen = o.count;
          return 0;
        }),
      );
    expect(parser.encode({ count: undefined, body: hex("") })).toStrictEqual(
      hex("02"),
    );
    expect(seen).toBeUndefined();
  });
});

describe("Computed fields", () => {
  it("fill in omitted fields, and must agree with given ones", () => {
    const parser = bin()
      .field("magic", literal(u32le, 0x46464952))
      .u8("size")
      .field("data", bytes("size"))
      .computed("size", (v) => v.data.length);
    expect(parser.encode({ data: hex("0102") })).toStrictEqual(
      hex("52494646 02 0102"),
    );
    expect(() => parser.encode({ size: 3, data: hex("0102") })).toThrow(
      /is 3, but computed as 2 in `size`/u,
    );
  });

  it("are computed each from the value without the others", async () => {
    await roundtrip(
      bin()
        .u8("count")
        .u8("size")
        .field("parts", array(bytes("size"), "count"))
        .computed({
          count: (v) => v.parts.length,
          size: (v) => v.parts[0]?.length ?? 0,
        }),
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
        a: (v) => {
          seen.push(Object.keys(v));
          return 1;
        },
        b: (v) => {
          seen.push(Object.keys(v));
          return 2;
        },
      })
      .encode({ c: 3 });
    expect(seen).toStrictEqual([["c"], ["c"]]);
  });

  it("only see the fields of their parser when it is merged", () => {
    let seen: string[] = [];
    const Inner = bin()
      .u8("n")
      .field("d", bytes("n"))
      .computed("n", (v) => {
        seen = Object.keys(v);
        return v.d.length;
      });
    const Outer = bin().u8("tag").merge(Inner).u8("after");
    expect(Outer.encode({ tag: 1, d: hex("0203"), after: 9 })).toStrictEqual(
      hex("01 02 0203 09"),
    );
    expect(seen).toStrictEqual(["d"]);
  });

  it.each([
    ["a byte", 1],
    ["a bit field", 2],
  ] as const)("supply %s common to merged cases", (_, tag) => {
    const parser = bin()
      .u8("tag")
      .merge(
        match("tag")
          .case(1, bin().u8("n"))
          .case(2, bin().field("n", bits(8))),
      )
      .computed("n", () => 7);
    expect(parser.encode(Object.freeze({ tag }))).toStrictEqual(
      Uint8Array.of(tag, 7),
    );
  });

  it("supply the fields a merged parser computes from", () => {
    const group = bin()
      .u8("n")
      .u8("x")
      .computed("x", (v) => v.n + 1);
    const parser = bin()
      .merge(group)
      .computed("n", () => 7);
    expect(parser.encode({})).toStrictEqual(Uint8Array.of(7, 8));
  });

  it("must agree when a merged parser computes them too", () => {
    const group = bin()
      .u8("n")
      .u8("x")
      .computed("n", (v) => v.x);
    const parser = bin()
      .merge(group)
      .computed("n", () => 7);
    expect(parser.encode({ x: 7 })).toStrictEqual(Uint8Array.of(7, 7));
    expect(() => parser.encode({ x: 8 })).toThrow(
      /is 7, but computed as 8 in `n`/u,
    );
  });
});
