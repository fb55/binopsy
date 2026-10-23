import assert from "node:assert/strict";
import {
  array,
  bin,
  bytes,
  DecodeError,
  Reader,
  sized,
  type Codec,
} from "../src/index.ts";
import { bytewise, collect } from "./helpers.ts";

describe("Selection validation", () => {
  it("retains region bounds inside skipped fixed-size parsers and arrays", async () => {
    const child = bin()
      .u8("n")
      .field("data", sized(1, bytes("n")));
    for (const field of [child, array(child, 1)] as Codec<unknown, never>[]) {
      const parser = bin().u8("head").field("inner", field).pick();
      const wire = Uint8Array.of(9, 2, 0);
      const invalid = (e: unknown) =>
        e instanceof DecodeError &&
        e.code === "end-of-input" &&
        e.offset === 2 &&
        e.path[0] === "inner" &&
        e.path.at(-1) === "data";
      assert.throws(() => parser.decode(wire), invalid);
      const reader = new Reader(wire);
      assert.throws(() => reader.read(parser), invalid);
      assert.equal(reader.offset, 0);
      await assert.rejects(collect(parser, bytewise(wire)), invalid);
      assert.deepEqual(parser.decode(Uint8Array.of(9, 1, 0)), {});
    }
  });

  it("checks impossible fixed children even when an enclosing array is skipped", () => {
    const parser = bin()
      .field("data", array(sized(1, bytes(2)), 1))
      .pick();
    assert.throws(() => parser.decode(Uint8Array.of(0)), DecodeError);
  });

  it("resolves named dependencies even in skipped fixed-size subplans", () => {
    const child = bin<{ missing: number }>().field(
      "data",
      sized(1, bytes("missing")),
    );
    const parser = bin()
      .field("inner", child as unknown as Codec<unknown>)
      .pick();
    assert.throws(
      () => parser.decode(Uint8Array.of(0)),
      (e) =>
        e instanceof Error &&
        !(e instanceof DecodeError) &&
        /missing/.test(e.message),
    );
  });

  it("resolves dependencies before skipping zero-length nested plans", () => {
    const child = bin<{ missing: number }>().field(
      "values",
      array(bytes("missing"), 0),
    );
    const parser = bin()
      .field("inner", child as unknown as Codec<unknown>)
      .pick();
    assert.throws(() => parser.decode(new Uint8Array()), /missing/);
  });
});
