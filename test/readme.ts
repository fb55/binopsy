import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { custom, type Codec } from "../src/index.ts";

describe("README custom codec", () => {
  it("implements its declared u32 domain without looping on invalid inputs", () => {
    const readme = readFileSync(
      new URL("../README.md", import.meta.url),
      "utf8",
    );
    const example = readme
      .slice(readme.indexOf("// Variable-length integers"))
      .split("```")[0]
      .replace("encode(value: number)", "encode(value)");
    const codec = runInNewContext(`${example}\nvarint`, {
      custom,
      Uint8Array,
    }) as Codec<number>;
    assert.equal(
      codec.decode(Uint8Array.of(255, 255, 255, 255, 15)),
      0xffffffff,
    );
    assert.deepEqual(
      codec.encode(0xffffffff),
      Uint8Array.of(255, 255, 255, 255, 15),
    );
    assert.throws(
      () => codec.decode(Uint8Array.of(255, 255, 255, 255, 127)),
      /exceeds u32/,
    );
    for (const value of [-1, Infinity, NaN, 2 ** 32, 1.5])
      assert.throws(
        () =>
          runInNewContext(
            "codec.encode(value)",
            { codec, value },
            { timeout: 50 },
          ),
        /unsigned 32-bit/,
      );
  });
});
