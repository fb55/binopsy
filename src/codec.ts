/** Codecs are compiled: they emit the JavaScript of their values (see compile.ts). */
import type { Merged } from "./bin.ts";
import type { Bits } from "./bits.ts";
import {
  compile,
  type Decoder as Compiled,
  type Encoder,
  type Gen,
  type Reads,
  type Selection,
} from "./compile.ts";
import { DecodeError, EncodeError, type Path } from "./errors.ts";

/** Types only: the key of a codec's types (not a property at run time). */
export declare const types: unique symbol;
/** Types only: marks codecs whose input may be omitted, as they supply a value (literals). */
export declare const defaulted: unique symbol;
export type Defaulted<D extends boolean = true> = { readonly [defaulted]: D };

/** Types only: a codec that reads no fields around it (so it decodes and encodes on its own). */
export type Standalone = {
  readonly [types]: { context: (ctx: unknown) => void; packed: false };
};

/**
 * A codec: decodes bytes to values of type `O`, and encodes values of type
 * `I`. `Ctx` is the type of the fields it reads from the parser around it
 * (`bytes("count")` reads `count`): only codecs that read none decode and
 * encode on their own. `Packed` marks bit fields, which only work as direct
 * parser fields.
 */
export abstract class Codec<
  O = unknown,
  I = O,
  Ctx = unknown,
  Packed extends boolean = false,
