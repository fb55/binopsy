import { describe, expect, it } from "vitest";

import {
  array,
  bin,
  bytes,
  custom,
  DecodeError,
  lazy,
  literal,
  optional,
  Reader,
  sized,
  string,
  trace,
  u8,
  type Codec,
} from "../src/index.ts";
import { hex, type Standalone } from "./helpers.ts";

describe("Traces", () => {
  it("locate the fields of parsers, inlined or not", () => {
    const Item = bin().u8("kind").field("name", string(u8));
    const Packet = bin()
      .bits("version", 4)
      .bits("flags", 4)
      .field("at", bin().u8("x"))
      .field("items", array(Item, u8));
    const spans = trace(Packet, hex("ff 13 05 01 01 01 61"), 1);
    expect(
      spans.map(({ path, start, end }) => [path, start, end]),
    ).toStrictEqual([
      [["version"], 1, 2],
      [["flags"], 1, 2],
      [["at", "x"], 2, 3],
      [["at"], 2, 3],
      [["items", 0, "kind"], 4, 5],
      [["items", 0, "name"], 5, 7],
      [["items"], 3, 7],
    ]);
    expect(spans.at(-1)!.value).toStrictEqual([{ kind: 1, name: "a" }]);
  });

  it("locate fields of recursive values and regions in arrays", () => {
    interface Node {
      v: number;
      next: Node | null;
    }
    const Node: Codec<Node> = bin()
      .u8("v")
      .field(
        "next",
        optional(
          u8,
          lazy(() => Node),
        ),
      );
    const parser = bin()
      .field("node", Node)
      .field("items", array(sized(1, bin().u8("x")), 2))
      .u8("tail");
    const spans = trace(parser, hex("01 01 02 00 03 04 05"));
    expect(
      spans.map(({ path, start, end }) => [path, start, end]),
    ).toStrictEqual([
      [["node", "v"], 0, 1],
      [["node", "next", "v"], 2, 3],
      [["node", "next", "next"], 3, 4],
      [["node", "next"], 1, 4],
      [["node"], 0, 4],
      [["items", 0, "x"], 4, 5],
      [["items", 1, "x"], 5, 6],
      [["items"], 4, 6],
      [["tail"], 6, 7],
    ]);
  });

  it("locate fields in regions, and those stepped over", () => {
    const parser = bin()
      .bits("a", 8)
      .field("r", sized(1, bin().u8("b")))
      .u8("c");
    const spans = trace(parser.pick("r"), hex("01 02 03"));
    expect(spans.map(({ path, value }) => [path, value])).toStrictEqual([
      [["a"], undefined],
      [["r", "b"], 2],
      [["r"], { b: 2 }],
      [["c"], undefined],
    ]);
  });
});

describe("Readers", () => {
  it("read consecutive values", () => {
    const reader = new Reader(hex("03 616263 02 6465 00"));
    const Str = bin().u8("len").field("text", string("len"));
    const texts: string[] = [];
    while (!reader.done) texts.push(reader.read(Str).text);
    expect(texts).toStrictEqual(["abc", "de", ""]);
  });

  it("start at an offset inside the input", () => {
    expect(new Reader(hex("00 01 02"), 2).read(u8)).toBe(2);
    for (const offset of [-1, 1.5, 4]) {
      expect(() => new Reader(hex("000102"), offset)).toThrow(RangeError);
    }
  });

  it.each<[name: string, codec: Standalone]>([
    ["a check", sized(2, bin().u8("a").field("b", literal(u8, 9)))],
    [
      "a custom codec wanting more",
      sized(1, custom({ decode: () => undefined })),
    ],
  ])("stay where they were when %s fails", (_, codec) => {
    const reader = new Reader(hex("01 0203 05"));
    expect(reader.read(u8)).toBe(1);
    expect(() => reader.read(codec)).toThrow(DecodeError);
    expect(reader.offset).toBe(1);
    expect(reader.read(bytes(2))).toStrictEqual(hex("0203"));
    expect(reader.read(u8)).toBe(5);
    expect(reader.done).toBe(true);
  });

  it("read shared memory", () => {
    const shared = new Uint8Array(new SharedArrayBuffer(5));
    shared.set(hex("03 616263 09"));
    const parser = bin().field("s", string(u8)).u8("x");
    expect(parser.decode(shared)).toStrictEqual({ s: "abc", x: 9 });
    const reader = new Reader(shared, 4);
    expect(reader.read(u8)).toBe(9);
  });
});
