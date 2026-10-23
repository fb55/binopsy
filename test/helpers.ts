import { decodeStream, type Codec } from "../src/index.ts";

/** Bytes from hex digits (spaces are ignored). */
export function hex(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text.replace(/\s/g, ""), "hex"));
}

/** Decodes the values in `chunks` as a stream. */
export async function collect<O>(
  codec: Codec<O, never, unknown>,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<O[]> {
  const values: O[] = [];
  for await (const value of decodeStream(codec, chunks)) values.push(value);
  return values;
}

/** Each byte of `bytes` as a chunk of its own. */
export function bytewise(bytes: Uint8Array): Uint8Array[] {
  return Array.from(bytes, (byte) => Uint8Array.of(byte));
}
