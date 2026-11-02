import { describe, expect, it } from "vitest";

import {
  array,
  bin,
  bits,
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
import { collect, decodeError, hex, type Standalone } from "./helpers.ts";

describe("Traces", () => {
  it("locate the fields of parsers, inlined or not", () => {
    const Item = bin().u8("kind").field("name", string(u8));
    const Packet = bin()
      .field("version", bits(4))
      .field("flags", bits(4))
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
      .field("a", bits(8))
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
  it("locate truncated skipped spans like fully decoded spans", () => {
    const codec = bin().u32le("id").field("text", string(u8)).u16le("tail");
    const encoded = codec.encode({ id: 9, text: "abc", tail: 42 });
    const skipped = codec.pick();
    for (let end = 0; end < encoded.length; end++) {
      const input = encoded.subarray(0, end);
      let failure: unknown;
      try {
        codec.decode(input);
      } catch (e) {
        failure = e;
      }
      expect(() => skipped.decode(input)).toThrow(failure);
    }
  });

  it("keep offsets and bounds relative to slices sharing a buffer", async () => {
    const codec = bin().u16le("a").u32be("b").f32le("c");
    const values = [
      { a: 1, b: 0xfedcba98, c: 1.5 },
      { a: 0xabcd, b: 0x01020304, c: -2.25 },
    ];
    const storage = new Uint8Array(40).fill(0xff);
    const first = storage.subarray(3, 13);
    const second = storage.subarray(23, 33);
    codec.encodeInto(values[0], first);
    codec.encodeInto(values[1], second);
    expect(codec.decode(first)).toStrictEqual(values[0]);
    expect(codec.decode(second)).toStrictEqual(values[1]);
    expect(sized(10, codec).decode(second)).toStrictEqual(values[1]);
    expect(lazy(() => codec).decode(first)).toStrictEqual(values[0]);
    expect(codec.decode(storage.subarray(1, 13), 2)).toStrictEqual(values[0]);
    expect(new Reader(second).read(codec)).toStrictEqual(values[1]);
    expect(codec.pick("b").decode(first)).toStrictEqual({ b: values[0].b });
    expect(
      trace(codec, second).map(({ start, end }) => [start, end]),
    ).toStrictEqual([
      [0, 2],
      [2, 6],
      [6, 10],
    ]);
    expect(() => codec.decode(first.subarray(0, 5))).toThrow(
      decodeError({
        code: "end-of-input",
        path: ["b"],
        offset: 2,
        message: /4 bytes needed, 3 left/u,
      }),
    );
    await expect(
      collect(codec, [first.subarray(0, 4), first.subarray(4), second]),
    ).resolves.toStrictEqual(values);
  });

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

  it("move to an offset that is set", () => {
    const reader = new Reader(hex("01 02 03"));
    reader.offset = 2;
    expect(reader.read(u8)).toBe(3);
    reader.offset = 0;
    expect(reader.read(u8)).toBe(1);
    for (const offset of [-1, 1.5, 4]) {
      expect(() => (reader.offset = offset)).toThrow(RangeError);
    }
    expect(reader.offset).toBe(1);
  });

  it("decode bytes of a Buffer to Buffers", () => {
    const parser = bin().u8("n").field("b", bytes("n"));
    const input = Buffer.from([2, 7, 8]);
    expect(Buffer.isBuffer(parser.decode(input).b)).toBe(true);
    expect(Buffer.isBuffer(new Reader(input).read(parser).b)).toBe(true);
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

describe("Exact decoding", () => {
  const Str = bin().u8("len").field("text", string("len"));

  it("decodes a value that ends the bytes, also from an offset", () => {
    expect(Str.decodeExact(hex("02 6162"))).toStrictEqual({
      len: 2,
      text: "ab",
    });
    expect(Str.decodeExact(hex("ffff 00"), 2)).toStrictEqual({
      len: 0,
      text: "",
    });
    expect(Str.pick("text").decodeExact(hex("01 61"))).toStrictEqual({
      text: "a",
    });
  });

  it("fails at the first byte after the value", () => {
    expect(() => Str.decodeExact(hex("01 61 62"))).toThrow(
      decodeError({
        code: "invalid",
        path: [],
        offset: 2,
        message: /^1 byte after the value at offset 2$/u,
      }),
    );
    expect(() => u8.decodeExact(hex("01 0203"))).toThrow(
      decodeError({
        code: "invalid",
        offset: 1,
        message: /^2 bytes after the value/u,
      }),
    );
  });

  it("fails as decode does inside the value", () => {
    expect(() => Str.decodeExact(hex("05 61"))).toThrow(
      decodeError({ code: "end-of-input", path: ["text"], offset: 1 }),
    );
    expect(() => u8.decodeExact(hex("00"), 2)).toThrow(RangeError);
  });
});
