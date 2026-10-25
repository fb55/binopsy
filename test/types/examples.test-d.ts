/*
 * The TypeScript examples of README.md, as written there, and the types it
 * gives for them. Change them together.
 */
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { crc32 } from "node:zlib";

import { describe, expectTypeOf, it } from "vitest";

import {
  array,
  bin,
  bytes,
  custom,
  DecodeError,
  decodeStream,
  fail,
  i32le,
  lazy,
  literal,
  map,
  match,
  optional,
  Reader,
  refine,
  sized,
  string,
  u16be,
  u16le,
  u32be,
  u32le,
  u64be,
  u8,
  when,
  type Bin,
  type Codec,
  type Input,
  type Output,
  type Path,
} from "../../src/index.ts";

// Read a file format
const Chunk = bin()
  .u32be("length")
  .field("type", string(4)) // "IHDR", "IDAT", …
  .field("data", bytes("length")) // As many bytes as `length` says
  .u32be("crc");

const Png = bin()
  .field("signature", literal(u64be, 0x89504e470d0a1a0an))
  .field("chunks", array(Chunk, { until: (chunk) => chunk.type === "IEND" }));

// Messages with a type tag
const Message = bin()
  .u8("type")
  .merge(
    match("type")
      .case(1, bin().field("name", string(u8))) // Join
      .case(2, bin().u32be("room").field("text", string(u16be))) // Chat
      .case(3, bin().f32be("x").f32be("y")), // Move
  );

type Message = Output<typeof Message>;
// | { type: 1; name: string }
// | { type: 2; room: number; text: string }
// | { type: 3; x: number; y: number }

function handle(message: Message) {
  if (message.type === 2) console.log(message.text); // TypeScript knows `text` is there
}

// Decode a stream
const Frame = sized(u16be, Message); // A 16-bit size, then the message

// Custom encodings, such as varints
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

// Parts shared by formats
const Prefix = bin().u8("kind").u16le("length");
const Payload = bin<{ length: number }>().field("body", bytes("length"));
const Packet = Prefix.merge(Payload); // { kind: number; length: number; body: Uint8Array }

const withValues = <T extends { count: number }, I extends { count: number }>(
  b: Bin<T, I>,
) =>
  b.field(
    "values",
    bytes((o) => o.count * 2),
  );

const Record = bin().u8("count").pipe(withValues);

// Reference: strings
string(16); // Exactly 16 bytes of text
string(16, { terminator: 0 }); // 16 bytes, the text ending with a zero (C's char[16])
string(16, { padRight: 0x20 }); // 16 bytes, the text padded with spaces
string(u8); // A length byte, then the text
string({ terminator: 0 }); // The text, then a zero
string({ terminator: 0, max: 16 }); // The same, of at most 16 bytes (a string of 16 bytes has no zero)

