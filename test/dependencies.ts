import assert from "node:assert/strict";
import {
  array,
  bin,
  bytes,
  DecodeError,
  sized,
  u8,
  when,
  type Codec,
} from "../src/index.ts";

describe("Named dependency resolution", () => {
  it("rejects unresolved names inside nested compiled functions", () => {
    const group = bin<{ missing: number }>().field("v", when("missing", u8));
    for (const codec of [group, array(group, 0), sized(0, group)]) {
      const parser = bin().field("inner", codec as unknown as Codec<unknown>);
      assert.throws(
        () => parser.decode(new Uint8Array()),
        (e) =>
          e instanceof Error &&
          !(e instanceof DecodeError) &&
          /missing/.test(e.message),
      );
    }
  });

  it("retains names alongside callback requirements", () => {
    const group = bin<{ missing: number }>()
      .field(
        "empty",
        bytes(() => 0),
      )
      .field("v", when("missing", u8));
    const parser = bin().field("inner", group as unknown as Codec<unknown>);
    assert.throws(() => parser.decode(new Uint8Array()), /missing/);
    const attached = bin().u8("missing").field("inner", group);
    assert.deepEqual(attached.decode(Uint8Array.of(1, 7)), {
      missing: 1,
      inner: { empty: new Uint8Array(), v: 7 },
    });
  });
});
