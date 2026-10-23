import assert from "node:assert/strict";
import {
  array,
  bin,
  bytes,
  custom,
  match,
  string,
  u8,
  when,
} from "../src/index.ts";

describe("Immutable validated definitions", () => {
  it("snapshots until options before compiling either direction", () => {
    const options = { until: (n: number): boolean => n === 1 };
    const codec = array(u8, options);
    options.until = (n) => n === 2;
    assert.deepEqual(codec.decode(Uint8Array.of(1, 2)), [1]);
    assert.deepEqual(codec.encode([1]), Uint8Array.of(1));
  });

  it("rejects unknown and conflicting options", () => {
    assert.throws(() => bin({ bitOdrer: "lsb" } as never), /unknown option/);
    assert.throws(
      () => string({ terminator: 0 }, {} as never),
      /second argument/,
    );
    assert.throws(
      () => custom({ decode: () => undefined, szie: 1 } as never),
      /unknown option/,
    );
  });

  it("accepts the empty field name consistently", () => {
    assert.deepEqual(
      bin().u8("").field("v", bytes("")).decode(Uint8Array.of(1, 7)),
      { "": 1, v: Uint8Array.of(7) },
    );
    assert.deepEqual(
      bin().u8("").field("v", when("", u8)).decode(Uint8Array.of(1, 7)),
      { "": 1, v: 7 },
    );
    assert.deepEqual(
      bin()
        .u8("")
        .field("v", match("").case(1, u8))
        .decode(Uint8Array.of(1, 7)),
      { "": 1, v: 7 },
    );
  });
});
