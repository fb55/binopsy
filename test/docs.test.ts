import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  array,
  bin,
  bytes,
  custom,
  match,
  sized,
  string,
  u16be,
  u8,
  type Codec,
} from "../src/index.ts";
import { node } from "./helpers.ts";

describe("Examples", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const varint = readme
    .slice(readme.indexOf("// Variable-length integers"))
    .split("```")[0]
    .replace("encode(value: number)", "encode(value)");

  it("decode and encode u32 values with the varint of the README, and reject others", () => {
    const codec = runInNewContext(`${varint}\nvarint`, {
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

  it("encode to the bytes the README shows", () => {
    const context = createContext({
      array,
      bin,
      bytes,
      crc32,
      custom,
      match,
      sized,
      string,
      u16be,
      u8,
      Uint8Array,
    });
    runInContext(varint, context);
    for (const name of [
      "Chunk",
      "Message",
      "Frame",
      "WritableChunk",
      "Entry",
    ]) {
      const declaration = new RegExp(
        String.raw`^const ${name} = [\s\S]*?;(?: //.*)?$`,
        "mu",
      ).exec(readme);
      runInContext(declaration![0], context);
    }
    const examples = readme.matchAll(
      /^(?<call>\w+\.encode\(.*\));(?: |\n)\/\/ Uint8Array (?<shown>\[[\d, ]+\])/gmu,
    );
    const outputs = [...examples].map((example) => {
      const { call, shown } = example.groups as Record<
        "call" | "shown",
        string
      >;
      return [
        [...(runInContext(call, context) as Uint8Array)],
        JSON.parse(shown) as number[],
      ];
    });
    expect(outputs).toHaveLength(3);
    for (const [actual, shown] of outputs) expect(actual).toStrictEqual(shown);
  });

  const example = fileURLToPath(new URL("../examples/tar.ts", import.meta.url));

  it("pack a directory into a tar archive with a valid checksum, and list it", () => {
    const dir = mkdtempSync(join(tmpdir(), "binopsy-tar-"));
    try {
      const file = join(dir, "file.txt");
      const archive = join(dir, "archive.tar");
      writeFileSync(file, "hello");
      writeFileSync(archive, ""); // From before: left out of the archive
      node(example, "pack", archive, dir);
      const wire = readFileSync(archive);
      // The directory, the file and its data, and the end.
      expect(wire).toHaveLength(2560);
      expect(wire.subarray(1024, 1029).toString()).toBe("hello");
      const sum = wire
        .subarray(0, 512)
        .reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
      expect(Number.parseInt(wire.subarray(148, 156).toString(), 8)).toBe(sum);
      // Two blocks of zeros end the archive.
      expect(wire.subarray(1536).every((b) => b === 0)).toBe(true);
      const listing = node(example, "list", archive);
      expect(listing).toMatch(/0 5 .*file\.txt/u);
      expect(listing).not.toMatch(/archive\.tar/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("archive links as links, and list names with control characters escaped", () => {
    const dir = mkdtempSync(join(tmpdir(), "binopsy-tar-"));
    try {
      const tree = join(dir, "tree");
      const archive = join(dir, "archive.tar");
      mkdirSync(tree);
      symlinkSync(".", join(tree, "loop")); // Followed, it would never end
      writeFileSync(join(tree, "a\u001B[2Kb\nc"), "");
      node(example, "pack", archive, tree);
      const listing = node(example, "list", archive);
      expect(listing).toMatch(/^2 0 .*\/loop$/mu);
      expect(listing).toContain(String.raw`a\u001b[2Kb\u000ac`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
