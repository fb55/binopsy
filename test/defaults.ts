import assert from "node:assert/strict";
import { bin, bytes, lazy, literal, match, sized, u8 } from "../src/index.ts";

describe("Defaults in match branches", () => {
  it("resolves transparent wrappers before later names and callbacks", () => {
    for (const codec of [
      sized(1, literal(u8, 2)),
      lazy(() => literal(u8, 2)),
    ]) {
      const parser = bin()
        .u8("tag")
        .field("n", match("tag").case(1, codec))
        .field("data", bytes("n"))
        .field(
          "tail",
          bytes((v) => v.n),
        );
      assert.deepEqual(
        parser.encode({
          tag: 1,
          data: Uint8Array.of(7, 8),
          tail: Uint8Array.of(9, 10),
        }),
        Uint8Array.of(1, 2, 7, 8, 9, 10),
      );
    }
  });
});
