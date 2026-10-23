/**
 * A program using binopsy as published: through the built declarations
 * only, in a browser (without Node.js types). Checked by `npm run lint`.
 */
import {
  array,
  bin,
  bytes,
  decodeStream,
  literal,
  match,
  string,
  u16be,
  u16le,
  u32le,
  u8,
  type Codec,
  type Input,
  type Output,
} from "../../lib/index.js";

const Packet = bin()
  .field("magic", literal(u16be, 0xb10))
  .u8("kind")
  .field(
    "payload",
    match("kind").case(1, string(u16le)).case(2, array(u32le, u8)),
  );
const wire = Packet.encode({ kind: 1, payload: "hello" });
const packet: Output<typeof Packet> = Packet.decode(wire);
if (packet.kind === 1) packet.payload.toUpperCase();
else packet.payload.map((n) => n + 1);
export const input: Input<typeof Packet> = { kind: 2, payload: [1] };

const Blocks = bin()
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
export const blob = new Blob([
  Blocks.encode({ size: 1, items: [Uint8Array.of(1)] }),
]);
export const response = new Response(wire);
export const digest = crypto.subtle.digest("SHA-256", wire);

interface Tree {
  name: string;
  children: Tree[];
}
export const Tree: Codec<Tree> = bin()
  .field("name", string(u8))
  .field("children", array(null as unknown as Codec<Tree>, u16le));

export async function names(
  source: AsyncIterable<Uint8Array>,
): Promise<number[]> {
  const kinds: number[] = [];
  for await (const p of decodeStream(Packet.pick("kind"), source))
    kinds.push(p.kind);
  return kinds;
}
// @ts-expect-error internals are not part of the types
Packet.emitRead;
