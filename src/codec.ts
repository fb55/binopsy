/**
 * The base of all codecs, and the cursor and writer they work on.
 *
 * Codecs are compiled: they emit the JavaScript that decodes and encodes
 * their values (see compile.ts), so that each parser becomes a few
 * specialized functions.
 */
import {
  compile,
  type Decoder as Compiled,
  type Encoder,
  type Gen,
  type Reads,
  type Selection,
} from "./compile.ts";
import { EncodeError, type Path } from "./errors.ts";

/** Types only: the key of a codec's types (not a property at run time). */
export declare const types: unique symbol;
/** Types only: marks codecs whose input may be omitted, as they supply a value (literals). */
export declare const defaulted: unique symbol;
/** Types only: codecs that supply their value when encoding `undefined`. */
export type Defaulted<D extends boolean = true> = { readonly [defaulted]: D };

/** Types only: a codec that reads no fields around it (so it decodes and encodes on its own). */
export type Standalone = {
  readonly [types]: { context: (ctx: unknown) => void };
};

/**
 * Decodes bytes into values of type `O`, and encodes values of type `I`.
 * `Ctx` is the type of the earlier fields the codec reads (e.g.
 * `bytes("count")`); only codecs that read none decode and encode on their own.
 */
export abstract class Codec<O = unknown, I = O, Ctx = unknown> {
  /** Types only: what the codec decodes to, encodes, and depends on. */
  declare readonly [types]: {
    output: O;
    input: (value: I) => void;
    context: (ctx: Ctx) => void;
  };

  /** Exact size in bytes of every value, if known; `NaN` if it varies (or is not known, e.g. for `lazy`). */
  readonly size: number;
  /** Whether decoding checks something, so the value is read even when it is not wanted. @internal */
  readonly checks: boolean;
  /** The earlier fields the codec reads. @internal */
  readonly reads: Reads;
  #decoder: Compiled | undefined;
  #encoder: Encoder | undefined;
  #sizer: Encoder | undefined;

  /** @internal */
  constructor(size: number, checks = false, reads: Reads = []) {
    this.size = size;
    this.checks = checks;
    this.reads = reads;
  }

  /**
   * The value encoding `undefined` writes (for literals), if any.
   *
   * @returns An object holding the value, or `undefined` if there is none.
   * @internal
   */
  get preset(): { readonly value: unknown } | undefined {
    return undefined;
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
    this.emitWrite(g, "v");
    return "";
  }

  /**
   * Decodes a value at `offset` (bytes after it are ignored). Truncated input
   * throws a `DecodeError`.
   *
   * @param bytes The bytes to decode.
   * @param offset Where the value starts in `bytes`.
   * @returns The decoded value.
   */
  decode(this: Standalone, bytes: Uint8Array, offset = 0): O {
    const cur = cursor(bytes, offset);
    return (this as unknown as AnyCodec).decoder()(cur) as O;
  }

  /**
   * The bytes of `value`. Small results are views of a buffer shared with
   * other results (as Node.js does for small buffers), but never overwritten;
   * `slice()` them for a buffer of their own.
   *
   * @param value The value to encode.
   * @returns A view of the bytes written.
   */
  encode(this: Standalone, value: I): Uint8Array<ArrayBuffer> {
    const encoder = (this as unknown as AnyCodec).encoder();
    // While encoding (e.g. in an encode function calling `encode`), use a writer of its own.
    if (pool.busy) {
      return pool.encode(encoder, new Writer(new Uint8Array(1024)), value);
    }
    if (pool.bytes.length - pool.used < 4096) {
      pool.bytes = new Uint8Array(1 << 16);
      pool.used = 0;
    }
    const w = pool.writer;
    w.start(pool.bytes, pool.used);
    try {
      const bytes = pool.encode(encoder, w, value);
      if (w.bytes === pool.bytes) pool.used = (w.offset + 7) & ~7;
      return bytes;
    } finally {
      // The writer does not keep a buffer it grew to.
      if (w.bytes !== pool.bytes) w.start(pool.bytes, pool.used);
    }
  }

