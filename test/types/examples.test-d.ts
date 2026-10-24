/*
 * The TypeScript examples of README.md, as written there, and the types it
 * gives for them. Change them together.
 */
import { createReadStream } from "node:fs";

import { describe, expectTypeOf, it } from "vitest";

import { Entry } from "../../examples/tar.ts";
import {
  array,
  bin,
  bytes,
  custom,
  decodeStream,
  i32le,
  lazy,
  match,
  string,
  u16le,
  u32le,
  u8,
  type Bin,
  type Codec,
  type Output,
} from "../../src/index.ts";

string(16); // Exactly 16 bytes of text
string(16, { terminator: 0 }); // 16 bytes, the text ending with a zero (C's char[16])
string(16, { padRight: 0x20 }); // 16 bytes, the text padded with spaces
string(u8); // A length byte, then the text
string({ terminator: 0 }); // The text, then a zero
string({ terminator: 0, max: 16 }); // The same, of at most 16 bytes (a string of 16 bytes has no zero)

const Value = bin()
  .u8("type")
  .field(
    "value",
    match("type")
      .case(1, i32le)
      .case(2, string(u32le))
      .case(3, bin().i16le("x").i16le("y")),
  );
// | { type: 1; value: number }
// | { type: 2; value: string }
// | { type: 3; value: { x: number; y: number } }

const Shape = bin()
  .u8("kind")
  .merge(
    match("kind")
      .case(1, bin().f32le("radius"))
      .case(2, bin().f32le("width").f32le("height")),
  );
// { kind: 1; radius: number } | { kind: 2; width: number; height: number }

const Header = bin().u8("kind").u16le("length");
const Raw = bin<{ length: number }>().field("body", bytes("length"));
const Message = Header.merge(Raw);

interface Tree {
  name: string;
  children: Tree[];
}
const Tree: Codec<Tree> = bin()
  .field("name", string(u8))
  .field(
    "children",
    array(
      lazy(() => Tree),
      u16le,
    ),
  );

// Variable-length integers (LEB128) of up to 32 bits.
const varint = custom({
  decode(input, final) {
    let value = 0;
    for (let i = 0; i < input.length && i < 5; i++) {
      if (i === 4 && input[i] > 0x0f) throw new Error("varint exceeds u32");
      value += (input[i] & 0x7f) * 2 ** (7 * i);
      if (input[i] < 0x80) return { value, bytesRead: i + 1 };
    }
    if (!final && input.length < 5) return undefined;
    throw new Error("invalid varint");
  },
  encode(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error("expected an unsigned 32-bit integer");
    }
    const digits = [];
    let rest = value;
    do {
      digits.push((rest % 128) | (rest >= 128 ? 0x80 : 0));
      rest = Math.floor(rest / 128);
    } while (rest);
    return Uint8Array.from(digits);
  },
});

const withValues = <T extends { count: number }, I extends { count: number }>(
  b: Bin<T, I>,
) =>
  b.field(
    "values",
    bytes((o) => o.count * 2),
  );

const Record = bin().u8("count").pipe(withValues);

export { Tree, varint };

describe("The README", () => {
  it("decodes and encodes a player", () => {
    const input = new Uint8Array();

    const Player = bin()
      .u32le("id")
      .field("name", string(u8)) // A length byte, then the string
      .u8("count")
      .field("ratings", array(u16le, "count"));

    const player = Player.decode(input);
    // { id: number; name: string; count: number; ratings: number[] }

    Player.encode(player); // The bytes again

    expectTypeOf(player).toEqualTypeOf<{
      id: number;
      name: string;
      count: number;
      ratings: number[];
    }>();
  });

  it("matches values by their type", () => {
    expectTypeOf<Output<typeof Value>>().toEqualTypeOf<
      | { type: 1; value: number }
      | { type: 2; value: string }
      | { type: 3; value: { x: number; y: number } }
    >();
    expectTypeOf<Output<typeof Shape>>().toEqualTypeOf<
      { kind: 1; radius: number } | { kind: 2; width: number; height: number }
    >();
    match((o: { kind: number }) => o.kind & 0xf);
  });

  it("reads strings and bit fields", () => {
    string(8, { encoding: "utf16le", terminator: 0 });
    const Bits = bin().bits("a", 3).bits("b", 5);
    expectTypeOf<Output<typeof Bits>>().toEqualTypeOf<{
      a: number;
      b: number;
    }>();
  });

  it("merges a parser reading the fields around it", () => {
    expectTypeOf<Output<typeof Message>>().toEqualTypeOf<{
      kind: number;
      length: number;
      body: Uint8Array;
    }>();
  });

  it("computes a size", () => {
    const data = new Uint8Array();

    const Chunk = bin()
      .u32le("size")
      .field("data", bytes("size"))
      .computed("size", (chunk) => chunk.data.length);

    Chunk.encode({ data }); // `size` is computed
  });

  it("decodes a stream", async () => {
    for await (const entry of decodeStream(
      Entry,
      createReadStream("archive.tar"),
    )) {
      console.log(entry.name);
    }
  });

  it("adds a group of fields", () => {
    expectTypeOf<Output<typeof Record>>().toEqualTypeOf<{
      count: number;
      values: Uint8Array;
    }>();
  });
});
