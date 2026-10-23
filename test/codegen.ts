import assert from "node:assert/strict";
import { array, bin, bytes, sized } from "../src/index.ts";
import { bytewise, collect } from "./helpers.ts";

describe("Shared array prefix objects", () => {
  it("keeps outer and local values correct through nested loops and regions", async () => {
    const item = bin<{ width: number }>()
      .u8("size")
      .field("data", bytes("width"))
      .field(
        "tail",
        bytes((o) => o.size),
      );
    const parser = bin()
      .u8("width")
      .field("rows", array(array(sized(3, item), 2), 2));
    const wire = Uint8Array.of(1, 1, 7, 8, 1, 9, 10, 1, 11, 12, 1, 13, 14);
    const value = parser.decode(wire);
    assert.equal(value.rows[1][1].tail[0], 14);
    assert.deepEqual(parser.encode(value), wire);
    assert.deepEqual(await collect(parser, bytewise(wire)), [value]);
  });
});
