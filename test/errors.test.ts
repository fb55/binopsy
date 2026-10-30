import { describe, expect, it } from "vitest";

import {
  array,
  bin,
  bits,
  bytes,
  DecodeError,
  lazy,
  literal,
  map,
  refine,
  sized,
  string,
  u16le,
  u8,
  type Codec,
} from "../src/index.ts";
import { decodeFails, hex, type Failure, type Standalone } from "./helpers.ts";

const Item = bin().u8("kind").field("name", string(u8));
const Point = bin().u8("x").field("y", literal(u8, 1));
// Parsers of a fixed size, whose code is inlined in that of the parsers they are in.
const Shape = bin()
  .u16le("id")
  .field("center", bin().field("at", Point))
  .field("points", array(Point, u8));
function thrown(f: () => unknown): { path: unknown } {
  try {
    f();
  } catch (e) {
    return e as { path: unknown };
  }
  throw new Error("did not throw");
}
// Errors in it pass through a call for each level.
interface Tree {
  "a b": number;
  kids: Tree[];
}
const Tree: Codec<Tree> = bin()
  .u8("a b")
  .field(
    "kids",
    array(
      lazy(() => Tree),
      u8,
    ),
  );
const cause = new Error("bad");
const fails = () => {
  throw cause;
};

describe("Decoding errors", () => {
  it.each<
    [
      name: string,
      codec: Standalone,
      code: "invalid" | "error",
      cause?: unknown,
    ]
  >([
    ["literals of regions", literal(sized(2, u8), 7), "invalid"],
    ["literal strings", literal(string(u8), "a"), "invalid"],
    ["refined strings", refine(string(u8), () => false), "invalid"],
    [
      "strings that functions convert",
      map(string(u8), { decode: fails }),
      "error",
      cause,
    ],
    ["strings that functions check", refine(string(u8), fails), "error", cause],
  ])("are located at the start of %s", (_, codec, code, reason) =>
    decodeFails(bin().u8("h").field("v", codec), "00 01 62", {
      code,
      path: ["v"],
      offset: 1,
      ...(reason === undefined ? {} : { cause: reason }),
    }),
  );

  it.each(["msb", "lsb"] as const)(
    "are located in bit fields sharing bytes, %s first",
    (bitOrder) =>
      decodeFails(
        bin({ bitOrder }).u8("head").field("a", bits(4)).field("b", bits(12)),
        "09 01",
        { code: "end-of-input", path: ["b"], offset: 1 },
      ),
  );

  it.each<[name: string, codec: Standalone, bytes: string, failure: Failure]>([
    [
      "are located in the first field",
      bin().u32le("id").field("items", array(Item, u8)),
      "010000",
      { code: "end-of-input", path: ["id"], offset: 0 },
    ],
    [
      "are located in bit fields",
      bin().u8("x").field("a", bits(4)).field("b", bits(4)).field("c", bits(8)),
      "09 01",
      { code: "end-of-input", path: ["c"], offset: 2 },
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
      { code: "invalid", message: /unexpected end of its region .* in `a`/u },
    ],
    [
      "quote names that are not identifiers",
      bin().field("a b", bin().field("c.d", literal(u8, 1))),
      "02",
      { message: /expected 1, got 2 in `\["a b"\]\["c.d"\]` at offset 0/u },
    ],
    [
      "locate errors in recursive values",
      Tree,
      "01 01 01 02 01 00",
      { message: /in `kids\[0\]\.kids\[1\]\["a b"\]` at offset 6$/u },
    ],
  ])("%s", (_, codec, wire, failure) => decodeFails(codec, wire, failure));

  it("are located at the path they are given, also when it changes later", () => {
    const path = ["first"];
    const first = new DecodeError("invalid", "bad", 0, path);
    path[0] = "second";
    const second = new DecodeError("invalid", "bad", 0, path);
    expect(first.message).toBe("bad in `first` at offset 0");
    expect(second.message).toBe("bad in `second` at offset 0");
  });

  it("have paths that cannot change, so that their messages stay right", () => {
    const leaf = { "a b": 1, kids: [] };
    const paths = [
      new DecodeError("invalid", "bad", 0, ["a"]).path,
      thrown(() => Tree.decode(hex("01 01 01 02 01 00"))).path,
      thrown(() =>
        Tree.encode({ ...leaf, kids: [{ ...leaf, kids: 7 }] } as never),
      ).path,
    ];
    for (const path of paths) expect(Object.isFrozen(path)).toBe(true);
  });
});

describe("Encoding errors", () => {
  const shape = {
    id: 7,
    center: { at: { x: 5 } },
    points: [{ x: 9 }, { x: 8 }],
  };

  it.each<[name: string, value: typeof shape, path: (string | number)[]]>([
    [
      "are located in inlined parsers",
      { ...shape, center: { at: { x: 256 } } },
      ["center", "at", "x"],
    ],
    [
      "are located in items of inlined parsers",
      { ...shape, points: [{ x: 9 }, { x: 256 }] },
      ["points", 1, "x"],
    ],
  ])("%s", (_, value, path) => {
    expect(() => Shape.encode(value)).toThrow(
      expect.objectContaining({ name: "EncodeError", path }),
    );
  });

  it("are located in recursive values", () => {
    const leaf = { "a b": 1, kids: [] };
    const value = {
      ...leaf,
      kids: [{ ...leaf, kids: [leaf, { ...leaf, kids: 7 }] }],
    };
    expect(() => Tree.encode(value as never)).toThrow(
      expect.objectContaining({
        path: ["kids", 0, "kids", 1, "kids"],
        message: "expected an array, got 7 in `kids[0].kids[1].kids`",
      }),
    );
  });
});
