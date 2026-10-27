import { describe, expect, it } from "vitest";

import {
  array,
  bin,
  bits,
  literal,
  u8,
  type BitWidth,
  type Codec,
} from "../src/index.ts";
import {
  bytewise,
  collect,
  encodeFails,
  hex,
  roundtrip,
  type Standalone,
} from "./helpers.ts";

describe("Bit fields", () => {
  it.each([0, 54, -1, 1.5, Number.NaN, Infinity])(
    "reject width %s",
    (width) => {
      expect(() => bits(width as BitWidth)).toThrow(RangeError);
    },
  );

  it.each<[string, Standalone, unknown]>([
    ["standalone", bits(4), 1],
    ["in arrays", array(bits(4), 2), [1, 2]],
    ["wrapped", literal(bits(4), 1), 1],
  ])("require direct parser fields, %s", (_, codec, value) => {
    expect(() => codec.decode(Uint8Array.of(0x12))).toThrow(
      /direct parser fields/u,
    );
    expect(() => codec.encode(value as never)).toThrow(/direct parser fields/u);
    expect(() => codec.sizeOf(value as never)).toThrow(/direct parser fields/u);
  });

  it("keep a reused codec independent of its parser and bit order", async () => {
    const nibble = bits(4);
    const msb = bin().field("a", nibble).field("b", nibble);
    const lsb = bin({ bitOrder: "lsb" }).field("a", nibble).field("b", nibble);
    await roundtrip(msb, "12", { a: 1, b: 2 });
    await roundtrip(lsb, "21", { a: 1, b: 2 });
    await roundtrip(array(msb, 2), "12 34", [
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });

  it("resolve defaults and computed counts before a packed field is read", async () => {
    const counted = bin()
      .field("tag", literal(u8, 1))
      .field("count", bits(3))
      .field("flag", bits(5))
      .field("data", array(bin().u8("v"), "count"))
      .computed("count", (value) => value.data.length);
    const value = { flag: 2, data: [{ v: 7 }, { v: 8 }] };
    const wire = counted.encode(value);
    expect([...wire]).toStrictEqual([1, 0x42, 7, 8]);
    expect(counted.sizeOf(value)).toBe(4);
    await expect(collect(counted, bytewise(wire))).resolves.toStrictEqual([
      { tag: 1, count: 2, ...value },
    ]);
  });

  it.each<[name: string, codec: Standalone, bytes: string, value: unknown]>([
    [
      "share bytes, most significant bits first",
      bin()
        .field("a", bits(1))
        .field("b", bits(2))
        .field("c", bits(5))
        .field("d", bits(4)),
      "d4 f0",
      { a: 1, b: 2, c: 20, d: 0xf },
    ],
    [
      "share bytes, least significant bits first",
      bin({ bitOrder: "lsb" })
        .field("x", bits(4))
        .field("y", bits(8))
        .field("z", bits(4)),
      "21 43",
      { x: 1, y: 0x32, z: 4 },
    ],
    // #12
    [
      "have 32 bits each, in a run of 64",
      bin().field("a", bits(32)).field("b", bits(32)),
      "fffffffe 89abcdef",
      { a: 0xfffffffe, b: 0x89abcdef },
    ],
    [
      "have up to 53 bits, most significant bits first",
      bin().field("a", bits(4)).field("b", bits(44)),
      "0123456789ab",
      { a: 0, b: 0x123456789ab },
    ],
    [
      "have up to 53 bits, least significant bits first",
      bin({ bitOrder: "lsb" }).field("a", bits(4)).field("b", bits(44)),
      "ab 89 67 45 23 01",
      { a: 0xb, b: 0x123456789a },
    ],
    [
      "are followed by numbers at the next byte",
      bin().field("a", bits(3)).u8("b").field("c", bits(4)).u16be("d"),
      "e0 12 f0 3456",
      { a: 7, b: 0x12, c: 0xf, d: 0x3456 },
    ],
    [
      "continue in merged parsers",
      bin()
        .field("a", bits(4))
        .merge(bin().field("c", bits(4))),
      "12",
      { a: 1, c: 2 },
    ],
    [
      "start at a byte in nested parsers",
      bin()
        .field("a", bits(4))
        .field("n", bin().field("c", bits(4))),
      "10 20",
      { a: 1, n: { c: 2 } },
    ],
  ])("%s", (_, codec, bytes, value) => roundtrip(codec, bytes, value));

  it("ignore their padding when decoding", () => {
    expect(
      bin()
        .field("a", bits(1))
        .field("b", bits(2))
        .field("c", bits(5))
        .field("d", bits(4))
        .decode(hex("d4 ff")),
    ).toStrictEqual({ a: 1, b: 2, c: 20, d: 0xf });
  });

  it.each(["msb", "lsb"] as const)(
    "keep reused prefixes independent, %s first",
    (bitOrder) => {
      const prefix = bin({ bitOrder }).field("head", bits(3));
      const narrow = prefix.field("tail", bits(5));
      const wide = prefix.field("tail", bits(13));
      const aligned = prefix.u8("tail");
      expect([prefix.size, narrow.size, wide.size, aligned.size]).toStrictEqual(
        [1, 1, 2, 2],
      );
      expect(prefix.decode(Uint8Array.of(255))).toStrictEqual({ head: 7 });
      expect(narrow.encode({ head: 7, tail: 31 })).toStrictEqual(
        Uint8Array.of(255),
      );
      expect(wide.encode({ head: 7, tail: 8191 })).toStrictEqual(
        Uint8Array.of(255, 255),
      );
      expect(aligned.encode({ head: 7, tail: 255 })).toStrictEqual(
        Uint8Array.of(bitOrder === "msb" ? 224 : 7, 255),
      );
    },
  );

  // Runs of fields of [width, value], with fields of 32 bits at several bit offsets.
  describe.each<[name: string, fields: [BitWidth, number][]]>([
    [
      "of up to 32 bits",
      [
        [1, 1],
        [32, 0xfffffffe],
        [7, 0x7f],
        [31, 0x7ffffffe],
        [8, 0xff],
        [9, 0x1fe],
        [32, 0xffffffff],
        [1, 0],
        [32, 0xffffffff],
      ],
    ],
    [
      "of up to 53 bits",
      [
        [3, 5],
        [32, 0xfedcba98],
        [31, 0x7fffffff],
        [9, 0x155],
        [7, 0x2a],
        [8, 0xff],
        [1, 1],
        [53, Number.MAX_SAFE_INTEGER - 0x5a5a5a5a],
        [33, 2 ** 32 + 0x89abcdef],
        [48, 0xfe_dc_ba_98_76_54],
        [7, 0x41],
      ],
    ],
  ])("%s", (_, fields) => {
    it.each(["msb", "lsb"] as const)(
      "are placed bit by bit, %s first",
      async (bitOrder) => {
        type Bits = Codec<Record<string, number>> & {
          field(name: string, codec: Codec<number>): Bits;
        };
        let parser = bin({ bitOrder }) as unknown as Bits;
        const value: Record<string, number> = {};
        const total = fields.reduce((n, [width]) => n + width, 0);
        const wire = new Uint8Array(Math.ceil(total / 8));
        let offset = 0;
        for (const [i, [width, field]] of fields.entries()) {
          parser = parser.field(`f${i}`, bits(width));
          value[`f${i}`] = field;
          for (let j = 0; j < width; j++, offset++) {
            const bit =
              Math.floor(
                field / 2 ** (bitOrder === "msb" ? width - 1 - j : j),
              ) % 2;
            wire[Math.floor(offset / 8)] |=
              bit << (bitOrder === "msb" ? 7 - (offset % 8) : offset % 8);
          }
        }
        expect(parser.encode(value)).toStrictEqual(wire);
        expect(parser.decode(wire)).toStrictEqual(value);
        await expect(collect(parser, bytewise(wire))).resolves.toStrictEqual([
          value,
        ]);
      },
    );
  });

  it.each<[width: 3 | 53, value: unknown]>([
    [3, 8],
    [3, 1.5],
    [53, 2 ** 53],
  ])("of %i bits reject %s when encoding", (width, a) =>
    encodeFails(
      bin().field("a", bits(width)),
      { a },
      new RegExp(`expected an unsigned integer of ${width} bits`, "u"),
    ),
  );

  it("are decoded on their own when picked", () => {
    expect(
      bin().field("a", bits(3)).field("b", bits(5)).pick("b").decode(hex("ff")),
    ).toStrictEqual({ b: 31 });
  });

  it.each(["msb", "lsb"] as const)(
    "start at a byte in merged parsers that compute or pick fields, %s first",
    async (bitOrder) => {
      const part = bin({ bitOrder }).field("b", bits(1));
      const first = bin({ bitOrder }).field("a", bits(1));
      const plain = first.merge(part).field("c", bits(6));
      expect(plain.size).toBe(1);
      expect(plain.encode({ a: 1, b: 1, c: 1 })).toStrictEqual(
        Uint8Array.of(bitOrder === "msb" ? 193 : 7),
      );
      const wire =
        bitOrder === "msb"
          ? Uint8Array.of(128, 128, 4)
          : Uint8Array.of(1, 1, 1);
      const value = { a: 1, b: 1, c: 1 };
      const computed = first
        .merge(part.computed("b", () => 1))
        .field("c", bits(6));
      expect(computed.size).toBe(3);
      expect(computed.encode({ a: 1, c: 1 })).toStrictEqual(wire);
      expect(computed.decode(wire)).toStrictEqual(value);
      await expect(collect(computed, bytewise(wire))).resolves.toStrictEqual([
        value,
      ]);
      const picked = first.merge(part.pick("b")).field("c", bits(6));
      expect(picked.size).toBe(3);
      expect(picked.decode(wire)).toStrictEqual(value);
      await expect(collect(picked, bytewise(wire))).resolves.toStrictEqual([
        value,
      ]);
    },
  );

  it("of different orders do not share bytes", () => {
    const first = bin().field("a", bits(1));
    const part = bin({ bitOrder: "lsb" }).field("b", bits(1));
    expect(() => first.merge(part)).toThrow(/different orders/u);
    expect(
      first.merge(part.computed("b", () => 1)).encode({ a: 1 }),
    ).toStrictEqual(Uint8Array.of(128, 1));
    expect(
      first.merge(part.pick("b")).decode(Uint8Array.of(128, 1)),
    ).toStrictEqual({ a: 1, b: 1 });
  });
});
