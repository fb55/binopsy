import assert from "node:assert/strict";
import {
  array,
  bin,
  bytes,
  f64le,
  literal,
  map,
  optional,
  refine,
  sized,
  string,
  u16be,
  u16le,
  u8,
} from "../src/index.ts";
import { bytewise, collect, hex } from "./helpers.ts";

describe("Regions", () => {
  it("write their size after their value, through any codec of a fixed size", async () => {
    // A size in units of 2 bytes.
    const halves = map(u8, {
      decode: (n) => n * 2,
      encode: (n: number) => n / 2,
    });
    const parser = bin()
      .field("a", sized(halves, string(Infinity)))
      .field("b", sized(u16be, bytes(Infinity)))
      .u8("end");
    const value = { a: "abcd", b: hex("0102"), end: 9 };
    const encoded = parser.encode(value);
    assert.deepEqual(encoded, hex("02 61626364 0002 0102 09"));
    assert.deepEqual(parser.decode(encoded), value);
    assert.deepEqual(await collect(parser, bytewise(encoded)), [value]);
    // Writers growing in the middle of a region.
    const big = new Uint8Array(5000).fill(7);
    const Big = sized(u16le, bytes(Infinity));
    assert.ok(Buffer.compare(Big.decode(Big.encode(big)), big) === 0);
  });

  it("pad values to their size, and reject bigger ones", () => {
    const parser = bin()
      .u8("n")
      .field("v", sized("n", array(u8, Infinity)));
    assert.deepEqual(parser.encode({ n: 3, v: [1] }), hex("03 01 0000"));
    assert.throws(
      () => parser.encode({ n: 1, v: [1, 2] }),
      /needs 2 bytes, more than its size 1 in `v`/,
    );
    assert.throws(
      () => sized(string({ terminator: 0 }) as never, u8),
      /fixed size/,
    );
  });
});

describe("Literals", () => {
  it("compare as Object.is", () => {
    const zero = literal(f64le, -0);
    assert.ok(Object.is(zero.decode(zero.encode(undefined)), -0));
    assert.throws(() => zero.decode(f64le.encode(0)), /expected 0, got 0/);
    const nan = literal(f64le, NaN);
    assert.ok(Number.isNaN(nan.decode(nan.encode(undefined))));
    assert.throws(
      () => literal(u8, {} as never),
      /must be a string, number, bigint or boolean/,
    );
  });
});

describe("Optional values", () => {
  it("are null, never undefined, and write flags 0 and 1", () => {
    const parser = bin().field("a", optional(u8, u16le));
    assert.deepEqual(parser.encode({ a: null }), hex("00"));
    assert.deepEqual(parser.encode({ a: 2 }), hex("01 0200"));
    assert.deepEqual(parser.decode(hex("07 0200")), { a: 2 });
    assert.throws(
      () => parser.encode({ a: undefined as never }),
      /expected a value, or null in `a`/,
    );
  });
});

describe("Refinements", () => {
  it("check values when decoding and encoding", () => {
    const Status = refine(
      u8,
      (n): n is 1 | 2 => n === 1 || n === 2,
      "expected status 1 or 2",
    );
    assert.equal(Status.decode(hex("02")), 2);
    assert.throws(() => Status.decode(hex("03")), /expected status 1 or 2/);
    assert.throws(() => Status.encode(3 as never), /expected status 1 or 2/);
  });
});
