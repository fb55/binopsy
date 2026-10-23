/**
 * The base of all codecs, the cursor and writer they work on, and errors.
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
  type Selection,
} from "./compile.ts";

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

/** A callback reads the complete logical prefix, in addition to named dependencies. */
export const ALL_FIELDS = Symbol("all fields");
/** Earlier fields a codec reads (callbacks do not erase the named requirements). */
export type Reads = readonly (string | typeof ALL_FIELDS)[];

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
  /** @internal Whether decoding checks something, so the value is read even when it is not wanted. */
  readonly checks: boolean;
  /** @internal The earlier fields the codec reads. */
  readonly reads: Reads;
  #decoder: Compiled | undefined;
  #encoder: Encoder | undefined;

  /** @internal */
  constructor(size: number, checks = false, reads: Reads = []) {
    this.size = size;
    this.checks = checks;
    this.reads = reads;
  }

  /** @internal The value encoding `undefined` writes (for literals), if any. */
  get preset(): { readonly value: unknown } | undefined {
    return undefined;
  }

  /**
   * @internal Emits code that reads a value and returns an expression for
   * it, or, if it is not `wanted`, steps over it (still running checks) and
   * returns "".
   */
  abstract emitRead(g: Gen, wanted: boolean): string;

  /** @internal Emits code that writes the value of variable `value` (which it may set, to resolve a default). */
  abstract emitWrite(g: Gen, value: string): void;

  /** @internal Emits the body of this codec's function; when decoding, returns the expression of its value. */
  emitBody(g: Gen, selection: Selection): string {
    if (g.mode !== "encode") return this.emitRead(g, selection !== "none");
    this.emitWrite(g, "v");
    return "";
  }

  /** Decodes a value at `offset` (bytes after it are ignored). Truncated input throws a `DecodeError`. */
  decode(this: Standalone, bytes: Uint8Array, offset = 0): O {
    return decodeAt(this as never, cursor(bytes, offset));
  }

  /**
   * The bytes of `value`. Small results are views of a buffer shared with
   * other results (as Node.js does for small buffers), but never overwritten;
   * `slice()` them for a buffer of their own.
   */
  encode(this: Standalone, value: I): Uint8Array<ArrayBuffer> {
    const encoder = (this as unknown as AnyCodec).encoder();
    // While encoding (e.g. in an encode function calling `encode`), use a writer of its own.
    if (pool.busy)
      return pool.encode(encoder, new Writer(new Uint8Array(1024)), value);
    if (pool.bytes.length - pool.used < 4096) {
      pool.bytes = new Uint8Array(1 << 16);
      pool.used = 0;
    }
    const w = pool.writer;
    w.start(pool.bytes, pool.used);
    const bytes = pool.encode(encoder, w, value);
    if (w.bytes === pool.bytes) pool.used = (w.offset + 7) & ~7;
    return bytes;
  }

  /** Writes the bytes of `value` to `bytes` at `offset`; returns the offset after them. Bytes may have changed if it fails. */
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

  /** @internal The compiled decoder of the whole value. */
  decoder(): Compiled {
    return (this.#decoder ??= compile(this as AnyCodec, "decode", "all"));
  }

  /** @internal The compiled encoder. */
  encoder(): Encoder {
    return (this.#encoder ??= compile(this as AnyCodec, "encode"));
  }
}

/** Any codec (inputs and contexts are contravariant, so their top type is `never`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any output
export type AnyCodec = Codec<any, never, never>;
/** A codec that can only decode. */
export type Decoder<O, Ctx = unknown> = Codec<O, never, Ctx>;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Obj = Record<string, any>;

/**
 * A read position in `bytes` (`view` is a `DataView` of them); compiled
 * decoders read up to `end`. If the input is not `final`, more of it may
 * follow (in a stream).
 */
export interface Cursor {
  bytes: Uint8Array;
  view: DataView;
  offset: number;
  end: number;
  final: boolean;
}

const views = new WeakMap<Uint8Array, DataView>();

/** A `DataView` of `bytes` (kept, as values are often decoded from the same buffer). */
export function viewOf(bytes: Uint8Array): DataView {
  let view = views.get(bytes);
  if (!view) {
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    views.set(bytes, view);
  }
  return view;
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

/** Decodes a value of `codec` at the cursor, and moves the cursor past it. */
export function decodeAt<O>(codec: Codec<O, never, unknown>, cur: Cursor): O {
  return codec.decoder()(cur) as O;
}

/** Reads consecutive values from `bytes`. */
export class Reader {
  readonly #cur: Cursor;

  constructor(bytes: Uint8Array, offset = 0) {
    this.#cur = cursor(bytes, offset);
  }

  /** Where the next value starts. */
  get offset(): number {
    return this.#cur.offset;
  }

  /** Whether all bytes have been read. */
  get done(): boolean {
    return this.#cur.offset >= this.#cur.end;
  }

  /** Reads a value and moves past it (if it fails, the offset stays where it was). */
  read<O>(codec: Codec<O, never, unknown>): O {
    const start = this.#cur.offset;
    try {
      return decodeAt(codec, this.#cur);
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

  /** Starts writing to `bytes` at `offset`. */
  start(bytes: Uint8Array, offset: number): void {
    if (bytes !== this.bytes) {
      this.bytes = bytes;
      this.view = viewOf(bytes);
    }
    this.offset = this.base = offset;
  }

  /** Makes room for `n` more bytes. */
  room(n: number): void {
    if (this.offset + n <= this.bytes.length) return;
    if (!Number.isSafeInteger(this.offset + n))
      throw new EncodeError("length exceeds the safe offset range");
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

  /** The bytes written so far. */
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

  /** Encodes `value` with `w`, whose buffers (the pool's, or grown ones) are `ArrayBuffer`s. */
  encode(encoder: Encoder, w: Writer, value: unknown): Uint8Array<ArrayBuffer> {
    const busy = this.busy;
    this.busy = true;
    try {
      encoder(w, value);
      return w.written() as Uint8Array<ArrayBuffer>;
    } finally {
      this.busy = busy;
    }
  },
};

/** Where a value is: field names and array indexes. */
export type Path = readonly (string | number)[];

/** A path as written in code, e.g. `items[1].name` or `["a b"]`. */
function where(path: Path): string {
  return path
    .map((p, i) =>
      typeof p === "number"
        ? `[${p}]`
        : /^[A-Za-z_$][\w$]*$/.test(p)
          ? i
            ? `.${p}`
            : p
          : `[${JSON.stringify(p)}]`,
    )
    .join("");
}

/** Why decoding failed, where (`path` of field names and array indexes), and at which byte. */
export class DecodeError extends Error {
  override name = "DecodeError";
  /** What failed: truncated input, an invalid value, a tag without a case, or an error thrown by a function. */
  readonly code: "end-of-input" | "invalid" | "no-match" | "error";
  /** The failure, without its location. */
  readonly detail: string;
  /** The offset of the value that failed. */
  readonly offset: number;
  /** The field names and array indexes of the value that failed. */
  readonly path: Path;

  constructor(
    code: DecodeError["code"],
    detail: string,
    offset: number,
    path: Path = [],
    cause?: unknown,
  ) {
    super("", { cause });
    this.code = code;
    this.detail = detail;
    this.offset = offset;
    this.path = [...path];
    this.message = located(this);
  }
}

/** Why encoding failed, and where (`path` of field names and array indexes). */
export class EncodeError extends Error {
  override name = "EncodeError";
  /** The failure, without its location. */
  readonly detail: string;
  /** The field names and array indexes of the value that failed. */
  readonly path: Path = [];

  constructor(detail: string, cause?: unknown) {
    super(detail, { cause });
    this.detail = detail;
  }
}

function located(e: DecodeError | EncodeError): string {
  const at = e.path.length ? ` in \`${where(e.path)}\`` : "";
  return e instanceof DecodeError
    ? `${e.detail}${at} at offset ${e.offset}`
    : `${e.detail}${at}`;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Locates an error at `path` (in front of its own) and moves it by `offset`;
 * other errors become `DecodeError`s at `offset`.
 */
export function within(
  e: unknown,
  offset: number,
  path: Path,
  shift = 0,
): DecodeError {
  if (!(e instanceof DecodeError)) {
    return new DecodeError(
      "error",
      String((e as Error)?.message ?? e),
      offset,
      path,
      e,
    );
  }
  return new DecodeError(
    e.code,
    e.detail,
    e.offset + shift,
    [...path, ...e.path],
    e.cause,
  );
}

/** Like `within`, for encoding. */
export function encodingWithin(e: unknown, path: Path): EncodeError {
  const err = new EncodeError(
    e instanceof EncodeError ? e.detail : String((e as Error)?.message ?? e),
    e instanceof EncodeError ? e.cause : e,
  ) as Mutable<EncodeError>;
  err.path = [...path, ...(e instanceof EncodeError ? e.path : [])];
  err.message = located(err);
  return err;
}
