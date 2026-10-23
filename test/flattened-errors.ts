import assert from "node:assert/strict";
import {
  array,
  bin,
  DecodeError,
  EncodeError,
  match,
  type Codec,
} from "../src/index.ts";
import { bytewise, collect } from "./helpers.ts";

describe("Flattened selector errors", () => {
  it("belongs to the containing record, after both ordinary and bit fields", async () => {
    const cause = new Error("selector failed");
    for (const bits of [false, true]) {
      for (const throws of [false, true]) {
        const prefix = bits ? bin().bits("head", 3) : bin().u8("head");
        const parser = prefix.merge(
          match((): number => {
            if (throws) throw cause;
            return {} as never;
          }).otherwise(bin().u8("value")),
        );
        for (const nested of [false, true]) {
          const codec: Codec<unknown, never> = nested
            ? bin().field("rows", array(parser, 1))
            : parser;
          const path = nested ? ["rows", 0] : [];
          const invalid = (error: unknown) => {
            assert.ok(error instanceof DecodeError);
            assert.equal(error.code, throws ? "error" : "invalid");
            assert.equal(error.offset, 1);
            assert.deepEqual(error.path, path);
            if (throws) assert.equal(error.cause, cause);
            return true;
          };
          const wire = Uint8Array.of(0, 7);
          assert.throws(() => codec.decode(wire), invalid);
          await assert.rejects(collect(codec, bytewise(wire)), invalid);
          const value = { head: 0, value: 7 };
          assert.throws(
            () =>
              (codec as Codec<unknown, unknown>).encode(
                nested ? { rows: [value] } : value,
              ),
            (error) => {
              assert.ok(error instanceof EncodeError);
              assert.deepEqual(error.path, path);
              if (throws) assert.equal(error.cause, cause);
              return true;
            },
          );
        }
      }
    }
  });
});
