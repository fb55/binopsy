import assert from "node:assert/strict";
import {
  bin,
  DecodeError,
  literal,
  map,
  refine,
  sized,
  string,
  u8,
} from "../src/index.ts";
import { bytewise, collect } from "./helpers.ts";

describe("Variable-width validation offsets", () => {
  it("locates literal and refinement failures at the value start", async () => {
    const cases = [
      bin()
        .u8("h")
        .field("v", literal(sized(2, u8), 7)),
      bin()
        .u8("h")
        .field("v", literal(string(u8), "a")),
      bin()
        .u8("h")
        .field(
          "v",
          refine(string(u8), () => false),
        ),
    ];
    const wire = Uint8Array.of(0, 1, 98);
    for (const codec of cases) {
      const located = (e: unknown) =>
        e instanceof DecodeError && e.offset === 1 && e.path.join() === "v";
      assert.throws(() => codec.decode(wire), located);
      await assert.rejects(collect<unknown>(codec, bytewise(wire)), located);
    }
  });

  it("locates thrown conversion and predicate errors at the value start", () => {
    const cause = new Error("bad");
    const fails = () => {
      throw cause;
    };
    for (const codec of [
      map(string(u8), { decode: fails }),
      refine(string(u8), fails),
    ]) {
      assert.throws(
        () =>
          bin()
            .u8("h")
            .field("v", codec)
            .decode(Uint8Array.of(0, 1, 98)),
        (e) => e instanceof DecodeError && e.offset === 1 && e.cause === cause,
      );
    }
  });
});
