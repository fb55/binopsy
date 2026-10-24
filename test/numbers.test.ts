import { describe, it } from "vitest";

import { array, bin, i24be, string, u24be, u8 } from "../src/index.ts";
import { encodeFails, roundtrip, type Standalone } from "./helpers.ts";

describe("Numbers", () => {
  it.each<[name: string, codec: Standalone, bytes: string, value: unknown]>([
    [
      "are integers of 8, 16 and 32 bits, in both byte orders",
      bin()
        .u8("a")
        .i8("b")
        .u16le("c")
        .u16be("d")
        .i16le("e")
        .i16be("f")
        .u32le("g")
        .u32be("h")
        .i32le("i")
        .i32be("j"),
      "ff ff dcfe fedc feff fffe efcdab89 89abcdef eb32a4f8 fffffffe",
      {
        a: 255,
        b: -1,
        c: 0xfedc,
        d: 0xfedc,
        e: -2,
        f: -2,
        g: 0x89abcdef,
        h: 0x89abcdef,
        i: -123_456_789,
        j: -2,
      },
    ],
    [
      "are integers of 24 bits, also as lengths",
      bin()
        .u24le("a")
        .u24be("b")
        .i24le("c")
        .i24be("d")
        .field("e", string(u24be)),
      "badcfe fedcba feffff 800000 000002 6869",
      { a: 0xfedcba, b: 0xfedcba, c: -2, d: -0x800000, e: "hi" },
    ],
    [
      "are floats and 64-bit integers",
      bin().f32be("a").f64le("b").u64le("c").i64be("d"),
      "3fc00000 000000000000d0bf ffffffffffffffff 8000000000000000",
      { a: 1.5, b: -0.25, c: 2n ** 64n - 1n, d: -(2n ** 63n) },
    ],
  ])("%s", (_, codec, bytes, value) => roundtrip(codec, bytes, value));

  it("must fit their codec", () => {
    encodeFails(
      bin().field("a", array(u8, u8)),
      { a: [256] },
      /expected u8, got 256 in `a\[0\]`/u,
    );
    encodeFails(i24be, 0x800000, /expected i24be, got 8388608/u);
  });
});
