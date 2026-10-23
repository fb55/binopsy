import assert from "node:assert/strict";
import { bin, bytes, match } from "../src/index.ts";
import { bytewise, collect } from "./helpers.ts";

describe("Picked merged cases", () => {
  it("keeps dependencies available without returning unrequested case fields", async () => {
    const group = bin()
      .u8("tag")
      .merge(match("tag").case(1, bin().u8("n")).case(2, bin().u8("n")))
      .pick("n");
    const parser = bin().merge(group).field("data", bytes("n"));
    for (const tag of [1, 2]) {
      const wire = Uint8Array.of(tag, 1, 7);
      const selected = parser.pick("data");
      const expected = { data: Uint8Array.of(7) };
      assert.deepEqual(selected.decode(wire), expected);
      assert.deepEqual(await collect(selected, bytewise(wire)), [expected]);
      assert.deepEqual(parser.pick().decode(wire), {});
      assert.deepEqual(parser.pick("n").decode(wire), { n: 1 });
    }
  });

  it("retains callback dependencies and filters nested case pieces", () => {
    const group = bin()
      .u8("outer")
      .merge(
        match("outer").case(
          1,
          bin()
            .u8("tag")
            .merge(match("tag").case(1, bin().u8("n")).case(2, bin().u8("n"))),
        ),
      )
      .pick("n");
    const parser = bin()
      .merge(group)
      .field(
        "data",
        bytes((o) => o.n),
      );
    const wire = Uint8Array.of(1, 2, 1, 7);
    assert.deepEqual(parser.pick().decode(wire), {});
    assert.deepEqual(parser.pick("data").decode(wire), {
      data: Uint8Array.of(7),
    });
  });
});