  /**
   * Writes the bytes of `value` to `bytes` at `offset`; returns the offset
   * after them. Bytes may have changed if it fails.
   *
   * @param value The value to encode.
   * @param bytes The buffer to write to (it does not grow).
   * @param offset Where the value starts in `bytes`.
   * @returns The offset of the first byte after the value.
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
   * (but for `custom` codecs of no fixed size, which are encoded). It does
   * not check the value: encoding may still fail.
   *
   * @param value The value to measure.
   * @returns The number of bytes.
   */
  sizeOf(this: Standalone, value: I): number {
    const codec = this as unknown as AnyCodec;
    const w = new Writer(NOTHING);
    (codec.#sizer ??= compile(codec, "size"))(w, value);
    return w.offset;
  }

  /**
   * The compiled decoder of the whole value.
   *
   * @returns The decoder, compiled on first use.
   * @internal
   */
  decoder(): Compiled {
    return (this.#decoder ??= compile(this, "decode", "all"));
  }

  /**
   * The compiled encoder.
   *
   * @returns The encoder, compiled on first use.
   * @internal
   */
  encoder(): Encoder {
    return (this.#encoder ??= compile(this, "encode"));
  }
}

/** Any codec (inputs and contexts are contravariant, so their top type is `never`). */
export type AnyCodec = Codec<unknown, never, never>;
/** A codec argument (not `AnyCodec`: TypeScript would infer its `never` context for codecs written in the argument). */
export type AnyCase = { readonly [types]: object };
/** The type `C` decodes to. */
export type Output<C> = C extends { readonly [types]: { output: infer O } }
  ? O
  : never;
/** The type `C` encodes. */
export type Input<C> = C extends {
  readonly [types]: { input: (value: infer I) => void };
}
  ? I
  : never;
/** The earlier fields `C` reads. */
export type Context<C> = C extends {
  readonly [types]: { context: (ctx: infer X) => void };
}
  ? X
  : unknown;

export type Obj = Record<string, unknown>;

/**
 * A read position in `bytes` (`view` is a `DataView` of them); compiled
 * decoders read up to `end`. If the input is not `final`, more of it may
 * follow (in a stream): decoders reaching its end throw `MORE`.
 */
export interface Cursor {
  bytes: Uint8Array;
  view: DataView;
  offset: number;
  end: number;
  final: boolean;
  /** Where the fields decoded are, when tracing. */
  trace?: Span[];
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
 * Decodes the value of `codec` at `offset` in `bytes`, recording where each
 * field of its parsers is (e.g. to annotate the bytes).
 *
 * @param codec The codec of the value.
 * @param bytes The bytes to decode.
 * @param offset Where the value starts.
 * @returns The fields, in the order they were decoded.
 */
export function trace(
  codec: Standalone,
  bytes: Uint8Array,
  offset = 0,
): Span[] {
  const cur = cursor(bytes, offset);
  cur.trace = [];
  compile(codec as unknown as AnyCodec, "trace", "all")(cur);
  return cur.trace;
}

/**
 * The bytes last viewed, and their view: values are often read from (or
 * written to) the same bytes, and views are slow to create. They are kept
 * until the current job ends (a `WeakMap` would cost more than it saves).
 */
/** The buffer of writers that only size values. */
const NOTHING = new Uint8Array(0);

let last: Uint8Array | undefined;
let lastView: DataView | undefined;

function forget(): void {
  last = undefined;
  lastView = undefined;
}

/**
 * A `DataView` of `bytes`.
 *
 * @param bytes The bytes to view.
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

function checkOffset(offset: number, bytes: Uint8Array): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) {
    throw new RangeError(`offset ${offset} is outside the bytes`);
  }
}

function cursor(bytes: Uint8Array, offset: number): Cursor {
  checkOffset(offset, bytes);
  return { bytes, view: viewOf(bytes), offset, end: bytes.length, final: true };
}

/** Reads consecutive values from `bytes`. */
export class Reader {
  readonly #cur: Cursor;

  constructor(bytes: Uint8Array, offset = 0) {
    this.#cur = cursor(bytes, offset);
  }

  /**
   * Where the next value starts.
   *
   * @returns The offset of the next value in the bytes.
   */
  get offset(): number {
    return this.#cur.offset;
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
   * Reads a value and moves past it (if it fails, the offset stays where it
   * was).
   *
   * @param codec The codec of the value.
   * @returns The decoded value.
   */
  read<O>(codec: Codec<O, never>): O {
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
   * Starts writing to `bytes` at `offset`.
   *
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

  /**
   * Makes room for `n` more bytes.
   *
   * @param n The number of bytes to be written at the current offset.
   */
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

  /**
   * The bytes written so far.
   *
   * @returns A view of the bytes from `base` to the current offset.
   */
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
   * Encodes `value` with `w`, whose buffers (the pool's, or grown ones) are
   * `ArrayBuffer`s.
   *
   * @param encoder The compiled encoder of the codec.
   * @param w The writer to encode with.
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
