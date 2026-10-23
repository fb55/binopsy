import assert from "node:assert/strict";
import { custom, DecodeError, type DecodeResult } from "../src/index.ts";

describe("Custom result shape", () => {
  it("requires a value member, including for a successful undefined", () => {
    assert.throws(
      () =>
        custom({
          decode: () => ({ bytesRead: 1 }) as DecodeResult<undefined>,
        }).decode(Uint8Array.of(1)),
      (e) => e instanceof DecodeError && e.code === "invalid",
    );
    assert.equal(
      custom({ decode: () => ({ value: undefined, bytesRead: 1 }) }).decode(
        Uint8Array.of(1),
      ),
      undefined,
    );
  });
});
