import { describe, expect, it } from "vitest";

import { bin, bytes, custom, DecodeError, EncodeError } from "../src/index.ts";
import {
  bytewise,
  collect,
  decodeError,
  decodeFails,
  encodeFails,
  hex,
  type Failure,
  type Standalone,
} from "./helpers.ts";

describe("Custom codecs", () => {
  // LEB128: 7 bits a byte, the last without its high bit.
  const varint = custom({
    decode(input, final) {
      let value = 0;
      for (let i = 0; i < input.length && i < 5; i++) {
        value += (input[i] & 0x7f) * 2 ** (7 * i);
        if (input[i] < 0x80) return { value, bytesRead: i + 1 };
      }
      if (!final && input.length < 5) return undefined;
      throw new Error("invalid varint");
    },
    encode(value: number) {
      const out = [];
      let rest = value;
      do {
        out.push((rest % 128) | (rest >= 128 ? 0x80 : 0));
        rest = Math.floor(rest / 128);
      } while (rest);
      return Uint8Array.from(out);
    },
  });

  it("decode and encode with functions, also in streams", async () => {
    const parser = bin().field("n", varint).field("data", bytes("n")).u8("end");
    const value = { n: 300, data: new Uint8Array(300).fill(1), end: 9 };
    const encoded = parser.encode(value);
    expect(encoded.subarray(0, 2)).toStrictEqual(hex("ac02"));
    expect(encoded).toHaveLength(303);
    const decoded = parser.decode(encoded);
    expect([decoded.n, decoded.end]).toStrictEqual([300, 9]);
    const streamed = await collect(parser, bytewise(encoded));
    expect(streamed.map((v) => [v.n, v.end])).toStrictEqual([[300, 9]]);
  });

  it("are sized with their size function, or else by encoding", () => {
    const parser = bin().field("n", varint).field("data", bytes("n"));
    const value = { n: 300, data: new Uint8Array(300) };
    expect(parser.sizeOf(value)).toBe(302);
    const sized = custom({
      decode: () => undefined,
      encode: () => {
        throw new Error("encoded");
      },
      size: (n: number) => (n < 128 ? 1 : 2),
    });
    expect(bin().field("n", sized).sizeOf({ n: 300 })).toBe(2);
  });

  it("may decode undefined values", () => {
    const codec = custom<unknown>({
      decode: () => ({ value: undefined, bytesRead: 1 }),
    });
    expect(codec.decode(Uint8Array.of(1))).toBeUndefined();
  });

  it.each<[name: string, codec: Standalone, bytes: string, failure: Failure]>([
    [
      "must not read more bytes than they get",
      bin()
        .u8("a")
        .field("b", custom({ decode: () => ({ value: 1, bytesRead: 9 }) })),
      "00 01",
      { path: ["b"], message: /bytesRead 9/u },
    ],
    [
      "locate the errors they throw",
      bin().u8("a").field("b", varint),
      "00 ffffffffff",
      { code: "error", path: ["b"], message: /invalid varint in `b`/u },
    ],
  ])("%s", (_, codec, wire, failure) => decodeFails(codec, wire, failure));

  it("must encode to bytes of their size", () => {
    const fixed = custom({
      size: 2,
      decode: (b) => ({ value: b[0] + b[1], bytesRead: 2 }),
      encode: (v: number) => Uint8Array.of(v, 0, 0),
    });
    expect(fixed.decode(hex("0102"))).toBe(3);
    encodeFails(fixed, 1, /returned 3 bytes, but the size is 2/u);
  });

  it("locate the DecodeErrors they throw, without changing them", () => {
    const error: DecodeError = Object.freeze(
      new DecodeError("invalid", "bad", 1, ["x"], new Error("cause")),
    );
    const parser = bin()
      .u8("head")
      .field(
        "v",
        custom({
          decode() {
            throw error;
          },
        }),
      );
    // The error is not changed, so it is located the same way again.
    for (let i = 0; i < 2; i++) {
      expect(() => parser.decode(Uint8Array.of(0, 1, 2))).toThrow(
        decodeError({ offset: 2, path: ["v", "x"], cause: error.cause }),
      );
    }
    expect([error.offset, error.path]).toStrictEqual([1, ["x"]]);
  });

  it("locate the EncodeErrors they throw, without changing them", () => {
    const error: EncodeError = Object.freeze(new EncodeError("bad"));
    const parser = bin().field(
      "v",
      custom({
        decode: () => ({ value: 1, bytesRead: 1 }),
        encode() {
          throw error;
        },
      }),
    );
    for (let i = 0; i < 2; i++) {
      expect(() => parser.encode({ v: 1 })).toThrow(
        expect.objectContaining({ name: "EncodeError", path: ["v"] }),
      );
    }
    expect(error.path).toStrictEqual([]);
  });

  it("encode to buffers of their own, not shared memory", () => {
    const shared = custom({
      size: 1,
      decode: (b) => ({ value: b[0], bytesRead: 1 }),
      encode: (v: number) => new Uint8Array(new SharedArrayBuffer(1)).fill(v),
    });
    const encoded = shared.encode(7);
    expect(encoded.buffer).toBeInstanceOf(ArrayBuffer);
    expect(encoded).toStrictEqual(hex("07"));
  });
});
