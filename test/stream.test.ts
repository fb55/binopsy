import { setImmediate } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  bin,
  bytes,
  decodeStream,
  DecodeError,
  literal,
  string,
  u16le,
  u32le,
  u8,
} from "../src/index.ts";
import { bytewise, collect, decodeError, hex } from "./helpers.ts";

/**
 * `input` in chunks of `sizes`, repeated.
 *
 * @param input The bytes to split.
 * @param sizes The sizes of consecutive chunks.
 * @returns Views of `input` (the last one may be shorter).
 */
function chunked(input: Uint8Array, sizes: number[]): Uint8Array[] {
  const chunks = [];
  for (let i = 0, k = 0; i < input.length; i += sizes[k++ % sizes.length]) {
    chunks.push(input.subarray(i, i + sizes[k % sizes.length]));
  }
  return chunks;
}

describe("Streams", () => {
  const Record = bin()
    .u32le("id")
    .field("name", string(u8))
    .field("data", bytes(u16le));
  const values = Array.from({ length: 50 }, (_, i) => ({
    id: i,
    name: `name ${i}`,
    data: new Uint8Array(i * 10).fill(i),
  }));
  const input = Uint8Array.from(
    Buffer.concat(values.map((v) => Record.encode(v))),
  );

  it.each([
    { name: "1 byte", sizes: [1] },
    { name: "7 bytes", sizes: [7] },
    { name: "growing sizes", sizes: [1, 2, 3, 5, 8, 13, 21, 34, 55, 89] },
    { name: "1 MiB", sizes: [1 << 20] },
  ])("decode values in chunks of $name", async ({ sizes }) => {
    await expect(collect(Record, chunked(input, sizes))).resolves.toStrictEqual(
      values,
    );
  });

  it("decode from Node.js streams", async () => {
    const { Readable } = await import("node:stream");
    // Bytes are views of the input, here Buffers.
    const buffers = values.map(({ id, name, data }) => ({
      id,
      name,
      data: Buffer.from(data),
    }));
    await expect(
      collect(Record, Readable.from([Buffer.from(input)])),
    ).resolves.toStrictEqual(buffers);
  });

  it("yield byte views that stay valid", async () => {
    const records = await collect(
      bytes(u8),
      bytewise(Uint8Array.of(2, 7, 8, 2, 9, 10, 2, 11, 12)),
    );
    expect(records).toStrictEqual([
      Uint8Array.of(7, 8),
      Uint8Array.of(9, 10),
      Uint8Array.of(11, 12),
    ]);
  });

  it("yield no values for no input", async () => {
    await expect(collect(Record, [])).resolves.toStrictEqual([]);
  });

  it("fail when the input ends in a value", async () => {
    await expect(collect(Record, [input.subarray(0, 10)])).rejects.toThrow(
      decodeError({ code: "end-of-input", path: ["name"], offset: 5 }),
    );
  });

  it("fail when the input ends after a value, and stay done", async () => {
    const stream = decodeStream(u16le, [Uint8Array.of(1, 0), Uint8Array.of(2)]);
    await expect(stream.next()).resolves.toStrictEqual({
      value: 1,
      done: false,
    });
    await expect(stream.next()).rejects.toThrow(decodeError({ offset: 2 }));
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  describe("locate errors in the stream", () => {
    const parser = bin().field("s", string(u8)).field("x", literal(u8, 7));
    const before = Buffer.concat(
      Array.from({ length: 20 }, (_, i) => parser.encode({ s: "a".repeat(i) })),
    );

    it.each<[name: string, tail: string, path: string, offset: number]>([
      ["of a value", "02 6869 08", "x", before.length + 3],
      ["of the end of the input", "ff 41", "s", before.length + 1],
    ])("%s, in chunks of any size", async (_, tail, path, offset) => {
      const bad = Uint8Array.from(Buffer.concat([before, hex(tail)]));
      for (const size of [1, 3, 7, 64, bad.length]) {
        await expect(collect(parser, chunked(bad, [size]))).rejects.toThrow(
          decodeError({ path: [path], offset }),
        );
      }
    });
  });

  it("reject values of no bytes", async () => {
    await expect(collect(bin(), [hex("00")])).rejects.toThrow(TypeError);
    // A value of no bytes, of a size not known before.
    const empty = bin().field("a", string({ terminator: 0, max: 0 }));
    await expect(collect(empty, [hex("00")])).rejects.toThrow(
      decodeError({ code: "invalid", offset: 0 }),
    );
  });

  it("close their source when the iteration stops or fails", async () => {
    let closed = 0;
    function* chunks() {
      try {
        yield hex("01 02 03");
        yield hex("04");
      } finally {
        closed++;
      }
    }
    for await (const value of decodeStream(u8, chunks())) {
      expect(value).toBe(1);
      break;
    }
    expect(closed).toBe(1);
    const parser = bin().field("a", literal(u8, 1));
    await expect(collect(parser, chunks())).rejects.toThrow(
      /expected 1, got 2 in `a` at offset 1/u,
    );
    expect(closed).toBe(2);
  });

  it("serve concurrent calls of next in order", async () => {
    const two =
      Record.encode(values[0]).length + Record.encode(values[1]).length;
    const iterator = decodeStream(Record, bytewise(input.subarray(0, two)));
    const [a, b, c] = await Promise.all([
      iterator.next(),
      iterator.next(),
      iterator.next(),
    ]);
    expect([a.value?.id, b.value?.id, c.done]).toStrictEqual([0, 1, true]);
  });

  it("throw the errors of their source as they are, and close it", async () => {
    const primary = new DecodeError("error", "source", 77);
    let pulls = 0;
    let closed = 0;
    const stream = decodeStream(u32le, {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            if (pulls++ === 0) return { value: hex("01"), done: false };
            throw primary;
          },
          async return(): Promise<IteratorResult<Uint8Array>> {
            closed++;
            throw new Error("cleanup");
          },
        };
      },
    });
    await expect(stream.next()).rejects.toBe(primary);
    expect(closed).toBe(1);
    expect(primary.offset).toBe(77);
  });

  it("stop when returned while a chunk is awaited", async () => {
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
    const stream = decodeStream(u32le, source);
    const pending = stream.next();
    // Return once it awaits the chunk.
    await setImmediate();
    const done = stream.return!();
    release();
    await expect(pending).resolves.toStrictEqual({
      value: undefined,
      done: true,
    });
    await expect(done).resolves.toStrictEqual({ value: undefined, done: true });
    await expect(stream.next()).resolves.toStrictEqual({
      value: undefined,
      done: true,
    });
    expect(returned).toBe(1);
  });

  it("read sync iterables whose async iterator is undefined, as for await does", async () => {
    const source = Object.assign([Uint8Array.of(1, 2)], {
      [Symbol.asyncIterator]: undefined,
    });
    await expect(collect(u8, source)).resolves.toStrictEqual([1, 2]);
  });

  it("close their source when returned, without waiting for a pending read", async () => {
    let release!: () => void;
    let returned = 0;
    const source: AsyncIterator<Uint8Array> & AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () =>
        new Promise((resolve) => {
          release = () => resolve({ value: Uint8Array.of(7), done: false });
        }),
      return: async () => {
        returned++;
        return { value: undefined, done: true };
      },
    };
    const stream = decodeStream(u8, source);
    const pending = stream.next();
    await setImmediate();
    await expect(stream.return!()).resolves.toStrictEqual({
      value: undefined,
      done: true,
    });
    expect(returned).toBe(1);
    await expect(stream.next()).resolves.toStrictEqual({
      value: undefined,
      done: true,
    });
    // The read settles later, and its value is dropped.
    release();
    await expect(pending).resolves.toStrictEqual({
      value: undefined,
      done: true,
    });
  });

  it("share closing their source between concurrent returns", async () => {
    let finish!: () => void;
    let closed = 0;
    const stream = decodeStream(u8, {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { value: Uint8Array.of(1), done: false as const };
          },
          async return() {
            closed++;
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
            return { value: undefined, done: true as const };
          },
        };
      },
    });
    const a = stream.return!();
    const b = stream.return!();
    let settled = false;
    const watched = b.finally(() => {
      settled = true;
    });
    await setImmediate();
    expect(closed).toBe(1);
    expect(settled).toBe(false);
    finish();
    await Promise.all([a, watched]);
  });

  it("close their source after a pending read fails, when returned", async () => {
    const primary = new Error("pull");
    let fail!: (e: Error) => void;
    let closed = 0;
    const stream = decodeStream(u8, {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<Uint8Array>>((_resolve, reject) => {
              fail = reject;
            }),
          async return() {
            closed++;
            return { value: undefined, done: true as const };
          },
        };
      },
    });
    const next = stream.next();
    await setImmediate();
    const done = stream.return!();
    fail(primary);
    await expect(next).rejects.toBe(primary);
    await done;
    expect(closed).toBe(1);
  });
});
