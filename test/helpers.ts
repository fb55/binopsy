import { execFileSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

import { expect } from "vitest";

import {
  type DecodeError,
  bin,
  decodeStream,
  EncodeError,
  Reader,
  type Codec,
} from "../src/index.ts";

/**
 * Bytes from hex digits (spaces are ignored).
 *
 * @param text The hex digits.
 * @returns A `Uint8Array` of the bytes (not a `Buffer`).
 */
export function hex(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text.replaceAll(/\s/gu, ""), "hex"));
}

/**
 * Decodes the values in `chunks` as a stream.
 *
 * @param codec The codec of the values.
 * @param chunks The chunks of bytes.
 * @returns The decoded values.
 */
export async function collect<O>(
  codec: Codec<O, never>,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<O[]> {
  const values: O[] = [];
  for await (const value of decodeStream(codec, chunks)) values.push(value);
  return values;
}

/**
 * Each byte of `bytes` as a chunk of its own.
 *
 * @param bytes The bytes to split.
 * @returns The chunks, of one byte each.
 */
export function bytewise(bytes: Uint8Array): Uint8Array[] {
  return Array.from(bytes, (byte) => Uint8Array.of(byte));
}

/** Codecs that read no fields around them, of any values. */
export type Standalone = Codec<unknown, never>;

/**
 * Checks decoding directly and from chunks of one byte.
 *
 * @param codec The codec to check.
 * @param wire The encoded bytes.
 * @param value The expected decoded value.
 */
export async function decodes(
  codec: Standalone,
  wire: Uint8Array,
  value: unknown,
): Promise<void> {
  expect(codec.decode(wire)).toStrictEqual(value);
  // Streams have no values of no bytes.
  if (wire.length > 0) {
    await expect(collect(codec, bytewise(wire))).resolves.toStrictEqual([
      value,
    ]);
  }
}

/**
 * Checks that `codec` decodes `bytes` (hex) to `value`, also when a `Reader`
 * steps over it and from chunks of one byte, and encodes `input` to them.
 *
 * @param codec The codec to check.
 * @param bytes The encoded value, as hex digits.
 * @param value The decoded value.
 * @param input The value to encode (by default, `value`).
 */
export async function roundtrip(
  codec: Standalone,
  bytes: string,
  value: unknown,
  input: unknown = value,
): Promise<void> {
  const wire = hex(bytes);
  await decodes(codec, wire, value);
  expect((codec as Codec<unknown, unknown>).encode(input)).toStrictEqual(wire);
  expect((codec as Codec<unknown, unknown>).sizeOf(input)).toBe(wire.length);
  const reader = new Reader(wire);
  reader.read(bin().field("value", codec).pick());
  expect(reader.offset).toBe(wire.length);
}

/** Properties of a `DecodeError`. */
export interface Failure {
  code?: DecodeError["code"];
  path?: (string | number)[];
  offset?: number;
  message?: RegExp;
  cause?: unknown;
}

/**
 * An asymmetric matcher of a `DecodeError` with the properties of `failure`.
 *
 * @param failure The properties the error has.
 * @param failure.message A pattern its message matches.
 * @returns The matcher (typed as an `Error`, for `toThrow`).
 */
export function decodeError({ message, ...failure }: Failure): Error {
  return expect.objectContaining({
    ...failure,
    name: "DecodeError",
    ...(message && { message: expect.stringMatching(message) as unknown }),
  }) as Error;
}

/**
 * Checks that decoding `bytes` (hex) fails as `failure`, also in a `Reader`
 * (which stays where it was) and from chunks of one byte.
 *
 * @param codec The codec to check.
 * @param bytes The input, as hex digits.
 * @param failure The properties the error has.
 */
export async function decodeFails(
  codec: Standalone,
  bytes: string,
  failure: Failure,
): Promise<void> {
  const wire = hex(bytes);
  const error = decodeError(failure);
  expect(() => codec.decode(wire)).toThrow(error);
  const reader = new Reader(wire);
  expect(() => reader.read(codec)).toThrow(error);
  expect(reader.offset).toBe(0);
  await expect(collect(codec, bytewise(wire))).rejects.toThrow(error);
}

/**
 * Checks that encoding `value` fails with an `EncodeError` whose message
 * matches `message`.
 *
 * @param codec The codec to check.
 * @param value The value to encode.
 * @param message A pattern the error's message matches.
 */
export function encodeFails(
  codec: Standalone,
  value: unknown,
  message: RegExp,
): void {
  const encode = () => (codec as Codec<unknown, unknown>).encode(value);
  expect(encode).toThrow(EncodeError);
  expect(encode).toThrow(message);
}

/**
 * Runs a Node.js process with `args`; returns its output.
 *
 * @param args The arguments of `node`.
 * @returns The standard output of the process, as plain text (also where
 *   colors are forced, as in CI).
 */
export function node(...args: string[]): string {
  return stripVTControlCharacters(
    execFileSync(process.execPath, args, {
      encoding: "utf8",
      timeout: 120_000,
    }),
  );
}
