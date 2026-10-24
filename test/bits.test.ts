import { describe, expect, it } from "vitest";

import { bin, type Codec } from "../src/index.ts";
import {
  bytewise,
  collect,
  encodeFails,
  hex,
  roundtrip,
  type Standalone,
} from "./helpers.ts";

describe("Bit fields", () => {
  it.each<[name: string, codec: Standalone, bytes: string, value: unknown]>([
    [
      "share bytes, most significant bits first",
      bin().bits("a", 1).bits("b", 2).bits("c", 5).bits("d", 4),
      "d4 f0",
      { a: 1, b: 2, c: 20, d: 0xf },
    ],
    [
      "share bytes, least significant bits first",
      bin({ bitOrder: "lsb" }).bits("x", 4).bits("y", 8).bits("z", 4),
      "21 43",
      { x: 1, y: 0x32, z: 4 },
    ],
    // #12
    [
      "have 32 bits each, in a run of 64",
      bin().bits("a", 32).bits("b", 32),
      "fffffffe 89abcdef",
      { a: 0xfffffffe, b: 0x89abcdef },
    ],
    [
      "have up to 53 bits, most significant bits first",
      bin().bits("a", 4).bits("b", 44),
      "0123456789ab",
      { a: 0, b: 0x123456789ab },
    ],
    [
      "have up to 53 bits, least significant bits first",
      bin({ bitOrder: "lsb" }).bits("a", 4).bits("b", 44),
      "ab 89 67 45 23 01",
      { a: 0xb, b: 0x123456789a },
    ],
    [
      "are followed by numbers at the next byte",
      bin().bits("a", 3).u8("b").bits("c", 4).u16be("d"),
      "e0 12 f0 3456",
      { a: 7, b: 0x12, c: 0xf, d: 0x3456 },
    ],
    [
      "continue in merged parsers",
      bin().bits("a", 4).merge(bin().bits("c", 4)),
      "12",
      { a: 1, c: 2 },
    ],
    [
      "start at a byte in nested parsers",
      bin().bits("a", 4).field("n", bin().bits("c", 4)),
      "10 20",
      { a: 1, n: { c: 2 } },
    ],
  ])("%s", (_, codec, bytes, value) => roundtrip(codec, bytes, value));

  it("ignore their padding when decoding", () => {
    expect(
      bin()
        .bits("a", 1)
        .bits("b", 2)
        .bits("c", 5)
        .bits("d", 4)
        .decode(hex("d4 ff")),
    ).toStrictEqual({ a: 1, b: 2, c: 20, d: 0xf });
  });

  it.each(["msb", "lsb"] as const)(
    "keep reused prefixes independent, %s first",
    (bitOrder) => {
      const prefix = bin({ bitOrder }).bits("head", 3);
      const narrow = prefix.bits("tail", 5);
      const wide = prefix.bits("tail", 13);
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
  describe.each<[name: string, fields: [number, number][]]>([
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
          bits(name: string, width: number): Bits;
        };
        let parser = bin({ bitOrder }) as unknown as Bits;
        const value: Record<string, number> = {};
        const bits = fields.reduce((n, [width]) => n + width, 0);
        const wire = new Uint8Array(Math.ceil(bits / 8));
        let offset = 0;
        for (const [i, [width, field]] of fields.entries()) {
          parser = parser.bits(`f${i}`, width);
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
      bin().bits("a", width),
      { a },
      new RegExp(`expected an unsigned integer of ${width} bits`, "u"),
    ),
  );

  it("are decoded on their own when picked", () => {
    expect(
      bin().bits("a", 3).bits("b", 5).pick("b").decode(hex("ff")),
    ).toStrictEqual({ b: 31 });
  });

  it.each(["msb", "lsb"] as const)(
    "start at a byte in merged parsers that compute or pick fields, %s first",
    async (bitOrder) => {
      const part = bin({ bitOrder }).bits("b", 1);
      const first = bin({ bitOrder }).bits("a", 1);
      const plain = first.merge(part).bits("c", 6);
      expect(plain.size).toBe(1);
      expect(plain.encode({ a: 1, b: 1, c: 1 })).toStrictEqual(
        Uint8Array.of(bitOrder === "msb" ? 193 : 7),
      );
      const wire =
        bitOrder === "msb"
          ? Uint8Array.of(128, 128, 4)
          : Uint8Array.of(1, 1, 1);
      const value = { a: 1, b: 1, c: 1 };
      const computed = first.merge(part.computed("b", () => 1)).bits("c", 6);
      expect(computed.size).toBe(3);
      expect(computed.encode({ a: 1, c: 1 })).toStrictEqual(wire);
      expect(computed.decode(wire)).toStrictEqual(value);
      await expect(collect(computed, bytewise(wire))).resolves.toStrictEqual([
        value,
      ]);
      const picked = first.merge(part.pick("b")).bits("c", 6);
      expect(picked.size).toBe(3);
      expect(picked.decode(wire)).toStrictEqual(value);
      await expect(collect(picked, bytewise(wire))).resolves.toStrictEqual([
        value,
      ]);
    },
  );

  it("of different orders do not share bytes", () => {
    const first = bin().bits("a", 1);
    const part = bin({ bitOrder: "lsb" }).bits("b", 1);
    expect(() => first.merge(part)).toThrow(/different orders/u);
    expect(
      first.merge(part.computed("b", () => 1)).encode({ a: 1 }),
    ).toStrictEqual(Uint8Array.of(128, 1));
    expect(
      first.merge(part.pick("b")).decode(Uint8Array.of(128, 1)),
    ).toStrictEqual({ a: 1, b: 1 });
  });
});
