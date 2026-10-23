import assert from "node:assert/strict";
import { bin, DecodeError, EncodeError, match, u8 } from "../src/index.ts";
import { bytewise, collect } from "./helpers.ts";

describe("Computed match selectors", () => {
  it("rejects nonscalar callback results even with a fallback", async () => {
    for (const value of [undefined, null, {}, [], Symbol("tag"), () => 1]) {
      const parser = bin()
        .u8("head")
        .field("value", match(() => value as number).otherwise(u8));
      const wire = Uint8Array.of(0, 7);
      const invalid = (e: unknown) =>
        e instanceof DecodeError &&
        e.code === "invalid" &&
        e.offset === 1 &&
        e.path.join() === "value";
      assert.throws(() => parser.decode(wire), invalid);
      await assert.rejects(collect(parser, bytewise(wire)), invalid);
      assert.throws(
        () => parser.encode({ head: 0, value: 7 }),
        (e) => e instanceof EncodeError && e.path.join() === "value",
      );
    }
  });

  it("retains scalar fallback tags including NaN and infinities", () => {
    for (const tag of ["other", 3, true, 4n, NaN, Infinity]) {
      const parser = match(() => tag).otherwise(u8);
      assert.equal(parser.decode(Uint8Array.of(7)), 7);
      assert.deepEqual(parser.encode(7), Uint8Array.of(7));
    }
  });
});
