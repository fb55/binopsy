import { describe, expect, it } from "vitest";

import {
  array,
  bin,
  bytes,
  custom,
  lazy,
  literal,
  map,
  match,
  optional,
  refine,
  sized,
  string,
  u16le,
  u32le,
  u8,
  when,
  type Codec,
} from "../src/index.ts";
import { hex } from "./helpers.ts";

describe("Sizes", () => {
  it("skip the checks of encoding, and items of fixed sizes", () => {
    let calls = 0;
    const count =
      <T>(result: T) =>
      (): T => {
        calls++;
        return result;
      };
    const codec = bin()
      .u8("n")
      .field("a", refine(bytes("n"), count(true)))
      .field("b", bytes(count(1)))
      .field("c", when(count(true), u8))
      .field("d", array(u8, { until: count(true) }))
      .field("e", array(string(u8), { until: count(true) }))
      .field(
        "f",
        array(
          map(bytes(0), { decode: count(0), encode: count(new Uint8Array()) }),
          u8,
        ),
      );
    const value = {
      n: 1,
      a: hex("01"),
      b: hex("02"),
      c: 3,
      d: [0],
      e: [""],
      f: [0, 0],
    };
    expect(codec.sizeOf(value)).toBe(7);
    const fixed = map(u8, { decode: count(0), encode: count(0) });
    const picked = match(count(1)).case(1, fixed);
    expect(optional(u8, fixed).sizeOf(0)).toBe(2);
    expect(optional(fixed, u8).sizeOf(null)).toBe(1);
    expect(sized(u8, fixed).sizeOf(0)).toBe(2);
    expect(array(u8, fixed).sizeOf([1])).toBe(2);
    expect(fixed.sizeOf(0)).toBe(1);
    expect(
      bin()
        .field("s", string(u8))
        .field("f", fixed)
        .field("p", picked)
        .sizeOf({ s: "", f: 0, p: 0 }),
    ).toBe(3);
    expect(calls).toBe(0);
    expect(codec.encode(value)).toHaveLength(7);
    // Lengths are checked: a negative one would take bytes off later fields.
    const negative = bin()
      .field(
        "s",
        string(() => -1),
      )
      .u8("a");
    expect(() => negative.sizeOf({ s: "", a: 0 })).toThrow(
      /invalid length -1/u,
    );
  });

  it("get the defaults of matches for later fields", () => {
    const codec = bin()
      .u8("tag")
      .field("n", match("tag").case(1, literal(u8, 3)))
      .field("data", sized("n", bytes(Infinity)));
    const value = { tag: 1 as const, data: new Uint8Array(3) };
    expect(codec.sizeOf(value)).toBe(5);
    expect(codec.encode(value)).toHaveLength(5);
    // Also through regions and refinements, for functions of later fields.
    const input = { tag: 1, n: undefined, data: new Uint8Array(3) };
    const region = bin()
      .u8("tag")
      .field("n", sized(1, match("tag").case(1, literal(u8, 3))))
      .field(
        "data",
        bytes((o) => o.n ?? 0),
      );
    expect(region.sizeOf(input)).toBe(5);
    expect(region.encode(input)).toHaveLength(5);
    const deferred = bin()
      .u8("tag")
      .field(
        "n",
        lazy(() => match(() => 1).case(1, literal(u8, 3))),
      )
      .field(
        "data",
        bytes((o) => o.n ?? 0),
      );
    expect(deferred.sizeOf(input)).toBe(5);
    expect(deferred.encode(input)).toHaveLength(5);
    // Codecs of lazy see no fields around them, also for their defaults.
    const choice = match(
      (o: unknown) => typeof o === "object" && o !== null && "tag" in o,
    )
      .case(false, literal(u8, 3))
      .case(true, literal(u8, 5));
    const around = bin()
      .u8("tag")
      .field(
        "n",
        sized(
          1,
          match("tag").case(
            1,
            lazy(() => choice),
          ),
        ),
      )
      .field(
        "m",
        lazy(() => choice),
      )
      .field(
        "data",
        sized((o) => o.n ?? 0, bytes(Infinity)),
      );
    const omitted = {
      tag: 1 as const,
      n: undefined,
      m: undefined,
      data: new Uint8Array(3),
    };
    const wire = hex("01 03 03 000000");
    expect(around.encode(omitted)).toStrictEqual(wire);
    expect(around.sizeOf(omitted)).toBe(6);
    expect(around.decode(wire)).toStrictEqual({ ...omitted, n: 3, m: 3 });
    expect(around.pick("m").decode(wire)).toStrictEqual({ m: 3 });
    // Values given are not filled in, so selectors run once.
    let selected = 0;
    const once = sized(1, match(() => ++selected).case(1, literal(u8, 3)));
    expect(once.encode(3)).toStrictEqual(hex("03"));
    expect(selected).toBe(1);
    // Refinements test the value filled in (untyped code may refine literals).
    const untyped = literal(u8, 5) as unknown as Codec<number>;
    const five = bin().field(
      "n",
      refine(untyped, (n) => n > 3),
    );
    expect(five.encode({} as never)).toStrictEqual(hex("05"));
    const refined = refine(
      match("tag")
        .case(1, literal(u8, 3))
        .otherwise(map(u8, { decode: () => undefined, encode: () => 0 })),
      () => true,
    );
    const nested = bin()
      .u8("tag")
      .field("n", match("tag").case(1, refined).otherwise(literal(u16le, 3)))
      .field(
        "data",
        sized((o) => o.n ?? 0, bytes(Infinity)),
      );
    expect(nested.sizeOf(input)).toBe(5);
    expect(nested.encode(input)).toHaveLength(5);
  });
});