export { varint };

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

  it("rejects names of missing fields, and lengths that are not numbers", () => {
    // @ts-expect-error There is no field `cuont`.
    bin().u8("count").field("ratings", array(u16le, "cuont"));

    // @ts-expect-error `name` is not a number.
    bin().field("name", string(u8)).field("ratings", array(u16le, "name"));
  });

  it("reads a file format", () => {
    const png = Png.decode(readFileSync("image.png"));
    png.chunks.map((chunk) => chunk.type); // ["IHDR", "IDAT", "IEND"]

    const Header = bin()
      .u32be("width")
      .u32be("height")
      .u8("bitDepth")
      .u8("colorType")
      .u8("compression")
      .u8("filter")
      .u8("interlace");

    const { width, height } = Header.decode(png.chunks[0].data);

    expectTypeOf(png).toEqualTypeOf<{
      signature: 0x89504e470d0a1a0an;
      chunks: { length: number; type: string; data: Uint8Array; crc: number }[];
    }>();
    expectTypeOf<Input<typeof Png>>().toEqualTypeOf<{
      signature?: 0x89504e470d0a1a0an | undefined;
      chunks: readonly {
        length: number;
        type: string;
        data: Uint8Array;
        crc: number;
      }[];
    }>();
    expectTypeOf(width).toEqualTypeOf<number>();
    expectTypeOf(height).toEqualTypeOf<number>();
  });

  it("reads optional and versioned parts", () => {
    const Header = bin()
      .field("magic", literal(string(4), "DATA"))
      .u8("version")
      .u32le("count")
      .field(
        "checksum", // Since version 2
        when((header) => header.version >= 2, u32le),
      )
      .field("comment", optional(u8, string(u8))); // A flag byte, then the comment if it is not 0
    // { magic: "DATA"; version: number; count: number; checksum: number | null; comment: string | null }

    expectTypeOf<Output<typeof Header>>().toEqualTypeOf<{
      magic: "DATA";
      version: number;
      count: number;
      checksum: number | null;
      comment: string | null;
    }>();
    expectTypeOf<Input<typeof Header>>().toEqualTypeOf<{
      magic?: "DATA" | undefined;
      version: number;
      count: number;
      checksum: number | null;
      comment: string | null;
    }>();

    const Body = bin()
      .u8("compression")
      .field(
        "data",
        match("compression")
          .case(0, bytes(u32le))
          .case(1, fail("compressed data is not supported")),
      );
    expectTypeOf<Output<typeof Body>>().toEqualTypeOf<
      { compression: 0; data: Uint8Array } | { compression: 1; data: never }
    >();
  });

  it("matches messages by their type", () => {
    expectTypeOf<Message>().toEqualTypeOf<
      | { type: 1; name: string }
      | { type: 2; room: number; text: string }
      | { type: 3; x: number; y: number }
    >();
    expectTypeOf(handle).parameter(0).toEqualTypeOf<Message>();

    const Value = bin()
      .u8("type")
      .field("value", match("type").case(1, i32le).case(2, string(u32le)));
    expectTypeOf<Output<typeof Value>>().toEqualTypeOf<
      { type: 1; value: number } | { type: 2; value: string }
    >();

    match((o: { kind: number }) => o.kind & 0xf);
  });

  it("reads bit-packed fields", () => {
    const packet = new Uint8Array(20);

    // An IPv4 address, as "192.168.0.1"
    const address = map(bytes(4), {
      decode: (b) => b.join("."),
      encode: (text: string) => Uint8Array.from(text.split("."), Number),
    });

    const IPv4 = bin()
      .bits("version", 4)
      .bits("ihl", 4) // The header's length, in 32-bit words
      .bits("dscp", 6)
      .bits("ecn", 2)
      .u16be("totalLength")
      .u16be("identification")
      .bits("reserved", 1)
      .bits("dontFragment", 1)
      .bits("moreFragments", 1)
      .bits("fragmentOffset", 13)
      .u8("ttl")
      .u8("protocol")
      .u16be("checksum")
      .field("source", address)
      .field("destination", address)
      .field(
        "options",
        bytes((header) => header.ihl * 4 - 20),
      );

    // The header 45 00 00 73 00 00 40 00 40 11 b8 61 c0 a8 00 01 c0 a8 00 c7:
    IPv4.decode(packet);
    // { version: 4, ihl: 5, dscp: 0, ecn: 0, totalLength: 115, identification: 0,
    //   reserved: 0, dontFragment: 1, moreFragments: 0, fragmentOffset: 0,
    //   ttl: 64, protocol: 17, checksum: 47201,
    //   source: "192.168.0.1", destination: "192.168.0.199", options: Uint8Array(0) }

    expectTypeOf<Output<typeof IPv4>>().toEqualTypeOf<{
      version: number;
      ihl: number;
      dscp: number;
      ecn: number;
      totalLength: number;
      identification: number;
      reserved: number;
      dontFragment: number;
      moreFragments: number;
      fragmentOffset: number;
      ttl: number;
      protocol: number;
      checksum: number;
      source: string;
      destination: string;
      options: Uint8Array;
    }>();

    const Lsb = bin({ bitOrder: "lsb" }).bits("a", 3).bits("b", 5);
    expectTypeOf<Output<typeof Lsb>>().toEqualTypeOf<{
      a: number;
      b: number;
    }>();
  });

  it("decodes a stream", async () => {
    const socket = connect(9000, "localhost");
    for await (const message of decodeStream(Frame, socket)) {
      handle(message);
    }

    expectTypeOf<Output<typeof Frame>>().toEqualTypeOf<Message>();

    const Lenient = sized(
      u16be,
      bin()
        .u8("type")
        .merge(
          match("type")
            .case(1, bin().field("name", string(u8)))
            .otherwise(bin().field("payload", bytes(Infinity))),
        ),
    );
    expectTypeOf<Output<typeof Lenient>>().toEqualTypeOf<
      { type: 1; name: string } | { type: number; payload: Uint8Array }
    >();

    const reader = new Reader(new Uint8Array());
    expectTypeOf(reader.read(Frame)).toEqualTypeOf<Message>();
    expectTypeOf(reader.done).toEqualTypeOf<boolean>();
  });

  it("reads a few fields of large records", () => {
    const file = new Uint8Array();

    const Song = bin()
      .u32le("id")
      .field("title", string(u8))
      .field("artists", array(string(u8), u8))
      .u32le("coverSize")
      .field("cover", bytes("coverSize"))
      .f64le("duration");

    const Summary = Song.pick("id", "duration"); // Decodes { id: number; duration: number }

    const durations = new Map<number, number>();
    const reader = new Reader(file);
    while (!reader.done) {
      const { id, duration } = reader.read(Summary);
      durations.set(id, duration);
    }

    expectTypeOf<Output<typeof Summary>>().toEqualTypeOf<{
      id: number;
      duration: number;
    }>();
    expectTypeOf<Input<typeof Summary>>().toEqualTypeOf<never>();
  });

  it("writes messages and files", () => {
    Frame.encode({ type: 2, room: 7, text: "hi" });
    // Uint8Array [0, 9, 2, 0, 0, 0, 7, 0, 2, 104, 105]: the size, the type, the room, the length of the text, and the text

    const WritableChunk = Chunk.computed({
      length: (chunk) => chunk.data.length,
      crc: (chunk) => crc32(chunk.data, crc32(chunk.type)),
    });

    WritableChunk.encode({ type: "IEND", data: new Uint8Array(0) });
    // Uint8Array [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]

    expectTypeOf<Input<typeof WritableChunk>>().toEqualTypeOf<{
      length?: number;
      type: string;
      data: Uint8Array;
      crc?: number;
    }>();
    expectTypeOf<Output<typeof WritableChunk>>().toEqualTypeOf<
      Output<typeof Chunk>
    >();
    expectTypeOf<typeof WritableChunk.encodeInto>()
      .parameter(0)
      .toEqualTypeOf<Input<typeof WritableChunk>>();
    expectTypeOf<
      typeof WritableChunk.encodeInto
    >().returns.toEqualTypeOf<number>();
  });

  it("decodes a recursive structure", () => {
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

    expectTypeOf(Tree.decode(new Uint8Array())).toEqualTypeOf<Tree>();
  });

  it("uses a custom codec as a length", () => {
    const Entry = bin()
      .field("key", string(varint)) // A varint length, then the text
      .field("values", array(varint, varint)); // A varint count, then varints

    Entry.encode({ key: "id", values: [1, 300] }); // Uint8Array [2, 105, 100, 2, 1, 172, 2]

    expectTypeOf(varint).toEqualTypeOf<Codec<number>>();
    expectTypeOf<Output<typeof Entry>>().toEqualTypeOf<{
      key: string;
      values: number[];
    }>();
  });

  it("reports malformed input", () => {
    const truncated = new Uint8Array();

    try {
      Png.decode(truncated);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      console.log(e.code, e.path, e.offset); // "end-of-input" ["chunks", 1, "data"] 41
      console.log(e.message); // "unexpected end of input (10 bytes needed, 4 left) in `chunks[1].data` at offset 41"

      expectTypeOf(e.code).toEqualTypeOf<
        "end-of-input" | "invalid" | "no-match" | "error"
      >();
      expectTypeOf(e.path).toEqualTypeOf<Path>();
      expectTypeOf(e.offset).toEqualTypeOf<number>();
    }

    const Width = refine(u32be, (width) => width > 0, "width must be positive");
    expectTypeOf<Output<typeof Width>>().toEqualTypeOf<number>();
  });

  it("shares parts between formats", () => {
    expectTypeOf<Output<typeof Packet>>().toEqualTypeOf<{
      kind: number;
      length: number;
      body: Uint8Array;
    }>();
    expectTypeOf<Output<typeof Record>>().toEqualTypeOf<{
      count: number;
      values: Uint8Array;
    }>();
  });

  it("reads strings", () => {
    string(8, { encoding: "utf16le", terminator: 0 });
  });
});
