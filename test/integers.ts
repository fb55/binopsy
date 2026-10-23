import assert from "node:assert/strict";
import {
  bin,
  EncodeError,
  i8,
  i16le,
  i32le,
  u8,
  u16le,
  u32le,
} from "../src/index.ts";

describe("Integer input validation", () => {
  it("locates BigInt and Symbol inputs instead of throwing coercion errors", () => {
    for (const value of [1n, Symbol("n")]) {
      for (const codec of [u8, i8, u16le, i16le, u32le, i32le]) {
        assert.throws(
          () =>
            bin()
              .field("v", codec)
              .encode({ v: value as never }),
          (e) => e instanceof EncodeError && e.path.join() === "v",
        );
      }
      for (const width of [1, 32] as const)
        assert.throws(
          () =>
            bin()
              .bits("v", width)
              .encode({ v: value as never }),
          (e) => e instanceof EncodeError && e.path.join() === "v",
        );
    }
  });
});
