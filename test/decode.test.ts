import { describe, expect, it } from "vitest";

import {
  bin,
  bytes,
  custom,
  DecodeError,
  literal,
  Reader,
  sized,
  string,
  u8,
} from "../src/index.ts";
import { hex, type Standalone } from "./helpers.ts";

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
