import assert from "node:assert/strict";
import {
  array,
  bin,
  bytes,
  custom,
  decodeStream,
  DecodeError,
  EncodeError,
  lazy,
  literal,
  Reader,
  sized,
  string,
  u32le,
  u8,
  type Codec,
} from "../src/index.ts";
import { bytewise, collect, hex } from "./helpers.ts";

describe("Custom codecs", () => {
  // LEB128: 7 bits a byte, the last without its high bit.
  const varint = custom({
    decode(bytes, final) {
      let value = 0;
      for (let i = 0; i < bytes.length && i < 5; i++) {
        value += (bytes[i] & 0x7f) * 2 ** (7 * i);
        if (bytes[i] < 0x80) return { value, bytesRead: i + 1 };
      }
      if (!final && bytes.length < 5) return undefined;
      throw new Error("invalid varint");
    },
    encode(value: number) {
      const out = [];
      do {
        out.push((value % 128) | (value >= 128 ? 0x80 : 0));
        value = Math.floor(value / 128);
      } while (value);
      return Uint8Array.from(out);
    },
  });

  it("decode and encode with functions, also in streams", async () => {
    const parser = bin().field("n", varint).field("data", bytes("n")).u8("end");
    const value = { n: 300, data: new Uint8Array(300).fill(1), end: 9 };
    const encoded = parser.encode(value);
    assert.deepEqual(encoded.subarray(0, 2), hex("ac02"));
    assert.equal(encoded.length, 303);
    const decoded = parser.decode(encoded);
    assert.equal(decoded.n, 300);
    assert.equal(decoded.end, 9);
    const streamed = await collect(parser, bytewise(encoded));
    assert.equal(streamed.length, 1);
    assert.equal(streamed[0].n, 300);
  });

  it("are checked, and locate their errors", () => {
    const broken = custom({ decode: () => ({ value: 1, bytesRead: 9 }) });
    assert.throws(
      () => bin().u8("a").field("b", broken).decode(hex("00 01")),
      (e) =>
        e instanceof DecodeError &&
        /bytesRead 9/.test(e.message) &&
        e.path.join() === "b",
    );
    assert.throws(
      () => bin().u8("a").field("b", varint).decode(hex("00 ffffffffff")),
      (e) =>
        e instanceof DecodeError &&
        e.code === "error" &&
        /invalid varint in `b`/.test(e.message),
    );
    const fixed = custom({
      size: 2,
      decode: (b) => ({ value: b[0] + b[1], bytesRead: 2 }),
      encode: (v: number) => Uint8Array.of(v, 0, 0),
    });
    assert.equal(fixed.decode(hex("0102")), 3);
    assert.throws(() => fixed.encode(1), /returned 3 bytes, but the size is 2/);
    assert.throws(
      () => (broken as Codec<number>).encode(1),
      /can only be decoded/,
    );
    assert.throws(
      () => custom({ size: -1, decode: () => undefined }),
      /invalid size -1/,
    );
  });

  it("encode to buffers of their own (not shared memory)", () => {
    const shared = custom({
      size: 1,
      decode: (b) => ({ value: b[0], bytesRead: 1 }),
      encode: (v: number) => new Uint8Array(new SharedArrayBuffer(1)).fill(v),
    });
    const bytes = shared.encode(7);
    assert.ok(bytes.buffer instanceof ArrayBuffer);
    assert.deepEqual(bytes, hex("07"));
  });
});

describe("Readers", () => {
  it("stay where they were when reading fails", () => {
    const reader = new Reader(hex("01 0203 05"));
    assert.equal(reader.read(u8), 1);
    assert.throws(() =>
      reader.read(sized(2, bin().u8("a").field("b", literal(u8, 9)))),
    );
    assert.equal(reader.offset, 1);
    assert.deepEqual(reader.read(bytes(2)), hex("0203"));
    assert.equal(reader.read(u8), 5);
    assert.ok(reader.done);
  });
});

describe("Offsets", () => {
  it("are checked", () => {
    for (const offset of [-1, 1.5, NaN, Infinity, 5]) {
      assert.throws(() => u8.decode(hex("00"), offset), RangeError);
      assert.throws(
        () => u8.encodeInto(1, new Uint8Array(4), offset),
        RangeError,
      );
    }
    assert.equal(u8.encodeInto(1, new Uint8Array(4), 3), 4);
  });
});

describe("Lazy codecs", () => {
  it("can be compiled again after compiling failed", () => {
    let fail = true;
    const parser = bin()
      .u8("n")
      .field(
        "items",
        array(
          lazy(() => {
            if (fail) throw new Error("not ready");
            return bin().u8("x");
          }),
          "n",
        ),
      );
    assert.throws(() => parser.decode(hex("01 07")), /not ready/);
    fail = false;
    assert.deepEqual(parser.decode(hex("01 07")), { n: 1, items: [{ x: 7 }] });
  });
});

describe("Error paths", () => {
  it("quote names that are not identifiers", () => {
    const parser = bin().field("a b", bin().field("c.d", literal(u8, 1)));
    assert.throws(
      () => parser.decode(hex("02")),
      /expected 1, got 2 in `\["a b"\]\["c.d"\]` at offset 0/,
    );
    assert.throws(
      () => parser.encode({ "a b": { "c.d": 2 as never } }),
      (e) => e instanceof EncodeError && e.path.join("/") === "a b/c.d",
    );
  });
});

describe("Stream lifecycles", () => {
  it("close the source when decoding fails", async () => {
    let closed = 0;
    function* chunks() {
      try {
        yield hex("01 02 03");
        yield hex("04");
      } finally {
        closed++;
      }
    }
    const parser = bin().field("a", literal(u8, 1));
    await assert.rejects(
      collect(parser, chunks()),
      /expected 1, got 2 in `a` at offset 1/,
    );
    assert.equal(closed, 1);
  });

  it("keep the errors of their source", async () => {
    const oops = new Error("oops");
    async function* chunks() {
      yield hex("01");
      throw oops;
    }
    await assert.rejects(collect(u32le, chunks()), (e) => e === oops);
  });

  it("stop when returned, while a chunk is awaited", async () => {
    let release!: () => void;
    let returned = 0;
    const source: AsyncIterator<Uint8Array> & AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () =>
        new Promise((resolve) => {
          release = () => resolve({ value: hex("01020304"), done: false });
        }),
      return: async () => {
        returned++;
        return { value: undefined, done: true };
      },
    };
    const values = decodeStream(u32le, source);
    const pending = values.next();
    // Once it awaits the chunk.
    await new Promise((resolve) => setImmediate(resolve));
    const done = values.return!();
    release();
    assert.deepEqual(await pending, { value: undefined, done: true });
    assert.deepEqual(await done, { value: undefined, done: true });
    assert.deepEqual(await values.next(), { value: undefined, done: true });
    assert.equal(returned, 1);
  });

  it("report offsets in the stream after values spanning chunks", async () => {
    const parser = bin().field("s", string(u8)).field("x", literal(u8, 7));
    const input = Uint8Array.from([
      ...parser.encode({ s: "abc" }),
      ...hex("02 6869 08"),
    ]);
    await assert.rejects(
      collect(parser, bytewise(input)),
      (e) =>
        e instanceof DecodeError && e.offset === 8 && e.path.join() === "x",
    );
  });
});