> {
  /** Types only: what the codec decodes to, encodes, and depends on. */
  declare readonly [types]: {
    output: O;
    packed: Packed;
    input: (value: I) => void;
    context: (ctx: Ctx) => void;
  };

  /**
   * The size of every value in bytes, or `NaN` if it varies. It is also `NaN`
   * for `lazy` codecs and bit fields, whose sizes are not known on their own.
   */
  readonly size: number;
  /** Whether decoding checks something, so the value is read even when it is not wanted. @internal */
  readonly checks: boolean;
  /** @internal */
  readonly reads: Reads;
  /** A match whose cases are parsers, if this codec can merge their fields. @internal */
  declare readonly merged?: (AnyCodec & Merged) | undefined;
  /** Optional packing of consecutive parser fields. @internal */
  declare readonly packing?: Bits;
  /** Integer codecs: their name, and least and greatest values. @internal */
  declare readonly bounds?:
    | readonly [name: string, min: number, max: number]
    | undefined;
  #decoder: Compiled | undefined;
  /** The decoder of `decode`, which views the input's whole buffer (see `readView`). */
  #bufferDecoder: Compiled | undefined;
  #encoder: Encoder | undefined;
  #sizer: Encoder | undefined;

  /** @internal */
  constructor(size: number, checks = false, reads: Reads = []) {
    if (size > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`a size of ${size} bytes is not a safe integer`);
    }
    this.size = size;
    this.checks = checks;
    this.reads = reads;
  }

  /**
   * @returns The value encoding `undefined` writes (for literals), if any.
   * @internal
   */
  get preset(): { readonly value: unknown } | undefined {
    return undefined;
  }

  /**
   * Whether encoding fills in an omitted value with a default that depends
   * on other fields (as a match of literals does), which `emitFill` emits.
   *
   * @returns `true` if it does.
   * @internal
   */
  fills(): boolean {
    return false;
  }

  /**
   * Emits code filling in the value in variable `value` with its default, if
   * it is omitted (only for codecs that `fills`).
   *
   * @param _g The generator of the function.
   * @param _value The variable holding the value.
   * @internal
   */
  emitFill(_g: Gen, _value: string): void {
    // Most codecs have no such default.
  }

  /**
   * Emits code that reads a value and returns an expression for it, or, if
   * it is not `wanted`, steps over it (still running checks) and returns "".
   *
   * @internal
   */
  abstract emitRead(g: Gen, wanted: boolean): string;

  /** Emits code that writes the value of variable `value` (which it may set, to resolve a default). @internal */
  abstract emitWrite(g: Gen, value: string): void;

  /**
   * Emits the body of this codec's function; when decoding, returns the
   * expression of its value.
   *
   * @param g The generator of the function.
   * @param selection What the function decodes (when encoding, "all").
   * @returns The expression of the value, or "" if none is decoded.
   * @internal
   */
  emitBody(g: Gen, selection: Selection): string {
    if (!g.encoding) return this.emitRead(g, selection !== "none");
    writeValue(g, this, "v");
    return "";
  }

  /**
   * Decodes the value at `offset` of `bytes`; bytes after it are ignored.
   *
   * @param bytes The input.
   * @param offset Where the value starts (default 0).
   * @returns The value (never a part of one: decoding throws instead).
   * @throws {DecodeError} If the input ends inside the value or holds an
   *   invalid one, with the `code`, `path` and `offset` of the failure.
   * @throws {RangeError} If `offset` is outside `bytes`.
   */
  decode(this: Standalone, bytes: Uint8Array, offset = 0): O {
    const codec = this as unknown as AnyCodec;
    return codec.#decodeAt(cursor(bytes, offset, true)) as O;
  }

  /**
   * Decodes the value at `offset` of `bytes`, which must end with it: for
   * files and messages that hold one value.
   *
   * @param bytes The input.
   * @param offset Where the value starts (default 0).
   * @returns The value.
   * @throws {DecodeError} As `decode` does, and with the code `"invalid"` at
   *   the first byte after the value if there are any.
   * @throws {RangeError} If `offset` is outside `bytes`.
   */
  decodeExact(this: Standalone, bytes: Uint8Array, offset = 0): O {
    const cur = cursor(bytes, offset, true);
    const value = (this as unknown as AnyCodec).#decodeAt(cur);
    const left = cur.end - cur.offset;
    if (left > 0) {
      throw new DecodeError(
        "invalid",
        `${left} ${left === 1 ? "byte" : "bytes"} after the value`,
        cur.offset,
      );
    }
    return value as O;
  }

  #decodeAt(cur: Cursor): unknown {
    return (this.#bufferDecoder ??= compile(this, "buffer", "all"))(cur);
  }

  /**
   * Encodes `value`, after checking that it fits the format. Counts and sizes
   * read before a value are written from the value.
   *
   * @param value The value to encode (it is not changed).
   * @returns A view of the bytes, in an `ArrayBuffer`. Small results share a
   *   buffer with other results (as Node.js does for small `Buffer`s), but
   *   are never overwritten: `slice()` one for a buffer of its own. Each
   *   starts at a multiple of 8 bytes, so typed arrays can view it.
   * @throws {EncodeError} If the value cannot be encoded, with the `path` of
   *   the field that failed.
   */
  encode(this: Standalone, value: I): Uint8Array<ArrayBuffer> {
    const encoder = (this as unknown as AnyCodec).encoder();
    // While encoding (e.g. in an encode function calling `encode`), use a writer of its own.
    if (pool.busy) {
      return pool.encode(encoder, new Writer(new Uint8Array(1024)), value);
    }
    // Results already returned keep the buffer they view.
    if (pool.bytes.length - pool.used < 4096) {
      pool.bytes = new Uint8Array(1 << 16);
      pool.used = 0;
    }
    const w = pool.writer;
    w.start(pool.bytes, pool.used);
    try {
      const bytes = pool.encode(encoder, w, value);
      // The next result starts at a multiple of 8 bytes, as in Node.js's pool:
      // typed arrays (such as a Float64Array) need aligned offsets.
      if (w.bytes === pool.bytes) pool.used = (w.offset + 7) & ~7;
      return bytes;
    } finally {
      // The writer does not keep a buffer it grew to.
      if (w.bytes !== pool.bytes) w.start(pool.bytes, pool.used);
    }
  }

  /**
   * Encodes `value` into `bytes` at `offset`, with the checks of `encode`.
   *
   * @param value The value to encode; no part of it may be a view of `bytes`.
   * @param bytes The buffer to write to, which may be shared memory. It does
   *   not grow.
   * @param offset Where the value starts (default 0).
   * @returns The offset after the value.
   * @throws {EncodeError} If the value cannot be encoded, or does not fit in
   *   `bytes`. Part of it may have been written.
   * @throws {RangeError} If `offset` is outside `bytes`.
   */
  encodeInto(
    this: Standalone,
    value: I,
    bytes: Uint8Array,
    offset = 0,
  ): number {
    checkOffset(offset, bytes);
    const w = new Writer(bytes, offset, true);
    (this as unknown as AnyCodec).encoder()(w, value);
    return w.offset;
  }

  /**
   * The number of bytes `value` encodes to, computed without encoding it
   * (except for `custom` codecs without a `size`). A codec of a fixed size
   * returns its `size` without looking at the value. Most checks of encoding
   * are skipped, so encoding may still fail.
   *
   * @param value The value to measure.
   * @returns The number of bytes `encode` writes for it.
   * @throws {EncodeError} If the value cannot be measured: e.g. a length is
   *   not a count, or a function of yours throws.
   * @example
   * const Name = string(u8);
   * Name.sizeOf("hé"); // 4: a length byte, then 3 bytes of UTF-8
   */
  sizeOf(this: Standalone, value: I): number {
    const codec = this as unknown as AnyCodec;
    if (Number.isFinite(codec.size)) return codec.size;
    const w = new Writer(NOTHING);
    (codec.#sizer ??= compile(codec, "size"))(w, value);
    // Sizes past it are rounded (and encoding fails).
    if (!Number.isSafeInteger(w.offset)) {
      throw new EncodeError("length exceeds the safe offset range");
    }
    return w.offset;
  }

  /**
   * @returns The decoder of the whole value, compiled on first use.
   * @internal
   */
  decoder(): Compiled {
    return (this.#decoder ??= compile(this, "decode", "all"));
  }

  /**
   * @returns The encoder, compiled on first use.
   * @internal
   */
  encoder(): Encoder {
    return (this.#encoder ??= compile(this, "encode"));
  }
}

/**
 * Any codec, for constraints: `<C extends AnyCodec>(codec: C) => …`.
 * (Inputs and contexts are contravariant, so their top type is `never`.)
 */
export type AnyCodec = Codec<unknown, never, never, boolean>;
/**
 * A codec that may only decode, as one of `map` or `custom` without `encode`
 * does: every codec of `O` is one. It types a choice of parsers
 * (`cond ? A : B`), or a table of parsers of different fields.
 */
export type Decoder<O, Ctx = unknown> = Codec<O, never, Ctx>;
/** A codec argument (not `AnyCodec`: TypeScript would infer its `never` context for codecs written in the argument). */
export type AnyCase = { readonly [types]: { packed?: false } };
/** The type of the values codec `C` decodes: `Output<typeof Header>`. */
export type Output<C> = C extends { readonly [types]: { output: infer O } }
  ? O
  : never;
/** Whether a codec needs a direct parser field. */
export type Packing<C> = C extends {
  readonly [types]: { packed: infer P extends boolean };
}
  ? P
  : false;
/**
 * The type of the values codec `C` encodes: that of decoded values, except
 * that literals and computed fields may be omitted (and arrays are readonly).
 */
export type Input<C> = C extends {
  readonly [types]: { input: (value: infer I) => void };
}
  ? I
  : never;
/**
 * The fields codec `C` reads from the parser around it, e.g. `{ count:
 * number }` for `bytes("count")`; `unknown` if it reads none.
 */
export type Context<C> = C extends {
  readonly [types]: { context: (ctx: infer X) => void };
}
  ? X
  : unknown;

export type Obj = Record<string, unknown>;

/**
 * A read position in `bytes`; decoders read up to `end`. If the input is not
 * `final`, more may follow: decoders reaching its end throw `MORE`.
 */
export interface Cursor {
  bytes: Uint8Array;
  view: DataView;
  offset: number;
  end: number;
  final: boolean;
  /** Where the fields decoded are, when tracing. */
  trace?: Span[];
  /** The path of the value whose function is tracing. */
  tracePath?: (string | number)[];
}

/** Where a field was decoded from. */
export interface Span {
  /** The field names and array indexes of the field. */
  path: Path;
  /** The offset of its first byte. */
  start: number;
  /** The offset after its last byte (bit fields have the bytes of their run). */
  end: number;
  /** Its value. */
  value: unknown;
}

/**
 * Decodes a value, and returns where each field of its parsers is: to
 * annotate bytes, or compare them.
 *
 * Every field of every parser in the value has a span, in the order they
 * were decoded, a field after the fields inside it (`["items", 0, "name"]`,
 * then `["items"]`). Bit fields have the bytes of their run. Fields that
 * `pick` steps over have `value: undefined`.
 *
 * @param codec The codec of the value; it must read no fields around it.
 * @param bytes The input.
 * @param offset Where the value starts (default 0).
 * @returns The spans of the fields: path, start and end offsets, and value.
 * @throws {DecodeError} If decoding fails, as with `decode`.
 * @throws {RangeError} If `offset` is outside `bytes`.
 * @example
 * const Header = bin().u8("version").field("name", string(u8));
 * trace(Header, Uint8Array.of(1, 2, 104, 105));
 * // [{ path: ["version"], start: 0, end: 1, value: 1 },
 * //  { path: ["name"], start: 1, end: 4, value: "hi" }]
 */
export function trace(
  codec: Standalone,
  bytes: Uint8Array,
  offset = 0,
): Span[] {
  const cur = cursor(bytes, offset);
  cur.trace = [];
  cur.tracePath = [];
  compile(codec as unknown as AnyCodec, "trace", "all")(cur);
  return cur.trace;
}

const NOTHING = new Uint8Array(0);

/**
 * The bytes last viewed, and their view: values are often read from (or
 * written to) the same bytes, and views are slow to create. They are kept
 * until the current job ends (a `WeakMap` would cost more than it saves).
 */
let last: Uint8Array | undefined;
let lastView: DataView | undefined;
let lastBuffer: ArrayBufferLike | undefined;
let bufferView: DataView | undefined;

function forget(): void {
  last = undefined;
  lastView = undefined;
  lastBuffer = undefined;
  bufferView = undefined;
}

/**
 * @param bytes Any bytes.
 * @returns The last view if it is of the same bytes, else a new one.
 */
export function viewOf(bytes: Uint8Array): DataView {
  if (bytes !== last) {
    if (!last) queueMicrotask(forget);
    last = bytes;
    lastView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return lastView!;
}

/**
 * A read view shared by slices of the same backing buffer, until this job ends.
 *
 * @param bytes The bytes to decode (generated reads add their byte offset).
 * @returns A view of the backing buffer, not limited to the slice.
 * @internal
 */
export function readView(bytes: Uint8Array): DataView {
  const { buffer } = bytes;
  if (buffer !== lastBuffer) {
    if (!lastBuffer) queueMicrotask(forget);
    lastBuffer = buffer;
    bufferView = new DataView(buffer);
  }
  return bufferView!;
}

function checkOffset(offset: number, bytes: Uint8Array): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) {
    throw new RangeError(`offset ${offset} is outside the bytes`);
  }
}

function cursor(bytes: Uint8Array, offset: number, whole = false): Cursor {
  checkOffset(offset, bytes);
  return {
    bytes,
    view: whole ? readView(bytes) : viewOf(bytes),
    offset,
    end: bytes.length,
    final: true,
  };
}

/**
 * Reads values one after the other from bytes in memory.
 *
 * @example
 * const reader = new Reader(input);
 * const values: number[] = [];
 * while (!reader.done) values.push(reader.read(u16le));
 */
export class Reader {
  readonly #cur: Cursor;

  /**
   * A reader of the values in `bytes`, from `offset` on: `read` returns them
   * one after the other, until `done`.
   *
   * @param bytes The input.
   * @param offset Where the first value starts (default 0).
   * @throws {RangeError} If `offset` is outside `bytes`.
   */
  constructor(bytes: Uint8Array, offset = 0) {
    this.#cur = cursor(bytes, offset);
  }

  /**
   * Where the next value starts. Setting it moves the reader, e.g. to a
   * value found through an index.
   *
   * @returns The offset in the bytes.
   */
  get offset(): number {
    return this.#cur.offset;
  }

  /**
   * @param offset Where the next value starts.
   * @throws {RangeError} If `offset` is outside the bytes.
   */
  set offset(offset: number) {
    checkOffset(offset, this.#cur.bytes);
    this.#cur.offset = offset;
  }

  /**
   * Whether all bytes have been read.
   *
   * @returns `true` once the offset has reached the end of the bytes.
   */
  get done(): boolean {
    return this.#cur.offset >= this.#cur.end;
  }

  /**
   * Decodes the value at the offset, and moves the offset past it.
   *
   * @param codec The codec of the value; it must read no fields around it.
   * @returns The value.
   * @throws {DecodeError} If decoding fails; the offset then stays where it
   *   was.
   */
  read<O>(codec: Decoder<O>): O {
    const start = this.#cur.offset;
    try {
      return codec.decoder()(this.#cur) as O;
    } catch (e) {
      this.#cur.offset = start;
      throw e;
    }
  }
}

/**
 * A buffer that codecs write to, from `base` on. Unless it is `fixed`, it
 * grows: the bytes written move to a new buffer, where `base` is 0.
 */
export class Writer {
  bytes!: Uint8Array;
  view!: DataView;
  offset = 0;
  base = 0;
  private readonly fixed: boolean;

  constructor(bytes: Uint8Array, offset = 0, fixed = false) {
    this.fixed = fixed;
    this.start(bytes, offset);
  }

  /**
   * @param bytes The buffer to write to.
   * @param offset Where the first byte is written (the new `base`).
   */
  start(bytes: Uint8Array, offset: number): void {
    if (bytes !== this.bytes) {
      this.bytes = bytes;
      this.view = viewOf(bytes);
    }
    this.offset = offset;
    this.base = offset;
  }

  /** @param n The number of bytes to be written at the current offset. */
  room(n: number): void {
    if (this.offset + n <= this.bytes.length) return;
    if (!Number.isSafeInteger(this.offset + n)) {
      throw new EncodeError("length exceeds the safe offset range");
    }
    if (this.fixed) {
      throw new EncodeError(
        `the value does not fit (${this.offset + n - this.bytes.length} bytes more needed)`,
      );
    }
    const written = this.written();
    this.start(
      new Uint8Array(Math.max(2 * written.length, written.length + n, 1024)),
      0,
    );
    this.bytes.set(written);
    this.offset = written.length;
  }

  /** @returns A view of the bytes from `base` to the current offset. */
  written(): Uint8Array {
    return this.bytes.subarray(this.base, this.offset);
  }
}

/** Where values are encoded: the free part of a buffer that results share. */
const pool = {
  bytes: new Uint8Array(1 << 16),
  used: 0,
  writer: new Writer(new Uint8Array(0)),
  busy: false,

  /**
   * @param encoder The encoder of a codec.
   * @param w A writer whose buffers (the pool's, or grown ones) are
   *   `ArrayBuffer`s.
   * @param value The value to encode.
   * @returns A view of the bytes written.
   */
  encode(encoder: Encoder, w: Writer, value: unknown): Uint8Array<ArrayBuffer> {
    const { busy } = this;
    this.busy = true;
    try {
      encoder(w, value);
      return w.written() as Uint8Array<ArrayBuffer>;
    } finally {
      this.busy = busy;
    }
  },
};

/**
 * @param g The generator of the function.
 * @param codec The codec of the value.
 * @param value The variable holding the value.
 * @internal
 */
export function fillIn(g: Gen, codec: AnyCodec, value: string): void {
  const { preset } = codec;
  if (preset) {
    g.line(`if (${value} === undefined) ${value} = ${g.k(preset.value)};`);
  } else {
    codec.emitFill(g, value);
  }
}

/**
 * Emits code encoding `value` (in a variable, which later fields read); when
 * sizing a value of a fixed size, only its default and its size.
 *
 * @param g The generator of the function.
 * @param codec The codec of the value.
 * @param value The variable holding the value.
 * @internal
 */
export function writeValue(g: Gen, codec: AnyCodec, value: string): void {
  if (g.mode === "size" && Number.isFinite(codec.size)) {
    codec.emitFill(g, value);
    g.skip(codec.size);
  } else {
    codec.emitWrite(g, value);
  }
}
