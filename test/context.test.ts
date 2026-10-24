import { describe, expect, it } from "vitest";

import {
  array,
  bin,
  bytes,
  DecodeError,
  lazy,
  match,
  sized,
  string,
  u8,
  when,
  type Codec,
  type Output,
} from "../src/index.ts";
import {
  bytewise,
  collect,
  hex,
  roundtrip,
  type Standalone,
} from "./helpers.ts";

describe("Fields around codecs", () => {
  const Raw = bin<{ length: number }>().field("raw", bytes("length"));
  const Text = bin<{ length: number }>()
    .field(
      "text",
      string((o) => o.length - 1),
    )
    .u8("end");
  const Message = bin()
    .u8("tag")
    .u8("length")
    .merge(match("tag").case(1, Raw).case(2, Text));
  const item = bin<{ width: number }>()
    .u8("size")
    .field("data", bytes("width"))
    .field(
      "tail",
      bytes((o) => o.size),
    );

  it.each<[name: string, codec: Standalone, bytes: string, value: unknown]>([
    [
      "are read by merged parsers",
      bin().u16le("length").merge(Raw),
      "0100 ff",
      { length: 1, raw: hex("ff") },
    ],
    [
      "are read by merged cases",
      Message,
      "01 02 abcd",
      { tag: 1, length: 2, raw: hex("abcd") },
    ],
    [
      "are read by functions in merged cases",
      Message,
      "02 03 6869 07",
      { tag: 2, length: 3, text: "hi", end: 7 },
    ],
    [
      "are read by nested parsers",
      bin()
        .u8("n")
        .field(
          "inner",
          bin<{ n: number }>().field(
            "data",
            bytes((o) => o.n),
          ),
        ),
      "02 0102",
      { n: 2, inner: { data: hex("0102") } },
    ],
    [
      "are read by items",
      bin()
        .u8("size")
        .u8("count")
        .field(
          "items",
          array(
            bytes((o) => o.size),
            "count",
          ),
        ),
      "01 02 05 06",
      { size: 1, count: 2, items: [hex("05"), hex("06")] },
    ],
    [
      "are read by regions",
      bin()
        .u8("n")
        .field("region", sized(2, bytes("n"))),
      "01 0700",
      { n: 1, region: hex("07") },
    ],
    [
      "are read by items of nested arrays of regions",
      bin()
        .u8("width")
        .field("rows", array(array(sized(3, item), 2), 2)),
      "01 01 07 08 01 09 0a 01 0b 0c 01 0d 0e",
      {
        width: 1,
        rows: [
          [
            { size: 1, data: hex("07"), tail: hex("08") },
            { size: 1, data: hex("09"), tail: hex("0a") },
          ],
          [
            { size: 1, data: hex("0b"), tail: hex("0c") },
            { size: 1, data: hex("0d"), tail: hex("0e") },
          ],
        ],
      },
    ],
    [
      "are hidden by local fields of the same names",
      bin()
        .u8("n")
        .field(
          "inner",
          bin<{ n: number }>().u16le("n").field("data", bytes("n")),
        ),
      "05 0100 09",
      { n: 5, inner: { n: 1, data: hex("09") } },
    ],
  ])("%s", (_, codec, wire, value) => roundtrip(codec, wire, value));

  it("are read through arrays, regions and recursion, and hidden by local fields", async () => {
    const node = bin<{ n: number }>()
      .field("before", bytes("n"))
      .u8("n")
      .field("local", bytes("n"))
      .field(
        "child",
        bin<{ n: number }>().field(
          "raw",
          bytes((o) => o.n),
        ),
      );
    interface Tree {
      n: number;
      items: Output<typeof node>[];
      children: Tree[];
    }
    const tree: Codec<Tree> = bin()
      .u8("n")
      .field("items", array(sized(u8, node), u8))
      .field(
        "children",
        array(
          lazy(() => tree),
          u8,
        ),
      );
    const value: Tree = {
      n: 1,
      items: [
        {
          before: Uint8Array.of(3),
          n: 2,
          local: Uint8Array.of(4, 5),
          child: { raw: Uint8Array.of(6, 7) },
        },
        {
          before: Uint8Array.of(8),
          n: 0,
          local: new Uint8Array(),
          child: { raw: new Uint8Array() },
        },
      ],
      children: [
        {
          n: 2,
          items: [
            {
              before: Uint8Array.of(9, 10),
              n: 1,
              local: Uint8Array.of(11),
              child: { raw: Uint8Array.of(12) },
            },
          ],
          children: [],
        },
      ],
    };
    const wire = tree.encode(value);
    expect(tree.decode(wire)).toStrictEqual(value);
    await expect(collect(tree, bytewise(wire))).resolves.toStrictEqual([value]);
    // The same parser, as a field and as items.
    const reused = bin()
      .u8("n")
      .field("single", node)
      .field("many", array(node, 1));
    const input = { n: 1, single: value.items[0], many: [value.items[1]] };
    const encoded = reused.encode(input);
    expect(reused.decode(encoded)).toStrictEqual(input);
    await expect(
      collect(reused.pick("many"), bytewise(encoded)),
    ).resolves.toStrictEqual([{ many: input.many }]);
  });

  it("are those before, when encoding as when decoding", () => {
    const seen: string[][] = [];
    const parser = bin()
      .u8("a")
      .field(
        "b",
        bytes((o) => {
          seen.push(Object.keys(o));
          return 1;
        }),
      )
      .u8("c");
    parser.encode({ a: 1, b: hex("02"), c: 3 });
    parser.decode(hex("01 02 03"));
    expect(seen).toStrictEqual([["a"], ["a"]]);
  });

  // Codecs reading fields fail to compile where these are missing (also when they are stepped over).
  const group = bin<{ missing: number }>().field("v", when("missing", u8));

  it.each<[name: string, decode: () => unknown, message: RegExp]>([
    [
      "a field, when decoding",
      () =>
        bin()
          .field("a", bytes("n" as never))
          .decode(hex("00")),
      /`n` is not a field before `a`/u,
    ],
    [
      "a field, when encoding",
      () =>
        bin()
          .field("a", bytes("n" as never))
          .encode({ a: hex("") }),
      /`n` is not a field before `a`/u,
    ],
    [
      "a nested parser",
      () =>
        bin()
          .field("inner", group as never)
          .decode(hex("")),
      /`missing` is not a field/u,
    ],
    [
      "an array of no items",
      () =>
        bin()
          .field("inner", array(group, 0) as never)
          .decode(hex("")),
      /`missing` is not a field/u,
    ],
    [
      "a region of no bytes",
      () =>
        bin()
          .field("inner", sized(0, group) as never)
          .decode(hex("")),
      /`missing` is not a field/u,
    ],
    [
      "a nested parser that also calls a function",
      () =>
        bin()
          .field(
            "inner",
            bin<{ missing: number }>()
              .field(
                "empty",
                bytes(() => 0),
              )
              .field("v", when("missing", u8)) as never,
          )
          .decode(hex("")),
      /`missing` is not a field/u,
    ],
    [
      "a nested parser stepped over",
      () =>
        bin()
          .field(
            "inner",
            bin<{ missing: number }>().field(
              "data",
              sized(1, bytes("missing")),
            ) as never,
          )
          .pick()
          .decode(hex("00")),
      /`missing` is not a field/u,
    ],
    [
      "an array of no items stepped over",
      () =>
        bin()
          .field(
            "inner",
            bin<{ missing: number }>().field(
              "values",
              array(bytes("missing"), 0),
            ) as never,
          )
          .pick()
          .decode(hex("")),
      /`missing` is not a field/u,
    ],
  ])("must be there for %s", (_, run, message) => {
    expect(run).toThrow(message);
    expect(run).not.toThrow(DecodeError);
  });
});
