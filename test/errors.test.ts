import { describe, expect, it } from "vitest";

import {
  array,
  bin,
  bytes,
  literal,
  map,
  refine,
  sized,
  string,
  u16le,
  u8,
} from "../src/index.ts";
import { decodeFails, type Failure, type Standalone } from "./helpers.ts";

const Item = bin().u8("kind").field("name", string(u8));
const Point = bin().u8("x").field("y", literal(u8, 1));
// Parsers of a fixed size, whose code is inlined in that of the parsers they are in.
const Shape = bin()
  .u16le("id")
  .field("center", bin().field("at", Point))
  .field("points", array(Point, u8));
const cause = new Error("bad");
const fails = () => {
  throw cause;
};

describe("Decoding errors", () => {
  it.each<[name: string, codec: Standalone, bytes: string, failure: Failure]>([
    [
      "are located in the first field",
      bin().u32le("id").field("items", array(Item, u8)),
      "010000",
      { code: "end-of-input", path: ["id"], offset: 0 },
    ],
    [
      "are located in items",
      bin().u32le("id").field("items", array(Item, u8)),
      "01000000 02 01 01 61 02 02",
      { code: "end-of-input", path: ["items", 1, "name"], offset: 10 },
    ],
    [
      "are located in inlined parsers",
      Shape,
      "0700 05 02 00",
      { code: "invalid", path: ["center", "at", "y"], offset: 3 },
    ],
    [
      "are located in items of inlined parsers",
      Shape,
      "0700 05 01 02 0901 0800",
      { code: "invalid", path: ["points", 1, "y"], offset: 8 },
    ],
    // The input ends in the items, which are checked at once.
    [
      "are located in arrays of inlined parsers",
      Shape,
      "0700 05 01 02 0901 08",
      { code: "end-of-input", message: /in `points/u },
    ],
    [
      "are located at the start of literals of regions",
      bin()
        .u8("h")
        .field("v", literal(sized(2, u8), 7)),
      "00 01 62",
      { code: "invalid", path: ["v"], offset: 1 },
    ],
    [
      "are located at the start of literal strings",
      bin()
        .u8("h")
        .field("v", literal(string(u8), "a")),
      "00 01 62",
      { code: "invalid", path: ["v"], offset: 1 },
    ],
    [
      "are located at the start of refined strings",
      bin()
        .u8("h")
        .field(
          "v",
          refine(string(u8), () => false),
        ),
      "00 01 62",
      { code: "invalid", path: ["v"], offset: 1 },
    ],
    [
      "are located at the start of strings that functions convert",
      bin()
        .u8("h")
        .field("v", map(string(u8), { decode: fails })),
      "00 01 62",
      { code: "error", path: ["v"], offset: 1, cause },
    ],
    [
      "are located at the start of strings that functions check",
      bin()
        .u8("h")
        .field("v", refine(string(u8), fails)),
      "00 01 62",
      { code: "error", path: ["v"], offset: 1, cause },
    ],
    [
      "report invalid values",
      bin().field(
        "a",
        refine(u8, (v) => v < 3, "too big"),
      ),
      "03",
      { code: "invalid", message: /too big in `a` at offset 0/u },
    ],
    [
      "report errors thrown by functions",
      bin().field(
        "a",
        map(u8, {
          decode: () => {
            throw new Error("oops");
          },
        }),
      ),
      "01",
      { code: "error", message: /oops in `a` at offset 0/u },
    ],
    [
      "report negative lengths",
      bin()
        .u8("n")
        .field(
          "a",
          bytes((o) => o.n - 2),
        ),
      "01",
      { code: "invalid", message: /invalid length -1 in `a`/u },
    ],
    [
      "report lengths that are not numbers",
      bin().field(
        "a",
        bytes(() => "1" as never),
      ),
      "07",
      { code: "invalid", path: ["a"] },
    ],
    [
      "report the end of the input before a terminator",
      bin().field("a", string({ terminator: 0 })),
      "6162",
      { code: "end-of-input", message: /unexpected end of input .* in `a`/u },
    ],
    [
      "report the end of the input before a terminator or maximum",
      bin().field("a", string({ terminator: 0, max: 4 })),
      "6162",
      { code: "end-of-input", path: ["a"] },
    ],
    [
      "report the end of the input before the item ending an array",
      bin().field("a", array(u8, { until: (v) => v === 0 })),
      "01 02",
      { code: "end-of-input", message: /unexpected end .* in `a\[2\]`/u },
    ],
    [
      "report items of no bytes in arrays without a length",
      bin().field("a", array(bin(), Infinity)),
      "00",
      { code: "invalid", message: /an item took no bytes in `a\[0\]`/u },
    ],
    [
      "report the end of a region in its value",
      bin().field("a", sized(1, u16le)).u8("b"),
      "00 00",
      { code: "end-of-input", message: /unexpected end .* in `a`/u },
    ],
    [
      "quote names that are not identifiers",
      bin().field("a b", bin().field("c.d", literal(u8, 1))),
      "02",
      { message: /expected 1, got 2 in `\["a b"\]\["c.d"\]` at offset 0/u },
    ],
  ])("%s", (_, codec, wire, failure) => decodeFails(codec, wire, failure));
});

describe("Encoding errors", () => {
  const shape = {
    id: 7,
    center: { at: { x: 5 } },
    points: [{ x: 9 }, { x: 8 }],
  };

  it.each<[name: string, value: unknown, path: (string | number)[]]>([
    [
      "are located in inlined parsers",
      { ...shape, center: { at: { x: 256 } } },
      ["center", "at", "x"],
    ],
    [
      "are located at inlined parsers",
      { ...shape, center: { at: 1 } },
      ["center", "at"],
    ],
    [
      "are located in items of inlined parsers",
      { ...shape, points: [{ x: 9 }, { x: 8, y: 2 }] },
      ["points", 1, "y"],
    ],
  ])("%s", (_, value, path) => {
    expect(() => Shape.encode(value as never)).toThrow(
      expect.objectContaining({ name: "EncodeError", path }),
    );
  });
});
