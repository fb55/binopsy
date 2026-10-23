import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  array,
  bin,
  bytes,
  custom,
  DecodeError,
  lazy,
  map,
  optional,
  Reader,
  sized,
  string,
  u8,
  u32le,
  type Codec,
} from "../src/index.ts";
import { bytewise, collect } from "./helpers.ts";

const node = (...args: string[]) =>
  execFileSync("timeout", ["120", process.execPath, ...args], {
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=1536" },
    encoding: "utf8",
  });

describe("Conformance matrix", () => {
  it("uses the same text rules without Buffer in a fresh process", () => {
    assert.match(
      node(
        fileURLToPath(new URL("fixtures/text-fallback.mjs", import.meta.url)),
      ),
      /matrix passed/,
    );
  });

  it("bounds UTF-16 terminators by named and callback maxima on every split", async () => {
    for (const text of [
      string({ terminator: 0, max: "n", encoding: "utf16le" }),
      string({
        terminator: 0,
        max: (o: { n: number }) => o.n,
        encoding: "utf16le",
      }),
    ]) {
      const parser = bin().u8("n").field("text", text).u8("tail");
      for (const [wire, value] of [
        [Uint8Array.of(0, 9), { n: 0, text: "", tail: 9 }],
        [Uint8Array.of(4, 65, 0, 0, 0, 9), { n: 4, text: "A", tail: 9 }],
        [Uint8Array.of(2, 65, 0, 9), { n: 2, text: "A", tail: 9 }],
      ] as const) {
        assert.deepEqual(parser.encode(value), wire);
        for (let i = 0; i <= wire.length; i++)
          assert.deepEqual(
            await collect(parser, [wire.subarray(0, i), wire.subarray(i)]),
            [value],
          );
      }
      assert.throws(
        () => parser.decode(Uint8Array.of(3, 0, 0, 0)),
        /odd length/,
      );
    }
    assert.throws(
      () => string(2, { terminator: 0xa9 }).encode("é"),
      /terminator/,
    );
    assert.throws(() => string(2, { padRight: 0xa9 }).encode("é"), /padding/);
  });

  it("backpatches mapped prefixes across writer growth from a nonzero pool base", () => {
    const payload = new Uint8Array(70_000).fill(17);
    let writes = 0;
    const inner = custom({
      decode: (b) => ({ value: b, bytesRead: b.length }),
      encode: (b: Uint8Array) => {
        writes++;
        return b;
      },
    });
    const count = map(u32le, {
      decode: (n) => n - 1,
      encode: (n: number) => n + 1,
    });
    const codec = bin()
      .u8("head")
      .field("body", sized(count, inner))
      .u8("tail");
    const previous = u8.encode(123);
    const wire = codec.encode({ head: 7, body: payload, tail: 9 });
    assert.equal(writes, 1);
    assert.equal(previous[0], 123);
    assert.equal(wire.length, payload.length + 6);
    assert.equal(
      new DataView(wire.buffer, wire.byteOffset).getUint32(1, true),
      payload.length + 1,
    );
    assert.equal(wire.at(-1), 9);
    assert.equal(Buffer.compare(codec.decode(wire).body, payload), 0);
  });

  it("rolls back mutually recursive descendants after compilation failure", () => {
    interface A {
      stop: number;
      child: B | null;
      later: number;
    }
    interface B {
      child: A | null;
    }
    for (const encode of [false, true]) {
      let ready = false;
      const b: Codec<B> = bin().field(
        "child",
        optional(
          u8,
          lazy(() => a),
        ),
      );
      const a: Codec<A> = bin()
        .u8("stop")
        .field(
          "child",
          optional(
            u8,
            lazy(() => b),
          ),
        )
        .field(
          "later",
          lazy(() => {
            if (!ready) throw new Error("not ready");
            return u8;
          }),
        );
      for (let i = 0; i < 2; i++)
        assert.throws(
          () =>
            encode
              ? a.encode({ stop: 0, child: null, later: 7 })
              : a.decode(new Uint8Array()),
          /not ready/,
        );
      ready = true;
      const wire = Uint8Array.of(1, 0, 0, 7);
      const value = { child: { stop: 0, child: null, later: 7 } };
      assert.deepEqual(b.decode(wire), value);
      assert.deepEqual(b.encode(value), wire);
    }
  });

  it("checks long 32-bit runs against independent bit placement", async () => {
    const widths = [1, 32, 7, 31, 8, 9, 32, 1, 32];
    for (const bitOrder of ["msb", "lsb"] as const) {
      type BitBuilder = Codec<Record<string, number>> & {
        bits(name: string, width: number): BitBuilder;
      };
      let parser = bin({ bitOrder }) as unknown as BitBuilder;
      const value: Record<string, number> = {};
      const wire = new Uint8Array(
        Math.ceil(widths.reduce((a, b) => a + b, 0) / 8),
      );
      let offset = 0;
      widths.forEach((width, i) => {
        parser = parser.bits(`f${i}`, width as 32);
        value[`f${i}`] = 2 ** width - 1 - (i % 2);
        for (let j = 0; j < width; j++, offset++) {
          const bit =
            Math.floor(
              value[`f${i}`] / 2 ** (bitOrder === "msb" ? width - 1 - j : j),
            ) % 2;
          wire[Math.floor(offset / 8)] |=
            bit << (bitOrder === "msb" ? 7 - (offset % 8) : offset % 8);
        }
      });
      assert.deepEqual(parser.encode(value), wire);
      assert.deepEqual(parser.decode(wire), value);
      assert.deepEqual(await collect(parser, bytewise(wire)), [value]);
    }
  });

  it("preserves yielded byte views and rolls back a failed custom region", async () => {
    const records = await collect(
      bytes(u8),
      bytewise(Uint8Array.of(2, 7, 8, 2, 9, 10, 2, 11, 12)),
    );
    assert.deepEqual(
      records.map((b) => [...b]),
      [
        [7, 8],
        [9, 10],
        [11, 12],
      ],
    );
    const reader = new Reader(Uint8Array.of(1, 2, 3));
    reader.read(u8);
    assert.throws(
      () => reader.read(sized(1, custom({ decode: () => undefined }))),
      DecodeError,
    );
    assert.equal(reader.offset, 1);
    assert.equal(reader.read(u8), 2);
    assert.equal(reader.read(u8), 3);
    assert.ok(reader.done);
  });

  it("enforces until termination and progress but permits finite zero-size items", () => {
    const codec = array(u8, { until: (n) => n === 0 });
    assert.deepEqual(codec.decode(Uint8Array.of(7, 0, 9)), [7, 0]);
    assert.throws(() => codec.decode(Uint8Array.of(7)), DecodeError);
    for (const values of [[], [7], [0, 7]])
      assert.throws(() => codec.encode(values));
    assert.throws(
      () => array(bytes(0), Infinity).decode(Uint8Array.of(1)),
      /no bytes/,
    );
    assert.equal(array(bytes(0), 2).decode(new Uint8Array()).length, 2);
  });

  it("packs a small tar fixture with a valid checksum and two zero blocks", () => {
    const dir = mkdtempSync(join(tmpdir(), "binopsy-review-"));
    try {
      const file = join(dir, "file.txt");
      const archive = join(dir, "archive.tar");
      const example = fileURLToPath(
        new URL("../examples/tar.ts", import.meta.url),
      );
      writeFileSync(file, "hello");
      node(example, "pack", archive, file);
      const wire = readFileSync(archive);
      assert.equal(wire.length, 2048);
      assert.equal(wire.subarray(512, 517).toString(), "hello");
      const sum = wire
        .subarray(0, 512)
        .reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
      assert.equal(Number.parseInt(wire.subarray(148, 156).toString(), 8), sum);
      assert.ok(wire.subarray(1024).every((b) => b === 0));
      assert.match(node(example, "list", archive), /0 5 .*file\.txt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
