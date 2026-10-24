/** Codecs of functions of the user's, for formats the other codecs cannot express. */
import { Codec, type AnyCodec } from "./codec.ts";
import type { Gen } from "./compile.ts";
import { DecodeError, EncodeError, within } from "./errors.ts";

/** A value decoded by a custom codec, and the number of bytes it takes. */
export interface DecodeResult<O> {
  /** The value (which may be `undefined`). */
  value: O;
  /** The number of bytes of the value, from the start of the bytes given. */
  bytesRead: number;
}

/**
 * The functions of a custom codec. `decode` gets the bytes from the value
 * on (up to the end of the input or region; `final` if no more will
 * follow), and returns the value, or `undefined` if it needs more bytes:
 * it is called again with more. It may be called more than once for a
 * value, so it must have no side effects.
 */
export interface CustomOptions<O, I = O> {
  /**
   * The size of every value in bytes, if it is fixed: `decode` then gets
   * exactly these bytes. Or the size of a value, which `sizeOf` uses instead
   * of encoding it.
   */
  size?: number | ((value: I) => number) | undefined;
  /** Decodes the value at the start of `bytes`, or returns `undefined` to get more bytes. */
  decode: (bytes: Uint8Array, final: boolean) => DecodeResult<O> | undefined;
  /** The bytes of a value. */
  encode: (value: I) => Uint8Array;
}

/**
 * A codec of functions of your own (for formats the other codecs cannot
 * express); without `encode`, it can only decode.
 */
export function custom<O, I = O>(options: CustomOptions<O, I>): Codec<O, I>;
export function custom<O>(
  options: Omit<CustomOptions<O>, "encode">,
): Codec<O, never>;
export function custom(
  options: CustomOptions<unknown> | Omit<CustomOptions<unknown>, "encode">,
): AnyCodec {
  for (const key of Object.keys(options)) {
    if (!["size", "decode", "encode"].includes(key)) {
      throw new TypeError(`unknown option \`${key}\``);
    }
  }
  const { size } = options;
  if (
    !(size === undefined || typeof size === "function") &&
    !(Number.isSafeInteger(size) && size >= 0)
  ) {
    throw new TypeError(`invalid size ${String(size)}`);
  }
  if (typeof options.decode !== "function") {
    throw new TypeError("`decode` is not a function");
  }
  const encode = "encode" in options ? options.encode : undefined;
  if (encode !== undefined && typeof encode !== "function") {
    throw new TypeError("`encode` is not a function");
  }
  return new Custom(size ?? Number.NaN, options.decode, encode);
}

type Decode = CustomOptions<unknown>["decode"];

/**
 * Calls `decode` with `bytes[start..end]`; returns its result (checked), or
 * `undefined`.
 *
 * @param decode The decode function of the codec.
 * @param bytes The input.
 * @param start The offset of the value.
 * @param end The offset where the input (or region) ends.
 * @param final Whether no more input will follow.
 * @param size The size of every value, or `NaN` if it varies.
 * @returns The value and its size, or `undefined` if more bytes are needed.
 */
function decodeWith(
  decode: Decode,
  bytes: Uint8Array,
  start: number,
  end: number,
  final: boolean,
  size: number,
): DecodeResult<unknown> | undefined {
  let result;
  try {
    result = decode(bytes.subarray(start, end), final);
  } catch (e) {
    // Offsets of errors of `decode` are in the bytes it got.
    throw e instanceof DecodeError ? within(e, start, [], start) : e;
  }
  if (result === undefined) return undefined;
  const read = (result as Partial<DecodeResult<unknown>> | null)?.bytesRead;
  if (
    typeof result !== "object" ||
    result === null ||
    !("value" in result) ||
    read === undefined ||
    !(Number.isSafeInteger(read) && read >= 0 && read <= end - start) ||
    (Number.isFinite(size) && read !== size)
  ) {
    const returned =
      read === undefined
        ? typeof result === "object" && result !== null
          ? "no bytesRead"
          : String(result)
        : `bytesRead ${read}`;
    throw new DecodeError(
      "invalid",
      `decode returned ${returned}, not a value and its size in the ${end - start} bytes it got`,
      start,
    );
  }
  return result;
}

/**
 * The bytes `encode` returns for `value` (checked).
 *
 * @param encode The encode function of the codec.
 * @param value The value to encode.
 * @param size The size of every value, or `NaN` if it varies.
 * @returns The bytes, checked to be a `Uint8Array` of the size.
 */
function encodeWith(
  encode: CustomOptions<unknown>["encode"],
  value: unknown,
  size: number,
): Uint8Array {
  const bytes = encode(value);
  if (!(bytes instanceof Uint8Array)) {
    throw new EncodeError(`encode returned ${String(bytes)}, not bytes`);
  }
  if (Number.isFinite(size) && bytes.length !== size) {
    throw new EncodeError(
      `encode returned ${bytes.length} bytes, but the size is ${size}`,
    );
  }
  return bytes;
}

class Custom extends Codec {
  private readonly fn: Decode;
  private readonly toBytes: CustomOptions<unknown>["encode"] | undefined;
  private readonly measure: ((value: unknown) => number) | undefined;

  constructor(
    size: NonNullable<CustomOptions<unknown>["size"]>,
    decode: Decode,
    encode: CustomOptions<unknown>["encode"] | undefined,
  ) {
    super(typeof size === "number" ? size : Number.NaN, true);
    this.fn = decode;
    this.toBytes = encode;
    this.measure = typeof size === "function" ? size : undefined;
  }

  emitRead(g: Gen, wanted: boolean): string {
    const { size } = this;
    const fixed = Number.isFinite(size);
    if (fixed) g.need(size);
    g.flush();
    const result = g.let("undefined", "let");
    const call = `${g.k(decodeWith)}(${g.k(this.fn)}, buf, o, ${fixed ? `o + ${size}` : "end"}, ${fixed ? "true" : "cur.final"}, ${size})`;
    if (!fixed && g.mode === "resume") {
      // Called again with more bytes, until it has the value.
      g.line("for (;;) {");
      g.guard(`${result} = ${call};`);
      g.line(
        `if (${result} !== undefined || cur.final) break; yield end + 1; ${g.reload()} }`,
      );
    } else {
      g.guard(`${result} = ${call};`);
    }
    g.check(
      `${result} === undefined`,
      "end-of-input",
      '"unexpected end of input"',
    );
    const v = wanted ? g.let(`${result}.value`) : "";
    if (fixed) g.skip(size);
    else g.seek(`o + ${result}.bytesRead`);
    return v;
  }

  emitWrite(g: Gen, value: string): void {
    if (!this.toBytes) {
      g.fail(
        "invalid",
        '"this value can only be decoded (it has no encode function)"',
      );
      return;
    }
    if (g.mode === "size" && (this.measure || Number.isFinite(this.size))) {
      g.skip(this.measure ? g.callback(this.measure, value) : this.size);
      return;
    }
    const bytes = g.callback(
      encodeWith,
      g.k(this.toBytes),
      value,
      String(this.size),
    );
    const n = Number.isFinite(this.size) ? this.size : `${bytes}.length`;
    g.need(n);
    g.write(`buf.set(${bytes}, ${g.at()});`);
    g.skip(n);
  }
}
