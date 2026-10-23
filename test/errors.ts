import assert from "node:assert/strict";
import { bin, custom, DecodeError, EncodeError } from "../src/index.ts";

describe("Error ownership", () => {
  it("copies constructor paths", () => {
    const path = ["x"];
    const error = new DecodeError("invalid", "bad", 1, path);
    path.push("y");
    assert.deepEqual(error.path, ["x"]);
  });

  it("rebases reused and frozen custom errors once", () => {
    const cause = new Error("cause");
    const error = Object.freeze(
      new DecodeError("invalid", "bad", 1, ["x"], cause),
    );
    const parser = bin()
      .u8("head")
      .field(
        "v",
        custom({
          decode() {
            throw error;
          },
        }),
      );
    for (let i = 0; i < 2; i++) {
      assert.throws(
        () => parser.decode(Uint8Array.of(0, 1, 2)),
        (e) =>
          e instanceof DecodeError &&
          e.offset === 2 &&
          e.path.join() === "v,x" &&
          e.cause === cause,
      );
    }
    assert.equal(error.offset, 1);
    assert.deepEqual(error.path, ["x"]);
  });

  it("prefixes reused encoding errors without changing them", () => {
    const error = Object.freeze(new EncodeError("bad"));
    const parser = bin().field(
      "v",
      custom({
        decode: () => ({ value: 1, bytesRead: 1 }),
        encode() {
          throw error;
        },
      }),
    );
    for (let i = 0; i < 2; i++)
      assert.throws(
        () => parser.encode({ v: 1 }),
        (e) => e instanceof EncodeError && e.path.join() === "v",
      );
    assert.deepEqual(error.path, []);
  });
});
