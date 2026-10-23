import assert from "node:assert/strict";
import { bin, string, u8, type Codec } from "../src/index.ts";
import { bytewise, collect, hex } from "./helpers.ts";

/** `codec` decodes `bytes` to `text` (also from a stream), and encodes `text` to them. */
async function roundtrip(
  codec: Codec<string>,
  bytes: string,
  text: string,
): Promise<void> {
  assert.equal(codec.decode(hex(bytes)), text);
  // (Streams have no values of no bytes.)
  if (bytes)
    assert.deepEqual(await collect(codec, bytewise(hex(bytes))), [text]);
  assert.deepEqual(codec.encode(text), hex(bytes));
}

describe("Strings", () => {
  it("take all of their length, unless they end with a terminator or padding", async () => {
    await roundtrip(string(3), "616263", "abc");
    await roundtrip(string(5, { terminator: 0 }), "6869000000", "hi");
    await roundtrip(string(2, { terminator: 0 }), "6869", "hi");
    await roundtrip(string(5, { padRight: 0x20 }), "6869202020", "hi");
    await roundtrip(
      string(5, { terminator: 0, padRight: 0x20 }),
      "6869002020",
      "hi",
    );
    // With a terminator, padding is not taken off the text.
    await roundtrip(
      string(4, { terminator: 0, padRight: 0x20 }),
      "68202000",
      "h  ",
    );
    assert.equal(
      string(4, { terminator: 0, padRight: 0x20 }).decode(hex("68202020")),
      "h   ",
    );
    assert.equal(string(5, { terminator: 0 }).decode(hex("6869007878")), "hi");
  });

  it("are counted, or take the rest of the input", async () => {
    await roundtrip(string(u8), "02 6869", "hi");
    await roundtrip(string(u8, { terminator: 0 }), "03 686900", "hi");
    await roundtrip(string(Infinity), "6869", "hi");
    await roundtrip(string(Infinity, { terminator: 0x0a }), "68690a", "hi");
    const parser = bin()
      .u8("n")
      .field("s", string("n", { padRight: 0 }));
    assert.deepEqual(parser.decode(hex("03 686900")), { n: 3, s: "hi" });
    assert.deepEqual(parser.encode({ n: 3, s: "hi" }), hex("03 686900"));
  });

  it("end with a terminator (and have at most `max` bytes)", async () => {
    await roundtrip(string({ terminator: 0 }), "686900", "hi");
    await roundtrip(string({ terminator: 0x0a }), "68690a", "hi");
    await roundtrip(string({ terminator: 0, max: 3 }), "686900", "hi");
    await roundtrip(string({ terminator: 0, max: 2 }), "6869", "hi");
    await roundtrip(string({ terminator: 0, max: 0 }), "", "");
    const limited = bin()
      .u8("limit")
      .field("s", string({ terminator: 0, max: "limit" }));
    assert.deepEqual(limited.decode(hex("02 6869")), { limit: 2, s: "hi" });
    assert.deepEqual(limited.decode(hex("05 6800")), { limit: 5, s: "h" });
    // The published 0.0.0 test: zero-terminated strings of at most 5 bytes.
    const parser = bin()
      .field("a", string({ terminator: 0 }))
      .field("b", string({ terminator: 0, max: 5 }))
      .field("c", string({ terminator: 0 }));
    assert.deepEqual(parser.decode(hex("61626300 6465666768 696a00")), {
      a: "abc",
      b: "defgh",
      c: "ij",
    });
  });

  it("have encodings", async () => {
    await roundtrip(string(4, { encoding: "utf16le" }), "68006900", "hi");
    await roundtrip(
      string({ terminator: 0, encoding: "utf16le" }),
      "e9000000",
      "é",
    );
    // Units, not bytes, end UTF-16 strings.
    assert.equal(
      string({ terminator: 0, encoding: "utf16le" }).decode(hex("00010000")),
      "Ā",
    );
    await roundtrip(string(2, { encoding: "latin1" }), "e980", "é\x80");
    assert.equal(string(1, { encoding: "ascii" }).decode(hex("e1")), "a");
    // BOMs and unpaired surrogates are kept.
    await roundtrip(string(3), "efbbbf", "\ufeff");
    await roundtrip(
      string(4, { encoding: "utf16le" }),
      "fffe00d8",
      "\ufeff\ud800",
    );
  });

  it("are checked when encoding", () => {
    const failures: [Codec<string>, string, RegExp][] = [
      [string(3), "ab", /has 2 bytes, but its length is 3/],
      [string(2), "abc", /has 3 bytes, more than its length 2/],
      [string(3, { terminator: 0 }), "a\0", /contains its terminator/],
      [string(3, { padRight: 0x20 }), "a ", /ends with its padding/],
      [string({ terminator: 0x0a }), "a\nb", /contains its terminator/],
      [string({ terminator: 0, max: 2 }), "abc", /more than its maximum 2/],
      [string(1, { encoding: "latin1" }), "€", /is not latin1/],
      [string(2, { encoding: "ascii" }), "é", /is not ascii/],
      // A delimiter byte inside an encoded character.
      [string({ terminator: 0xa9 }), "©", /contains its terminator/],
    ];
    for (const [codec, text, message] of failures)
      assert.throws(() => codec.encode(text), message, text);
    assert.throws(() => string(3, { encoding: "utf16le" }), /odd length 3/);
    assert.throws(() => string({ max: 3 } as never), /needs a terminator/);
    assert.throws(
      () => string(3, { terminator: 256 }),
      /invalid terminator 256/,
    );
  });

  it("fail when the input ends before their terminator", () => {
    assert.throws(
      () => string({ terminator: 0 }).decode(hex("6869")),
      /unexpected end of input/,
    );
    assert.throws(
      () => string({ terminator: 0, max: 4 }).decode(hex("6869")),
      /unexpected end of input/,
    );
  });
});
