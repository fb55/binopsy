import { describe, expect, it } from "vitest";

import {
  array,
  bin,
  f64le,
  lazy,
  literal,
  map,
  optional,
  refine,
  u16le,
  u8,
  when,
  type Codec,
} from "../src/index.ts";
import { encodeFails, hex, roundtrip, type Standalone } from "./helpers.ts";

type Case = [name: string, codec: Standalone, bytes: string, value: unknown];

describe("Parsers", () => {
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

  it.each<Case>([
    [
      "nest and merge parsers",
      bin()
        .field("a", bin().u8("key").i16le("value"))
        .merge(bin().u8("b"))
        .field("c", bin()),
      "01 0200 03",
      { a: { key: 1, value: 2 }, b: 3, c: {} },
    ],
    [
      "contain themselves",
      Tree,
      "02 01 00 00",
      {
        count: 2,
        children: [
          { count: 1, children: [{ count: 0, children: [] }] },
          { count: 0, children: [] },
        ],
      },
    ],
    [
      "contain literals, refinements and conversions",
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
    ],
  ])("%s", (_, codec, bytes, value) => roundtrip(codec, bytes, value));

  it.each(["decode", "encode"] as const)(
    "are compiled again after compiling a lazy codec failed to %s",
    (direction) => {
      interface A {
        stop: number;
        child: B | null;
        later: number;
      }
      interface B {
        child: A | null;
      }
      let ready = false;
      const b: Codec<B> = bin().field(
        "child",
        optional(
          u8,
          lazy(() => a),
        ),
      );
      const a: Codec<A> = bin()
        .u8("stop")
        .field(
          "child",
          optional(
            u8,
            lazy(() => b),
          ),
        )
        .field(
          "later",
          lazy(() => {
            if (!ready) throw new Error("not ready");
            return u8;
          }),
        );
      for (let i = 0; i < 2; i++) {
        expect(() =>
          direction === "encode"
            ? a.encode({ stop: 0, child: null, later: 7 })
            : a.decode(new Uint8Array()),
        ).toThrow(/not ready/u);
      }
      ready = true;
      const wire = Uint8Array.of(1, 0, 0, 7);
      const value = { child: { stop: 0, child: null, later: 7 } };
      expect(b.decode(wire)).toStrictEqual(value);
      expect(b.encode(value)).toStrictEqual(wire);
    },
  );
});

describe("Literals", () => {
  it("compare as Object.is", () => {
    const zero = literal(f64le, -0);
    expect(zero.decode(zero.encode(undefined))).toBe(-0);
    expect(() => zero.decode(f64le.encode(0))).toThrow(/expected 0, got 0/u);
    const nan = literal(f64le, Number.NaN);
    expect(nan.decode(nan.encode(undefined))).toBeNaN();
  });
});

describe("Refinements", () => {
  it("check values when decoding and encoding", () => {
    const Status = refine(
      u8,
      (n): n is 1 | 2 => n === 1 || n === 2,
      "expected status 1 or 2",
    );
    expect(Status.decode(hex("02"))).toBe(2);
    expect(() => Status.decode(hex("03"))).toThrow(/expected status 1 or 2/u);
    expect(() => Status.encode(3 as never)).toThrow(/expected status 1 or 2/u);
  });
});

describe("Optional values", () => {
  const parser = bin().field("a", optional(u8, u16le));

  it("follow a flag, or a condition", () =>
    roundtrip(
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
    ));

  it("follow any flag but 0", () => {
    expect(parser.decode(hex("07 0200"))).toStrictEqual({ a: 2 });
  });

  it("are null, never undefined", () => {
    encodeFails(parser, { a: undefined }, /expected a value, or null in `a`/u);
  });
});

describe("Conditions", () => {
  const parser = bin()
    .u8("flags")
    .field("x", when("flags", u8))
    .field(
      "y",
      when((o) => o.flags > 1, u8),
    );

  it.each<Case>([
    ["name fields", parser, "01 07", { flags: 1, x: 7, y: null }],
    ["are functions", parser, "02 07 08", { flags: 2, x: 7, y: 8 }],
    ["give null when false", parser, "00", { flags: 0, x: null, y: null }],
  ])("%s", (_, codec, bytes, value) => roundtrip(codec, bytes, value));

  it.each<[name: string, value: unknown, message: RegExp]>([
    [
      "need a value when they hold",
      { flags: 1, x: null, y: null },
      /is null, but its condition holds in `x`/u,
    ],
    [
      "need null when they do not hold",
      { flags: 0, x: null, y: 1 },
      /must be null \(its condition is false\) in `y`/u,
    ],
  ])("%s", (_, value, message) => encodeFails(parser, value, message));
});
