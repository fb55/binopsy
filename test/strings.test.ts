import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { bin, string, u16le, u8 } from "../src/index.ts";
import {
  collect,
  encodeFails,
  hex,
  node,
  roundtrip,
  type Standalone,
} from "./helpers.ts";

describe("Strings", () => {
  it.each<[name: string, codec: Standalone, bytes: string, value: unknown]>([
    ["take all of their length", string(3), "616263", "abc"],
    [
      "end with a terminator within their length",
      bin()
        .field("a", string(5, { terminator: 0 }))
        .field("b", string(3, { encoding: "latin1" }))
        .field("c", string(5, { terminator: 0 })),
      "6869000000 e9e9e9 c3bce282ac",
      { a: "hi", b: "ééé", c: "ü€" },
    ],
    [
      "fill their length without a terminator",
      string(2, { terminator: 0 }),
      "6869",
      "hi",
    ],
    [
      "are padded to their length",
      string(5, { padRight: 0x20 }),
      "6869202020",
      "hi",
    ],
    [
      "end with a terminator, then padding",
      string(5, { terminator: 0, padRight: 0x20 }),
      "6869002020",
      "hi",
    ],
    // With a terminator, padding is not taken off the text.
    [
      "keep padding before their terminator",
      string(4, { terminator: 0, padRight: 0x20 }),
      "68202000",
      "h  ",
    ],
    [
      "have a length from a count, a field or a function",
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
    ],
    [
      "count their terminator",
      string(u8, { terminator: 0 }),
      "03 686900",
      "hi",
    ],
    [
      "are padded to a length from a field",
      bin()
        .u8("n")
        .field("s", string("n", { padRight: 0 })),
      "03 686900",
      { n: 3, s: "hi" },
    ],
    [
      "take the rest of the input",
      bin().u8("n").field("s", string(Infinity)),
      "01 616263",
      { n: 1, s: "abc" },
    ],
    [
      "take the rest of the input, up to a terminator",
      string(Infinity, { terminator: 0x0a }),
      "68690a",
      "hi",
    ],
    [
      "end with a terminator",
      bin()
        .field("a", string({ terminator: 0 }))
        .field("b", string({ terminator: 0 }))
        .u8("c"),
      "4dc3bc6c6c657200 00 07",
      { a: "Müller", b: "", c: 7 },
    ],
    [
      "end with a terminator of any value",
      string({ terminator: 0x0a }),
      "68690a",
      "hi",
    ],
    [
      "end with a terminator within their maximum",
      string({ terminator: 0, max: 3 }),
      "686900",
      "hi",
    ],
    [
      "have no terminator at their maximum",
      string({ terminator: 0, max: 2 }),
      "6869",
      "hi",
    ],
    [
      "are followed by the next field at their maximum",
      bin()
        .field("a", string({ terminator: 0, max: 4 }))
        .field("b", string({ terminator: 0, max: 4 }))
        .field("c", string({ terminator: 0 })),
      "616200 63646566 696a00",
      { a: "ab", b: "cdef", c: "ij" },
    ],
    [
      "take no bytes with a maximum of none",
      string({ terminator: 0, max: 0 }),
      "",
      "",
    ],
    [
      "have no terminator at a maximum from a field",
      bin()
        .u8("limit")
        .field("s", string({ terminator: 0, max: "limit" })),
      "02 6869",
      { limit: 2, s: "hi" },
    ],
    [
      "end with a terminator within a maximum from a field",
      bin()
        .u8("limit")
        .field("s", string({ terminator: 0, max: "limit" })),
      "05 6800",
      { limit: 5, s: "h" },
    ],
    [
      "are in UTF-16 or ASCII",
      bin()
        .field("a", string(4, { encoding: "utf16le", terminator: 0 }))
        .field("b", string(u8, { encoding: "ascii" }))
        .field("c", string({ terminator: 0, encoding: "utf16le" })),
      "68000000 02 6869 e900 0000",
      { a: "h", b: "hi", c: "é" },
    ],
    ["are in latin1", string(2, { encoding: "latin1" }), "e980", "é\u0080"],
    ["keep byte order marks", string(3), "efbbbf", "﻿"],
    [
      "keep byte order marks and unpaired surrogates in UTF-16",
      string(4, { encoding: "utf16le" }),
      "fffe00d8",
      "﻿\uD800",
    ],
    // UTF-8 text is written first (with room for 3 bytes per UTF-16 unit, if there is).
    [
      "are written before their count",
      string(u16le),
      "0a00 68c3a96c6c6f20e282ac",
      "héllo €",
    ],
    [
      "are written before their count, with characters beyond 16 bits",
      string(u8),
      "04 f09d849e",
      "\u{1D11E}",
    ],
    [
      "take the rest of the input, with characters of several bytes",
      string(Infinity),
      "e282ac61",
      "€a",
    ],
  ])("%s", (_, codec, bytes, value) => roundtrip(codec, bytes, value));

  it.each<[name: string, codec: Standalone, bytes: string, text: string]>([
    [
      "ignore the bytes after their terminator",
      string(5, { terminator: 0 }),
      "6869007878",
      "hi",
    ],
    [
      "keep their padding without a terminator",
      string(4, { terminator: 0, padRight: 0x20 }),
      "68202020",
      "h   ",
    ],
    // Units, not bytes, end UTF-16 strings.
    [
      "end with a terminator of 16 bits in UTF-16",
      string({ terminator: 0, encoding: "utf16le" }),
      "00010000",
      "Ā",
    ],
    [
      "ignore the high bit in ASCII",
      string(1, { encoding: "ascii" }),
      "e1",
      "a",
    ],
  ])("%s", (_, codec, bytes, text) => {
    expect(codec.decode(hex(bytes))).toBe(text);
  });

  it("are written before their count, also when longer than the room left", () => {
    const long = "é".repeat(5000);
    expect(string(u16le).decode(string(u16le).encode(long))).toBe(long);
  });

  it("replace unpaired surrogates in UTF-8", () => {
    expect(string(u8).encode("\uD800")).toStrictEqual(hex("03 efbfbd"));
  });

  it("are written into a given buffer, if they fit", () => {
    const bytes = new Uint8Array(4);
    expect(string(u8).encodeInto("abc", bytes)).toBe(4);
    expect(bytes).toStrictEqual(hex("03 616263"));
    expect(() => string(u8).encodeInto("abcd", bytes)).toThrow(/does not fit/u);
  });

  it.each<[name: string, codec: Standalone, text: string, message: RegExp]>([
    [
      "must fill their length",
      string(3),
      "ab",
      /has 2 bytes, but its length is 3/u,
    ],
    [
      "must fit their length",
      string(2),
      "abc",
      /has 3 bytes, more than its length 2/u,
    ],
    [
      "must not contain their terminator",
      string(3, { terminator: 0 }),
      "a\0",
      /contains its terminator/u,
    ],
    [
      "must not contain the terminator that ends them",
      string({ terminator: 0x0a }),
      "a\nb",
      /contains its terminator/u,
    ],
    [
      "must not end with their padding",
      string(3, { padRight: 0x20 }),
      "a ",
      /ends with its padding/u,
    ],
    // These have delimiter bytes inside encoded characters.
    [
      "must not contain their terminator in a character",
      string({ terminator: 0xa9 }),
      "©",
      /contains its terminator/u,
    ],
    [
      "must not end with their padding in a character",
      string(2, { padRight: 0xa9 }),
      "é",
      /ends with its padding/u,
    ],
    [
      "must fit their maximum",
      string({ terminator: 0, max: 2 }),
      "abc",
      /more than its maximum 2/u,
    ],
    [
      "must fit the codec of their count",
      string(u8),
      "a".repeat(256),
      /expected u8, got 256/u,
    ],
    [
      "must be in latin1",
      string(1, { encoding: "latin1" }),
      "€",
      /is not latin1/u,
    ],
    [
      "must be in ASCII",
      string(2, { encoding: "ascii" }),
      "é",
      /is not ascii/u,
    ],
  ])("%s", (_, codec, text, message) => encodeFails(codec, text, message));

  const byField = string({ terminator: 0, max: "n", encoding: "utf16le" });
  const byFunction = string({
    terminator: 0,
    max: (o: { n: number }) => o.n,
    encoding: "utf16le",
  });

  it.each<[name: string, text: typeof byField | typeof byFunction]>([
    ["a field", byField],
    ["a function", byFunction],
  ])("have a maximum from %s, in UTF-16 and across chunks", async (_, text) => {
    const parser = bin().u8("n").field("text", text).u8("tail");
    for (const [wire, value] of [
      [Uint8Array.of(0, 9), { n: 0, text: "", tail: 9 }],
      [Uint8Array.of(4, 65, 0, 0, 0, 9), { n: 4, text: "A", tail: 9 }],
      [Uint8Array.of(2, 65, 0, 9), { n: 2, text: "A", tail: 9 }],
    ] as const) {
      expect(parser.encode(value)).toStrictEqual(wire);
      for (let i = 0; i <= wire.length; i++) {
        const chunks = [wire.subarray(0, i), wire.subarray(i)];
        await expect(collect(parser, chunks)).resolves.toStrictEqual([value]);
      }
    }
    expect(() => parser.decode(Uint8Array.of(3, 0, 0, 0))).toThrow(
      /odd length/u,
    );
  });

  it("decode and encode the same without Buffer", () => {
    const fixture = new URL("fixtures/text-fallback.mjs", import.meta.url);
    expect(node(fileURLToPath(fixture))).toMatch(/passed/u);
  });
});
