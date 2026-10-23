import assert from "node:assert/strict";
import { bin, match } from "../src/index.ts";
import { bytewise, collect } from "./helpers.ts";

describe("Documented definition policies", () => {
  for (const bitOrder of ["msb", "lsb"] as const) {
    it(`aligns finalized and picked ${bitOrder} merges on both sides`, async () => {
      const part = bin({ bitOrder }).bits("b", 1);
      const first = bin({ bitOrder }).bits("a", 1);
      const plain = first.merge(part).bits("c", 6);
      assert.equal(plain.size, 1);
      assert.deepEqual(
        plain.encode({ a: 1, b: 1, c: 1 }),
        Uint8Array.of(bitOrder === "msb" ? 193 : 7),
      );
      const group = part.computed("b", () => 1);
      const finalized = first.merge(group).bits("c", 6);
      const wire =
        bitOrder === "msb"
          ? Uint8Array.of(128, 128, 4)
          : Uint8Array.of(1, 1, 1);
      const expected = { a: 1, b: 1, c: 1 };
      assert.equal(finalized.size, 3);
      assert.deepEqual(finalized.encode({ a: 1, c: 1 }), wire);
      assert.deepEqual(finalized.decode(wire), expected);
      assert.deepEqual(await collect(finalized, bytewise(wire)), [expected]);
      const picked = first.merge(part.pick("b")).bits("c", 6);
      assert.equal(picked.size, 3);
      assert.deepEqual(picked.decode(wire), expected);
      assert.deepEqual(await collect(picked, bytewise(wire)), [expected]);
    });
  }

  it("allows independent orders across aligned groups, but rejects adjoining plain runs", () => {
    const part = bin({ bitOrder: "lsb" }).bits("b", 1);
    const first = bin().bits("a", 1);
    assert.throws(() => first.merge(part), /different orders/);
    assert.deepEqual(
      first.merge(part.computed("b", () => 1)).encode({ a: 1 }),
      Uint8Array.of(128, 1),
    );
    assert.deepEqual(
      first.merge(part.pick("b")).decode(Uint8Array.of(128, 1)),
      { a: 1, b: 1 },
    );
  });

  it("allows repeated names within one match, and rejects repeats across matches", () => {
    const first = bin()
      .u8("tag")
      .merge(match("tag").case(1, bin().u8("x")).case(2, bin().u8("y")));
    assert.throws(
      () =>
        first.merge(match("tag").case(1, bin().u8("z")).case(2, bin().u8("x"))),
      /duplicate field `x`/,
    );
    const one = bin()
      .u8("tag")
      .merge(match("tag").case(1, bin().u8("x")).case(2, bin().u16le("x")));
    assert.deepEqual(one.decode(Uint8Array.of(2, 7, 0)), { tag: 2, x: 7 });
  });
});
