import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { custom, type Codec } from "../src/index.ts";
import { node } from "./helpers.ts";

describe("Examples", () => {
  it("decode and encode u32 values with the varint of the README, and reject others", () => {
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
    expect(codec.decode(Uint8Array.of(255, 255, 255, 255, 15))).toBe(
      0xffffffff,
    );
    expect(codec.encode(0xffffffff)).toStrictEqual(
      Uint8Array.of(255, 255, 255, 255, 15),
    );
    expect(() => codec.decode(Uint8Array.of(255, 255, 255, 255, 127))).toThrow(
      /exceeds u32/u,
    );
    // Invalid values throw, rather than loop forever.
    for (const value of [-1, Infinity, Number.NaN, 2 ** 32, 1.5]) {
      expect((): unknown =>
        runInNewContext(
          "codec.encode(value)",
          { codec, value },
          { timeout: 50 },
        ),
      ).toThrow(/unsigned 32-bit/u);
    }
  });

  it("pack a file into a tar archive with a valid checksum, and list it", () => {
    const dir = mkdtempSync(join(tmpdir(), "binopsy-tar-"));
    try {
      const file = join(dir, "file.txt");
      const archive = join(dir, "archive.tar");
      const example = fileURLToPath(
        new URL("../examples/tar.ts", import.meta.url),
      );
      writeFileSync(file, "hello");
      node(example, "pack", archive, file);
      const wire = readFileSync(archive);
      expect(wire).toHaveLength(2048);
      expect(wire.subarray(512, 517).toString()).toBe("hello");
      const sum = wire
        .subarray(0, 512)
        .reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
      expect(Number.parseInt(wire.subarray(148, 156).toString(), 8)).toBe(sum);
      // Two blocks of zeros end the archive.
      expect(wire.subarray(1024).every((b) => b === 0)).toBe(true);
      expect(node(example, "list", archive)).toMatch(/0 5 .*file\.txt/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
