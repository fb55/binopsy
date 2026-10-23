import assert from "node:assert/strict";
import { bin, map } from "../src/index.ts";
import { bytewise, collect, hex } from "./helpers.ts";

describe("Bit fields", () => {
  it("share bytes, most significant bits first", async () => {
    const parser = bin().bits("a", 1).bits("b", 2).bits("c", 5).bits("d", 4);
    const value = { a: 1, b: 2, c: 20, d: 0xf };
    assert.deepEqual(parser.decode(hex("d4 f0")), value);
    // The padding is zero.
    assert.deepEqual(parser.encode(value), hex("d4 f0"));
    assert.deepEqual(parser.decode(hex("d4 ff")), value);
    assert.deepEqual(await collect(parser, bytewise(hex("d4 f0"))), [value]);
  });

  it("share bytes, least significant bits first", () => {
    const parser = bin({ bitOrder: "lsb" })
      .bits("x", 4)
      .bits("y", 8)
      .bits("z", 4);
    const value = { x: 1, y: 0x32, z: 4 };
    assert.deepEqual(parser.decode(hex("21 43")), value);
    assert.deepEqual(parser.encode(value), hex("21 43"));
  });

  it("have up to 53 bits, at any position", () => {
    for (const order of ["msb", "lsb"] as const) {
      const parser = bin({ bitOrder: order })
        .bits("a", 3)
        .bits("b", 32)
        .bits("c", 31)
        .bits("d", 9)
        .bits("e", 7)
        .bits("f", 8)
        .bits("g", 1)
        .bits("h", 53)
        .bits("i", 33)
        .bits("j", 48)
        .bits("k", 7);
      const value = {
        a: 5,
        b: 0xfedcba98,
        c: 0x7fffffff,
        d: 0x155,
        e: 0x2a,
        f: 0xff,
        g: 1,
        h: Number.MAX_SAFE_INTEGER - 0x5a5a5a5a,
        i: 2 ** 32 + 0x89abcdef,
        j: 0xfedc_ba98_7654,
        k: 0x41,
      };
      const bytes = parser.encode(value);
      assert.equal(bytes.length, 29);
      assert.deepEqual(parser.decode(bytes), value, order);
    }
    assert.deepEqual(
      bin().bits("a", 32).bits("b", 32).decode(hex("fffffffe 89abcdef")),
      { a: 0xfffffffe, b: 0x89abcdef },
    );
    // Issue #12.
    assert.deepEqual(bin().bits("a", 48).decode(hex("ffffffffffff")), {
      a: 2 ** 48 - 1,
    });
    assert.deepEqual(
      bin().bits("a", 4).bits("b", 44).decode(hex("0123456789ab")),
      { a: 0, b: 0x123456789ab },
    );
    assert.deepEqual(
      bin({ bitOrder: "lsb" }).bits("a", 4).bits("b", 44).encode({
        a: 0xb,
        b: 0x123456789a,
      }),
      hex("ab 89 67 45 23 01"),
    );
    for (const a of [2 ** 53, -1, 0.5, 2n])
      assert.throws(
        () =>
          bin()
            .bits("a", 53)
            .encode({ a: a as number }),
        /expected an unsigned integer of 53 bits/,
      );
    assert.throws(() => bin().bits("a", 54 as 53), /has 54 bits, not 1 to 53/);
  });

  it("are followed by numbers at the next byte", () => {
    const parser = bin().bits("a", 3).u8("b").bits("c", 4).u16be("d");
    const value = { a: 7, b: 0x12, c: 0xf, d: 0x3456 };
    assert.deepEqual(parser.encode(value), hex("e0 12 f0 3456"));
    assert.deepEqual(parser.decode(hex("e0 12 f0 3456")), value);
  });

  it("continue in merged parsers, but not in nested ones", () => {
    const Low = bin().bits("c", 4);
    assert.deepEqual(
      bin().bits("a", 4).merge(Low).encode({ a: 1, c: 2 }),
      hex("12"),
    );
    assert.deepEqual(
      bin()
        .bits("a", 4)
        .field("n", Low)
        .encode({ a: 1, n: { c: 2 } }),
      hex("10 20"),
    );
    assert.throws(
      () =>
        bin()
          .bits("a", 4)
          .merge(bin({ bitOrder: "lsb" }).bits("b", 4)),
      /bit fields of different orders/,
    );
  });

  it("are checked when encoding, and picked", () => {
    const parser = bin().bits("a", 3).bits("b", 5);
    for (const a of [8, -1, 1.5, NaN]) {
      assert.throws(
        () => parser.encode({ a, b: 0 }),
        /expected an unsigned integer of 3 bits/,
      );
    }
    assert.deepEqual(parser.pick("b").decode(hex("ff")), { b: 31 });
  });

  it("migrate 0.0.0's little-endian runs: fields in reverse, padding last", () => {
    // `.endianess("little").bit3("a").bit2("b")` read 0b10110000 as { b: 2, a: 6 }.
    const parser = bin().bits("b", 2).bits("a", 3);
    assert.deepEqual(parser.decode(Uint8Array.of(0b10110000)), { b: 2, a: 6 });
    // Nested bits of 0.0.0 shared their bytes: a flat run, mapped to the nested shape.
    const Nested = map(
      bin().bits("a", 1).bits("b", 2).bits("c", 4).bits("d", 1),
      {
        decode: (p) => ({ a: p.a, x: { b: p.b, c: p.c, d: p.d } }),
        encode: (p: { a: number; x: { b: number; c: number; d: number } }) => ({
          a: p.a,
          ...p.x,
        }),
      },
    );
    assert.deepEqual(Nested.decode(hex("d4")), {
      a: 1,
      x: { b: 2, c: 10, d: 0 },
    });
    assert.deepEqual(
      Nested.encode({ a: 1, x: { b: 2, c: 10, d: 0 } }),
      hex("d4"),
    );
  });
});
