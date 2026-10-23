import {
  bin,
  bytes,
  string,
  array,
  sized,
  literal,
  match,
  map,
  refine,
  optional,
  when,
  lazy,
  u8,
  u16be,
  u16le,
  u32le,
  Reader,
  decodeStream,
  DecodeError,
  type Codec,
  type Input,
  type Output,
} from "../../src/index.ts";

export const Packet = bin()
  .field("magic", literal(u16be, 0xb10))
  .u8("kind")
  .field(
    "payload",
    match("kind").case(1, string(u16le)).case(2, array(u32le, u8)),
  );
export const packetBytes = () => Packet.encode({ kind: 1, payload: "hello" });
export const describe = (value: Output<typeof Packet>) =>
  value.kind === 1
    ? value.payload.toUpperCase()
    : value.payload.map((n) => n + 1);

export const Blocks = bin()
  .u8("size")
  .u8("count")
  .field(
    "items",
    array(
      bytes((o) => o.size),
      "count",
    ),
  )
  .computed("count", (v) => v.items.length);
export const blocksBytes = () =>
  Blocks.encode({ size: 2, items: [Uint8Array.of(1, 2), Uint8Array.of(3, 4)] });

export const Flat = bin()
  .u8("kind")
  .merge(
    match("kind")
      .case(1, bin().field("text", string(u16le)))
      .case(2, bin().u32le("id")),
  );
export const Summary = Flat.pick("kind");

export const Header = bin().u8("kind").u16le("length");
export const Raw = bin<Pick<Output<typeof Header>, "length">>().field(
  "body",
  bytes("length"),
);
export const WithRaw = Header.merge(Raw);
export const InRegion = sized(u32le, array(u16le, Infinity));

export const Chunk = bin()
  .u32le("length")
  .u16le("count")
  .field("parts", array(bytes("length"), "count"))
  .computed({
    length: (v) => v.parts[0]?.length ?? 0,
    count: (v) => v.parts.length,
  });
export type ChunkInput = Input<typeof Chunk>;

export const Status = refine(
  u8,
  (n): n is 1 | 2 => n === 1 || n === 2,
  "expected status 1 or 2",
);
export const Flags = bin().bits("kind", 3).bits("mode", 5).u16be("sequence");
export const LongBits = bin().bits("prefix", 3).bits("value", 32);
export const Presence = bin()
  .u8("version")
  .field("id", optional(u8, u32le))
  .field(
    "extra",
    when((o) => o.version >= 2, u8),
  );

export interface Tree {
  name: string;
  children: Tree[];
}
export const Tree: Codec<Tree> = bin()
  .field("name", string(u8))
  .field(
    "children",
    array(
      lazy(() => Tree),
      u16le,
    ),
  );

// The old nested-bit layout and shape, expressed without an unaligned child call.
export const OldNestedBits = map(
  bin().bits("a", 1).bits("b", 2).bits("c", 4).bits("d", 1),
  {
    decode: (p) => ({ a: p.a, x: { b: p.b, c: p.c, d: p.d } }),
    encode: (p: { a: number; x: { b: number; c: number; d: number } }) => ({
      a: p.a,
      ...p.x,
    }),
  },
);

export function readPair(bytes: Uint8Array) {
  const reader = new Reader(bytes);
  return [reader.read(Packet), reader.read(Packet)] as const;
}
export async function stream(source: AsyncIterable<Uint8Array>) {
  try {
    for await (const summary of decodeStream(Summary, source))
      void summary.kind;
  } catch (error) {
    if (error instanceof DecodeError)
      return { code: error.code, path: error.path, offset: error.offset };
    throw error;
  }
}
// Text-option spellings printed in the review's README section.
string(16);
string(16, { terminator: 0 });
string(16, { padRight: 0x20 });
string({ terminator: 0, max: 16 });
string(16, { encoding: "utf16le", terminator: 0 });
