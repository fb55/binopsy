import { describe, expect, it } from "vitest";

import {
  array,
  bin,
  bytes,
  i16le,
  map,
  Reader,
  sized,
  string,
  u16be,
  u16le,
  u8,
} from "../src/index.ts";
import {
  collect,
  decodeError,
  encodeFails,
  hex,
  roundtrip,
  type Standalone,
} from "./helpers.ts";

type Case = [name: string, codec: Standalone, bytes: string, value: unknown];
type Invalid = [
  name: string,
  codec: Standalone,
  value: unknown,
  message: RegExp,
];

describe("Bytes", () => {
  it.each<Case>([
    [
      "have a length, a count or a field",
      bin()
        .field("a", bytes(2))
        .field("b", bytes(u8))
        .u8("n")
        .field("c", bytes("n")),
      "dead 01be 02 beef",
      { a: hex("dead"), b: hex("be"), n: 2, c: hex("beef") },
    ],
    [
      "take the rest of the input",
      bin().u8("n").field("rest", bytes(Infinity)),
      "01 dead",
      { n: 1, rest: hex("dead") },
    ],
  ])("%s", (_, codec, wire, value) => roundtrip(codec, wire, value));

  it("must have their length when encoding", () => {
    encodeFails(
      bin().field("a", bytes(2)),
      { a: hex("010203") },
      /has 3 bytes, but its length is 2 in `a`/u,
    );
  });
});

describe("Arrays", () => {
  const Pair = bin().u8("key").i16le("value");
  const until = array(u8, { until: (v) => v === 0 });

  it.each<Case>([
    [
      "have a length, a count or a field",
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
    ],
    [
      "contain arrays and strings",
      bin()
        .field("rows", array(array(u8, u8), 2))
        .field("names", array(string(u8), u8)),
      "02 0102 00 02 01 61 00",
      { rows: [[1, 2], []], names: ["a", ""] },
    ],
    [
      "count items of no bytes beyond the input's size",
      bin()
        .u8("n")
        .field("a", array(bytes("n"), u8)),
      "00 03",
      { n: 0, a: [new Uint8Array(), new Uint8Array(), new Uint8Array()] },
    ],
    [
      "take the rest of the input",
      bin().u8("n").field("rest", array(u16le, Infinity)),
      "01 0200 0300",
      { n: 1, rest: [2, 3] },
    ],
    [
      "end with an item",
      bin().field("a", until).u8("b"),
      "07 ff 00 09",
      { a: [7, 255, 0], b: 9 },
    ],
    [
      "may have items of no bytes, with a length",
      array(bytes(0), 2),
      "",
      [new Uint8Array(), new Uint8Array()],
    ],
  ])("%s", (_, codec, wire, value) => roundtrip(codec, wire, value));

  it.each<Invalid>([
    [
      "must have their length when encoding",
      bin().u8("n").field("a", array(u8, "n")),
      { n: 2, a: [1] },
      /has 1 items, but its length is 2 in `a`/u,
    ],
    [
      "must end with their last item when encoding",
      bin().field("a", until),
      { a: [7] },
      /the last item does not end the array in `a\[0\]`/u,
    ],
    [
      "must end only with their last item when encoding",
      bin().field("a", until),
      { a: [0, 7] },
      /an item before the last ends the array in `a\[0\]`/u,
    ],
    [
      "must have an item ending them when encoding",
      bin().field("a", until),
      { a: [] },
      /needs an item ending it in `a`/u,
    ],
  ])("%s", (_, codec, value, message) => encodeFails(codec, value, message));
});

describe("Regions", () => {
  // A size in units of 2 bytes.
  const halves = map(u8, {
    decode: (n) => n * 2,
    encode: (n: number) => n / 2,
  });

  it.each<Case>([
    [
      "have a size, a count or a field",
      bin()
        .field("a", sized(4, bin().u8("x")))
        .field("b", sized(u16le, string(Infinity)))
        .u8("n")
        .field("c", sized("n", array(u8, Infinity))),
      "01000000 0300 616263 02 0506",
      { a: { x: 1 }, b: "abc", n: 2, c: [5, 6] },
    ],
    [
      "have their size written after their value, by any codec of a fixed size",
      bin()
        .field("a", sized(halves, string(Infinity)))
        .field("b", sized(u16be, bytes(Infinity)))
        .u8("end"),
      "02 61626364 0002 0102 09",
      { a: "abcd", b: hex("0102"), end: 9 },
    ],
  ])("%s", (_, codec, wire, value) => roundtrip(codec, wire, value));

  it("pad values to their size, and reject bigger ones", () => {
    const parser = bin()
      .u8("n")
      .field("v", sized("n", array(u8, Infinity)));
    expect(parser.encode({ n: 3, v: [1] })).toStrictEqual(hex("03 01 0000"));
    encodeFails(
      parser,
      { n: 1, v: [1, 2] },
      /needs 2 bytes, more than its size 1 in `v`/u,
    );
  });
});

describe("Lengths", () => {
  it("must be safe integers when multiplied by item sizes, and at most 2^32 - 1 items", () => {
    expect(() => array(bytes(2), Number.MAX_SAFE_INTEGER)).toThrow(
      /safe integer/u,
    );
    // Any number of items of no bytes takes no bytes.
    expect(
      bin()
        .field("items", array(bytes(0), 2 ** 32 + 1))
        .pick()
        .decode(new Uint8Array()),
    ).toStrictEqual({});
    // Arrays of them have at most 2^32 - 1.
    expect(() => array(bytes(0), 2 ** 32 + 1).decode(new Uint8Array())).toThrow(
      decodeError({ code: "invalid", message: /more than 2\^32 - 1 items/u }),
    );
  });

  it("must be safe integers when decoding, also in streams and readers", async () => {
    const parser = bin()
      .field(
        "items",
        array(bytes(2), () => Number.MAX_SAFE_INTEGER),
      )
      .pick();
    const invalid = decodeError({ code: "invalid" });
    expect(() => parser.decode(new Uint8Array())).toThrow(invalid);
    await expect(collect(parser, [Uint8Array.of(1)])).rejects.toThrow(invalid);
    const reader = new Reader(Uint8Array.of(1), 1);
    expect(() => reader.read(bytes(Number.MAX_SAFE_INTEGER))).toThrow(invalid);
    expect(reader.offset).toBe(1);
  });
});
