import assert from "node:assert/strict";
import { array, bin, bytes, DecodeError, Reader } from "../src/index.ts";
import { collect } from "./helpers.ts";

describe("Safe numeric bounds", () => {
  it("rejects coerced strings and booleans as dynamic counts", () => {
    for (const value of [true, "1", null]) {
      assert.throws(
        () => bytes(() => value as never).decode(Uint8Array.of(7)),
        (e) => e instanceof DecodeError && e.code === "invalid",
      );
    }
  });

  it("rejects unsafe constant products at definition", () => {
    assert.throws(
      () => array(bytes(2), Number.MAX_SAFE_INTEGER),
      /safe integer/,
    );
    assert.deepEqual(
      bin()
        .field("items", array(bytes(0), 2 ** 32 + 1))
        .pick()
        .decode(new Uint8Array()),
      {},
    );
  });

  it("rejects unsafe products and offsets in normal and resumed decoding", async () => {
    const parser = bin()
      .field(
        "items",
        array(bytes(2), () => Number.MAX_SAFE_INTEGER),
      )
      .pick();
    const invalid = (e: unknown) =>
      e instanceof DecodeError && e.code === "invalid";
    assert.throws(() => parser.decode(new Uint8Array()), invalid);
    await assert.rejects(collect(parser, [Uint8Array.of(1)]), invalid);
    const reader = new Reader(Uint8Array.of(1), 1);
    assert.throws(() => reader.read(bytes(Number.MAX_SAFE_INTEGER)), invalid);
    assert.equal(reader.offset, 1);
  });
});
