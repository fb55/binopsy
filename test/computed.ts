import assert from "node:assert/strict";
import { bin, match } from "../src/index.ts";

describe("Computed values across groups", () => {
  it("supplies common fields of flattened cases", () => {
    const parser = bin()
      .u8("tag")
      .merge(match("tag").case(1, bin().u8("n")).case(2, bin().bits("n", 8)))
      .computed("n", () => 7);
    for (const tag of [1, 2] as const) {
      assert.deepEqual(
        parser.encode(Object.freeze({ tag })),
        Uint8Array.of(tag, 7),
      );
      assert.throws(
        () => parser.encode({ tag, n: 8 as never }),
        /computed as 7/,
      );
    }
  });

  it("supplies input to an independently finalized merged group", () => {
    const group = bin()
      .u8("n")
      .u8("x")
      .computed("x", (v) => v.n + 1);
    const parser = bin()
      .merge(group)
      .computed("n", () => 7);
    assert.deepEqual(parser.encode({}), Uint8Array.of(7, 8));
  });

  it("checks computations of the same field at both levels", () => {
    const group = bin()
      .u8("n")
      .computed("n", () => 1);
    assert.deepEqual(
      bin()
        .merge(group)
        .computed("n", () => 1)
        .encode({}),
      Uint8Array.of(1),
    );
    assert.throws(
      () =>
        bin()
          .merge(group)
          .computed("n", () => 2 as never)
          .encode({} as never),
      /computed as 1/,
    );
  });
});