describe("Encoding", () => {
  it("returns views of shared buffers that are never overwritten", () => {
    // These results do not fit in one buffer.
    const results = Array.from({ length: 10_000 }, (_, i) => u32le.encode(i));
    expect(
      new Set(results.map((result) => result.buffer)).size,
    ).toBeGreaterThan(1);
    expect(results.findIndex((result, i) => u32le.decode(result) !== i)).toBe(
      -1,
    );
  });

  it("grows its buffer for big values", () => {
    const before = u32le.encode(1999);
    const Big = bin().u8("a").field("data", bytes(u32le));
    const data = new Uint8Array(100_000).fill(1);
    const big = Big.decode(Big.encode({ a: 7, data }));
    expect(big.a).toBe(7);
    expect(Buffer.compare(big.data, data)).toBe(0);
    expect(u32le.decode(before)).toBe(1999);
  });

  it("writes sizes before regions after growing its buffer", () => {
    const payload = new Uint8Array(70_000).fill(17);
    let writes = 0;
    const inner = custom({
      decode: (b) => ({ value: b, bytesRead: b.length }),
      encode: (b: Uint8Array) => {
        writes++;
        return b;
      },
    });
    const count = map(u32le, {
      decode: (n) => n - 1,
      encode: (n: number) => n + 1,
    });
    const codec = bin()
      .u8("head")
      .field("body", sized(count, inner))
      .u8("tail");
    // The value is written after an earlier result in the same buffer.
    const previous = u8.encode(123);
    const wire = codec.encode({ head: 7, body: payload, tail: 9 });
    expect(writes).toBe(1);
    expect(previous[0]).toBe(123);
    expect(wire).toHaveLength(payload.length + 6);
    expect(new DataView(wire.buffer, wire.byteOffset).getUint32(1, true)).toBe(
      payload.length + 1,
    );
    expect(wire.at(-1)).toBe(9);
    expect(Buffer.compare(codec.decode(wire).body, payload)).toBe(0);
  });

  it("writes into a given buffer", () => {
    const target = new Uint8Array(6).fill(0xff);
    expect(bin().u16le("a").u8("b").encodeInto({ a: 1, b: 2 }, target, 2)).toBe(
      5,
    );
    expect(target).toStrictEqual(hex("ffff 0100 02 ff"));
    expect(() => u32le.encodeInto(1, target, 4)).toThrow(/does not fit/u);
  });

  it("writes into shared memory", () => {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    expect(bin().u8("a").u16le("b").encodeInto({ a: 1, b: 2 }, shared, 1)).toBe(
      4,
    );
    expect(Uint8Array.from(shared)).toStrictEqual(hex("00 01 0200"));
  });
});
