/** Codecs built from others: bytes, strings, arrays, regions, conversions, checks and optional values. */
import {
  Codec,
  type AnyCodec,
  type Defaulted,
  type defaulted,
  type Obj,
} from "./codec.ts";
import {
  ALL_FIELDS,
  compile,
  scoped,
  type Gen,
  type Reads,
} from "./compile.ts";
import { EncodeError } from "./errors.ts";
import { Primitive } from "./primitives.ts";

/** The names of the fields of type `V` in every variant of `T`. (Mapping `keyof T & string` keeps it from mapping each variant.) */
export type KeysOf<T, V> = {
  [K in keyof T & string]-?: [T[K]] extends [V] ? K : never;
}[keyof T & string];

/**
 * A length: a number (`Infinity`: up to the end of the input or region), a
 * codec of the count read before the value, the name of an earlier number
 * field, or a function of the earlier fields. Counts are non-negative safe
 * integers. (Outside a parser, any name is accepted, and becomes a requirement.)
 */
export type Length<Ctx = never> =
  | number
  | Codec<number>
  | ([Ctx] extends [never] ? string : KeysOf<Ctx, number>)
  | ((fields: Ctx) => number);

/** The fields a named or callback source reads: named values `V`, and the callback's context. */
export type Needs<S, Ctx, V> = ([Extract<S, string>] extends [never]
  ? unknown
  : { [P in Extract<S, string>]: V }) &
  ([Extract<S, (fields: never) => unknown>] extends [never]
    ? unknown
    : Extract<S, (fields: never) => unknown> extends (
          fields: infer X,
        ) => unknown
      ? [Ctx] extends [never]
        ? X
        : Ctx
      : unknown);

/** The fields length `L` reads. */
export type LengthNeeds<L, Ctx> = Needs<L, Ctx, number>;

/** A length at run time. */
type AnyLength = number | string | AnyCodec | ((fields: Obj) => number);

/**
 * Checks a length when a codec is defined.
 *
 * @param length The length to check.
 * @param what The name of the length, for the error.
 * @returns The length, if it is valid.
 */
function checked<L>(length: L, what = "length"): L {
  if (
    typeof length === "number"
      ? !(length === Infinity || (Number.isSafeInteger(length) && length >= 0))
      : typeof length !== "string" &&
        typeof length !== "function" &&
        !(length instanceof Codec)
  ) {
    throw new TypeError(`invalid ${what} ${String(length)}`);
  }
  return length;
}

function lengthReads(length: AnyLength | undefined): Reads {
  if (typeof length === "string") return [length];
  if (typeof length === "function") return [ALL_FIELDS];
  return length instanceof Codec ? length.reads : [];
}

/**
 * The size of `length` units, if it is a finite number (else `NaN`).
 *
 * @param length The number of units.
 * @param unit The size of a unit in bytes.
 * @returns The size in bytes, or `NaN`.
 */
function fixed(length: AnyLength, unit = 1): number {
  const size =
    typeof length === "number" && Number.isFinite(length)
      ? length * unit
      : Number.NaN;
  if (Number.isFinite(size) && !Number.isSafeInteger(size)) {
    throw new TypeError("length times item size is not a safe integer");
  }
  return size;
}

/**
 * Emits a check that `v` is a count (a non-negative safe integer).
 *
 * @param g The generator of the function.
 * @param v An expression of the count.
 */
function checkCount(g: Gen, v: string): void {
  g.check(
    `!(Number.isSafeInteger(${v}) && ${v} >= 0)`,
    "invalid",
    `"invalid length " + String(${v})`,
  );
}

/**
 * Emits code reading a length; returns it (a number if it is constant).
 *
 * @param g The generator of the function.
 * @param length The length of the value.
 * @param unit The size of a unit in bytes (lengths of 2-byte units are even).
 * @returns The number, or an expression of it.
 */
function readLength(g: Gen, length: AnyLength, unit = 1): number | string {
  let v: string;
  if (length === Infinity) v = g.rest();
  else {
    if (typeof length === "number") return length;
    v = given(g, length);
    if (!(length instanceof Primitive && length.count)) checkCount(g, v);
  }
  if (unit === 2) {
    g.check(`${v} % 2`, "invalid", `"odd length " + ${v} + " for utf16le"`);
  }
  return v;
}

/**
 * The value of a length that is not a number: a field, a function's result,
 * or a count read before.
 *
 * @param g The generator of the function.
 * @param length The name of the field, the function, or the codec of the count.
 * @returns An expression of the length.
 */
function given(g: Gen, length: Exclude<AnyLength, number>): string {
  return typeof length === "string"
    ? g.ref(length)
    : typeof length === "function"
      ? g.callback(length, g.context())
      : length.emitRead(g, true);
}

/**
 * Emits code writing the count `length` is read from, or checking that
 * `count` is the length.
 *
 * @param g The generator of the function.
 * @param length The length of the value.
 * @param count An expression of the number of units in the value.
 * @param unit The name of the units, for errors (e.g. "bytes").
 */
function writeLength(
  g: Gen,
  length: AnyLength,
  count: string,
  unit: string,
): void {
  if (length === Infinity) return;
  if (length instanceof Codec) {
    const v = g.let(count, "let");
    length.emitWrite(g, v);
    return;
  }
  const expected =
    typeof length === "number" ? String(length) : given(g, length);
  g.check(
    `${count} !== ${expected}`,
    "invalid",
    `"has " + ${count} + " ${unit}, but its length is " + ${expected}`,
  );
}

class Bytes extends Codec<Uint8Array> {
  private readonly length: AnyLength;

  constructor(length: AnyLength) {
    super(fixed(length), false, lengthReads(length));
    this.length = length;
  }

  emitRead(g: Gen, wanted: boolean): string {
    const n = readLength(g, this.length);
    g.need(n);
    const v = wanted ? g.let(`buf.subarray(${g.at()}, ${g.at(n)})`) : "";
    g.skip(n);
    return v;
  }

  emitWrite(g: Gen, value: string): void {
    g.check(
      `!(${value} instanceof Uint8Array)`,
      "invalid",
      `"expected bytes, got " + String(${value})`,
    );
    const count = g.let(`${value}.length`);
    writeLength(g, this.length, count, "bytes");
    const n = Number.isFinite(this.size) ? this.size : count;
    g.need(n);
    g.write(`buf.set(${value}, ${g.at()});`);
    g.skip(n);
  }
}

/**
 * Bytes of a length (in bytes), as views of the input: `new Uint8Array(b)`
 * copies them (`slice()` does not, for `Buffer`s).
 *
 * @param length The number of bytes, a codec of it, a field or a function.
 * @returns A codec of `Uint8Array`s.
 */
export function bytes<Ctx = never, const L extends Length<Ctx> = Length<Ctx>>(
  length: L,
): Codec<Uint8Array, Uint8Array, LengthNeeds<L, Ctx>> {
  return new Bytes(checked(length as AnyLength));
}

/** Text encodings. `latin1` maps bytes to the first 256 code points (it is not Windows-1252). */
export type Encoding = "utf8" | "latin1" | "ascii" | "utf16le";

/** How text is decoded and encoded. */
interface Text {
  /** The size of a unit (of terminators and padding) in bytes. */
  unit: number;
  decode: (buf: Uint8Array, start: number, end: number) => string;
  /** The size of `text` in bytes (or -1 if it cannot be encoded). */
  size: (text: string) => number;
  /** Writes `text` at `buf[offset]`; returns its size. */
  write: (buf: Uint8Array, offset: number, text: string) => number;
}

type Slice = (this: Uint8Array, start: number, end: number) => string;
interface NodeBuffer {
  byteLength(text: string): number;
  prototype: Record<
    "utf8Slice" | "latin1Slice" | "asciiSlice" | "ucs2Slice",
    Slice
  > & {
    utf8Write(this: Uint8Array, text: string, offset: number): number;
  };
}
const NodeBuffer = (globalThis as { Buffer?: NodeBuffer }).Buffer;

/**
 * A decoder: a method of Node.js buffers (which are fast), or else
 * `fallback`.
 *
 * @param method The name of the method of `Buffer`s.
 * @param fallback The decoder to use where there are no `Buffer`s.
 * @returns A function calling the method on the bytes, or `fallback`.
 */
function decoder(
  method: keyof NodeBuffer["prototype"],
  fallback: Text["decode"],
): Text["decode"] {
  const slice = NodeBuffer?.prototype[method] as Slice | undefined;
  return slice ? (buf, start, end) => slice.call(buf, start, end) : fallback;
}

/**
 * Decodes units of `size` bytes (little endian) as character codes, masked
 * by `mask`.
 *
 * @param size The size of a unit in bytes.
 * @param mask The bits of a unit that are kept.
 * @returns The `decode` function of a `Text`.
 */
function fromCodes(size: 1 | 2, mask = 0xffff): Text["decode"] {
  return (buf, start, end) => {
    const codes = [];
    for (let i = start; i < end; i += size) {
      codes.push((size === 1 ? buf[i] : buf[i] | (buf[i + 1] << 8)) & mask);
    }
    let text = "";
    for (let i = 0; i < codes.length; i += 4096) {
      text += String.fromCharCode(...codes.slice(i, i + 4096));
    }
    return text;
  };
}

/**
 * The size of text whose characters are all at most `max` (one byte each),
 * or -1.
 *
 * @param max The largest character code that can be encoded.
 * @returns The `size` function of a `Text`.
 */
function codesSize(max: number): Text["size"] {
  return (text) => {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) > max) return -1;
    }
    return text.length;
  };
}

function writeCodes(buf: Uint8Array, offset: number, text: string): number {
  for (let i = 0; i < text.length; i++) buf[offset + i] = text.charCodeAt(i);
  return text.length;
}

const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const utf8Encoder = new TextEncoder();

const texts: Record<Encoding, Text> = {
  utf8: {
    unit: 1,
    decode: decoder("utf8Slice", (buf, start, end) =>
      utf8Decoder.decode(buf.subarray(start, end)),
    ),
    size: (text) => (NodeBuffer ? NodeBuffer.byteLength(text) : utf8Size(text)),
    write: (buf, offset, text) =>
      NodeBuffer
        ? NodeBuffer.prototype.utf8Write.call(buf, text, offset)
        : utf8Encoder.encodeInto(text, buf.subarray(offset)).written,
  },
  latin1: {
    unit: 1,
    decode: decoder("latin1Slice", fromCodes(1)),
    size: codesSize(0xff),
    write: writeCodes,
  },
  ascii: {
    unit: 1,
    decode: decoder("asciiSlice", fromCodes(1, 0x7f)),
    size: codesSize(0x7f),
    write: writeCodes,
  },
  utf16le: {
    unit: 2,
    decode: decoder("ucs2Slice", fromCodes(2)),
    size: (text) => 2 * text.length,
    write: (buf, offset, text) => {
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        buf[offset + 2 * i] = c & 0xff;
        buf[offset + 2 * i + 1] = c >> 8;
      }
      return 2 * text.length;
    },
  },
};

/**
 * The UTF-8 size of `text` (unpaired surrogates become U+FFFD).
 *
 * @param text The text to measure.
 * @returns The number of bytes.
 */
function utf8Size(text: string): number {
  let size = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) size += 1;
    else if (c < 0x800) size += 2;
    else if (c >> 10 === 0x36 && text.charCodeAt(i + 1) >> 10 === 0x37) {
      // A surrogate pair
      size += 4;
      i++;
    } else size += 3;
  }
  return size;
}

/**
 * The encoded size of `text` (checking that it is a string that can be
 * encoded).
 *
 * @param text The value to encode.
 * @param encoding The text encoding.
 * @returns The number of bytes.
 */
function textSize(text: unknown, encoding: Encoding): number {
  if (typeof text !== "string") {
    throw new EncodeError(`expected a string, got ${String(text)}`);
  }
  const size = texts[encoding].size(text);
  if (size < 0) throw new EncodeError(`\`${text}\` is not ${encoding}`);
  return size;
}

/**
 * The offset of the first unit `u` (of `size` bytes) in `buf[start..end]`, or
 * `end`.
 *
 * @param buf The bytes to search.
 * @param start The offset where the search starts.
 * @param end The offset where the search ends.
 * @param size The size of a unit in bytes.
 * @param u The unit to find.
 * @returns The offset of the unit, or `end` if it is not found.
 */
function find(
  buf: Uint8Array,
  start: number,
  end: number,
  size: number,
  u: number,
): number {
  if (size === 1) {
    const at = buf.subarray(start, end).indexOf(u);
    return at === -1 ? end : start + at;
  }
  let e = start;
  while (e < end && (buf[e] | (buf[e + 1] << 8)) !== u) e += 2;
  return e;
}

/**
 * The end of `buf[start..end]` without trailing units `u` (of `size` bytes).
 *
 * @param buf The bytes of the text.
 * @param start The offset of the text.
 * @param end The offset after the text.
 * @param size The size of a unit in bytes.
 * @param u The unit to remove.
 * @returns The offset after the last unit that is not `u`, or `start`.
 */
function trim(
  buf: Uint8Array,
  start: number,
  end: number,
  size: number,
  u: number,
): number {
  let e = end;
  while (
    e > start &&
    (size === 1 ? buf[e - 1] : buf[e - 2] | (buf[e - 1] << 8)) === u
  ) {
    e -= size;
  }
  return e;
}

/**
 * Fills `buf[start..end]` with units `u` (of `size` bytes).
 *
 * @param buf The bytes to fill.
 * @param start The offset of the first unit.
 * @param end The offset after the last unit.
 * @param size The size of a unit in bytes.
 * @param u The unit to write.
 */
function fill(
  buf: Uint8Array,
  start: number,
  end: number,
  size: number,
  u: number,
): void {
  if (size === 1 || u >> 8 === (u & 0xff)) buf.fill(u & 0xff, start, end);
  else {
    for (let i = start; i < end; i += 2) {
      buf[i] = u & 0xff;
      buf[i + 1] = u >> 8;
    }
  }
}

/** Options of a string stored in its length (or after its count, or up to the end of the input). */
export interface StringOptions {
  /** The text encoding (default: `"utf8"`). `"utf16le"` keeps code units as they are (including BOMs and unpaired surrogates). */
  encoding?: Encoding | undefined;
  /** The byte (or UTF-16 unit) the text ends with, if it is shorter than its storage. */
  terminator?: number | undefined;
  /** The byte (or UTF-16 unit) filling the storage after the text (default: zeros); without a terminator, it is removed when decoding. */
  padRight?: number | undefined;
}

/** Options of a string ending with a terminator. */
export interface TerminatedStringOptions<Ctx = never> {
  /** The byte (or UTF-16 unit) the text ends with. */
  terminator: number;
  /**
   * The most bytes the string takes, terminator included (default: no
   * limit): a number, an earlier number field or a function of the
   * earlier fields. A string of `max` bytes has no terminator.
   */
  max?: Exclude<Length<Ctx>, Codec<number>> | undefined;
  /** The text encoding (default: `"utf8"`). */
  encoding?: Encoding | undefined;
}

type NoExtra<T, Shape> = {
  [K in Exclude<keyof T, keyof Shape>]: {
    readonly [Reason in `unknown option ${K & string}`]: never;
  };
};
type StringLength<Ctx> = Length<Ctx> | TerminatedStringOptions<Ctx>;
type StringBound<L> = L extends { max?: infer M } ? M : L;

const encodings = new Set<string>(["utf8", "latin1", "ascii", "utf16le"]);

/**
 * Checks options when a string is defined: known keys, and units of the
 * encoding.
 *
 * @param raw The options given.
 * @param keys The names of the options the string takes.
 * @returns The encoding (by default `"utf8"`), terminator and padding.
 */
function options(
  raw: object,
  keys: readonly string[],
): {
  encoding: Encoding;
  terminator: number | undefined;
  padRight: number | undefined;
} {
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) throw new TypeError(`unknown option \`${key}\``);
  }
  const o = raw as {
    encoding?: Encoding;
    terminator?: number;
    padRight?: number;
  };
  const encoding = o.encoding ?? "utf8";
  if (!encodings.has(encoding)) {
    throw new TypeError(`unknown encoding \`${encoding}\``);
  }
  const top = encoding === "utf16le" ? 0xffff : 0xff;
  for (const key of ["terminator", "padRight"] as const) {
    const u = o[key];
    if (u !== undefined && !(Number.isInteger(u) && u >= 0 && u <= top)) {
      throw new TypeError(`invalid ${key} ${String(u)} for ${encoding}`);
    }
  }
  return { encoding, terminator: o.terminator, padRight: o.padRight };
}

/**
 * A string: stored in its length (a number, field or function: the whole
 * length is used), after its count (`string(u8)`), or up to the end of the
 * input (`Infinity`). It ends at its `terminator` or before its padding,
 * if it has them, and else takes all of its bytes. Or, given only options, a
 * string ending with a terminator (of at most `max` bytes, terminator
 * included: a string of `max` bytes has none).
 */
export function string<
  Ctx = never,
  const L extends StringLength<Ctx> = StringLength<Ctx>,
>(
  length: L &
    (L extends TerminatedStringOptions<Ctx>
      ? NoExtra<L, TerminatedStringOptions<Ctx>>
      : unknown),
  options?: L extends TerminatedStringOptions<Ctx> ? never : StringOptions,
): Codec<string, string, LengthNeeds<StringBound<L>, Ctx>>;
export function string(
  length: AnyLength | TerminatedStringOptions<Obj>,
  opts: StringOptions = {},
): AnyCodec {
  if (typeof length === "object" && !(length instanceof Codec)) {
    if (arguments.length > 1) {
      throw new TypeError("terminated string options take no second argument");
    }
    const { max = Infinity } = length;
    if (max instanceof Codec) throw new TypeError("`max` is not a count");
    if (length.terminator === undefined) {
      throw new TypeError("a string without a length needs a terminator");
    }
    return new Str(
      checked(max as AnyLength, "max"),
      options(length, ["terminator", "max", "encoding"]),
      true,
    );
  }
  return new Str(
    checked(length),
    options(opts, ["encoding", "terminator", "padRight"]),
  );
}

class Str extends Codec<string> {
  /** The storage length, or the cap when `terminated`. */
  private readonly length: AnyLength;
  /** Stops at a terminator instead of consuming the whole storage length. */
  private readonly terminated: boolean;
  private readonly encoding: Encoding;
  private readonly terminator: number | undefined;
  private readonly pad: number | undefined;

  constructor(
    length: AnyLength,
    opts: ReturnType<typeof options>,
    terminated = false,
  ) {
    const { unit } = texts[opts.encoding];
    if (
      typeof length === "number" &&
      Number.isFinite(length) &&
      length % unit
    ) {
      throw new TypeError(`odd length ${length} for utf16le`);
    }
    super(terminated ? Number.NaN : fixed(length), false, lengthReads(length));
    this.length = length;
    this.terminated = terminated;
    this.encoding = opts.encoding;
    this.terminator = opts.terminator;
    this.pad = opts.padRight;
  }

  private get unit(): number {
    return texts[this.encoding].unit;
  }

  emitRead(g: Gen, wanted: boolean): string {
    if (this.terminated) return this.readTerminated(g, wanted);
    const n = readLength(g, this.length, this.unit);
    g.need(n);
    let v = "";
    if (wanted) {
      const { unit, terminator, pad } = this;
      const [start, stop] = [g.at(), g.at(n)];
      const e =
        terminator === undefined
          ? pad === undefined
            ? stop
            : g.callback(trim, "buf", start, stop, `${unit}`, `${pad}`)
          : g.callback(find, "buf", start, stop, `${unit}`, `${terminator}`);
      v = g.let(`${g.k(texts[this.encoding].decode)}(buf, ${start}, ${e})`);
    }
    g.skip(n);
    return v;
  }

  /**
   * Reads a string up to its terminator (or `max` bytes).
   *
   * @param g The generator of the function.
   * @param wanted Whether the value is decoded (else it is stepped over).
   * @returns The variable holding the string, or "" if it is not wanted.
   */
  private readTerminated(g: Gen, wanted: boolean): string {
    const { unit } = this;
    const t = this.terminator!;
    g.flush();
    const cap =
      this.length === Infinity
        ? "Infinity"
        : `o + ${readLength(g, this.length, unit)}`;
    const e = g.let("o", "let");
    const at = unit === 1 ? `buf[${e}]` : `(buf[${e}] | buf[${e} + 1] << 8)`;
    const scan = `while (${e} + ${unit} <= end && ${e} + ${unit} <= ${cap} && ${at} !== ${t}) ${e} += ${unit};`;
    // Found the terminator, or reached the maximum.
    const found = `${e} + ${unit} <= end && ${e} + ${unit} <= ${cap}`;
    const full = `${cap} <= end`;
    if (g.mode === "resume") {
      g.line(
        `for (;;) { ${scan} if (${found} || ${full}) break; yield ${e} + ${unit}; ${g.reload()} }`,
      );
    } else {
      g.line(scan);
      g.check(
        `!(${found}) && !(${full})`,
        "end-of-input",
        `"unexpected end of input (no terminator)"`,
        "o",
      );
    }
    const v = wanted
      ? g.let(`${g.k(texts[this.encoding].decode)}(buf, o, ${e})`)
      : "";
    g.seek(`${found} ? ${e} + ${unit} : ${e}`);
    return v;
  }

  emitWrite(g: Gen, value: string): void {
    const { unit, terminator, pad, length } = this;
    if (
      this.encoding === "utf8" &&
      terminator === undefined &&
      pad === undefined &&
      (length === Infinity || length instanceof Primitive)
    ) {
      writeFirst(g, value, length);
      return;
    }
    const size = g.callback(textSize, value, JSON.stringify(this.encoding));
    const t = terminator === undefined ? 0 : unit;
    if (this.terminated) {
      // Up to the terminator, or the maximum.
      const max =
        length === Infinity ? "Infinity" : readLength(g, length, unit);
      g.check(
        `${size} > ${max}`,
        "invalid",
        `"has " + ${size} + " bytes, more than its maximum " + ${max}`,
      );
      const n = g.let(`${size} < ${max} ? ${size} + ${unit} : ${size}`);
      this.store(g, value, size, n);
      return;
    }
    if (length instanceof Codec || length === Infinity) {
      // The text, then the terminator.
      const n = g.let(`${size} + ${t}`);
      if (length instanceof Codec) writeLength(g, length, n, "bytes");
      this.store(g, value, size, n);
      return;
    }
    // The text, the terminator if there is room, then padding.
    const n = readLength(g, length, unit);
    g.check(
      `${size} > ${n}`,
      "invalid",
      `"has " + ${size} + " bytes, more than its length " + ${n}`,
    );
    if (terminator === undefined && pad === undefined) {
      g.check(
        `${size} !== ${n}`,
        "invalid",
        `"has " + ${size} + " bytes, but its length is " + ${n}`,
      );
    }
    this.store(g, value, size, n);
  }

  /**
   * Writes the text of `size` bytes, and its terminator and padding up to `n`
   * bytes.
   *
   * @param g The generator of the function.
   * @param value The variable holding the text.
   * @param size The variable holding the size of the text in bytes.
   * @param n The number of bytes the string takes, or an expression of it.
   */
  private store(g: Gen, value: string, size: string, n: number | string): void {
    const { unit, terminator, pad, encoding } = this;
    if (g.mode === "size") {
      g.skip(n);
      return;
    }
    g.need(n);
    const start = g.let(g.at());
    g.callback(texts[encoding].write, "buf", start, value);
    const end = `${start} + ${size}`;
    if (terminator !== undefined) {
      const found = g.callback(
        find,
        "buf",
        start,
        end,
        `${unit}`,
        `${terminator}`,
      );
      g.check(`${found} !== ${end}`, "invalid", '"contains its terminator"');
    } else if (pad !== undefined) {
      const kept = g.callback(trim, "buf", start, end, `${unit}`, `${pad}`);
      g.check(`${kept} !== ${end}`, "invalid", '"ends with its padding"');
    }
    const rest = `${start} + ${n}`;
    if (terminator === undefined) {
      g.line(
        `if (${end} < ${rest}) ${g.k(fill)}(buf, ${end}, ${rest}, ${unit}, ${pad ?? 0});`,
      );
    } else {
      g.line(
        `if (${end} < ${rest}) ${g.k(fill)}(buf, ${end}, ${end} + ${unit}, ${unit}, ${terminator});`,
      );
      g.line(
        `if (${end} + ${unit} < ${rest}) ${g.k(fill)}(buf, ${end} + ${unit}, ${rest}, ${unit}, ${pad ?? 0});`,
      );
    }
    g.skip(n);
  }
}

/**
 * Writes UTF-8 text, then its count (of a fixed size) before it: making
 * room for 3 bytes per UTF-16 unit (if there is) saves measuring the text.
 *
 * @param g The generator of the function.
 * @param value The variable holding the text.
 * @param count The codec of the count before the text, or `Infinity` for none.
 */
function writeFirst(g: Gen, value: string, count: Primitive | number): void {
  g.check(
    `typeof ${value} !== "string"`,
    "invalid",
    `"expected a string, got " + String(${value})`,
  );
  const before = count instanceof Primitive ? count.size : 0;
  const plus = (n: string): string => (before ? `${before} + ${n}` : n);
  if (g.mode === "size") {
    g.skip(plus(g.let(`${g.k(texts.utf8.size)}(${value})`)));
    return;
  }
  const room = g.let(`3 * ${value}.length`, "let");
  g.line(
    `if (${g.at(before)} + ${room} > buf.length) ${room} = ${g.k(texts.utf8.size)}(${value});`,
  );
  g.need(plus(room));
  const size = g.let(
    `${g.k(texts.utf8.write)}(buf, ${g.at(before)}, ${value})`,
  );
  if (count instanceof Primitive) count.store(g, size, g.at());
  g.skip(plus(size));
}

/** Items until one passes `until` (which ends the array). */
interface Until<T> {
  until: (item: T) => boolean;
}

class List extends Codec<unknown[]> {
  private readonly item: AnyCodec;
  private readonly length: AnyLength | Until<unknown>;

  constructor(item: AnyCodec, length: AnyLength | Until<unknown>) {
    const counted = typeof length !== "object" || length instanceof Codec;
    super(
      length === 0 ? 0 : counted ? fixed(length, item.size) : Number.NaN,
      item.checks,
      counted ? [...lengthReads(length), ...item.reads] : item.reads,
    );
    this.item = item;
    this.length = length;
  }

  emitRead(g: Gen, wanted: boolean): string {
    const { item, length } = this;
    if (
      length === Infinity ||
      (typeof length === "object" && "until" in length)
    ) {
      return this.readUnbounded(g, wanted);
    }
    const n = readLength(g, length);
    if (wanted && !(length instanceof Primitive && length.count)) {
      // Arrays have up to 2^32 - 1 items (more may be stepped over).
      const detail = '"more than 2^32 - 1 items"';
      if (typeof n === "string") {
        g.check(`${n} >= ${2 ** 32}`, "invalid", detail);
      } else if (n >= 2 ** 32) {
        g.fail("invalid", detail);
      }
    }
    const each = Number.isFinite(item.size) ? item.size : 0;
    if (Number.isFinite(item.size)) {
      // Items of a fixed size: one bounds check (and none read, if none checks anything).
      const size = typeof n === "number" ? n * each : `${n} * ${each}`;
      g.need(size);
      if (!wanted && !item.checks) {
        g.skip(size);
        return "";
      }
    }
    const v = wanted ? g.let(`new Array(${n})`) : "";
    g.loop(
      String(n),
      (i) => {
        const x = item.emitRead(g, wanted);
        if (wanted) g.line(`${v}[${i}] = ${x};`);
      },
      each,
    );
    return v;
  }

  /**
   * Items up to the end of the input, or until one passes `until`.
   *
   * @param g The generator of the function.
   * @param wanted Whether the value is decoded (else it is stepped over).
   * @returns The variable holding the array, or "" if it is not wanted.
   */
  private readUnbounded(g: Gen, wanted: boolean): string {
    const { item, length } = this;
    const until =
      typeof length === "object" ? (length as Until<unknown>).until : undefined;
    if (!until) g.rest();
    const v = wanted ? g.let("[]") : "";
    g.loop(undefined, () => {
      if (!until) g.line("if (o >= end) break;");
      const start = g.let("o");
      const x = item.emitRead(g, wanted || Boolean(until));
      if (wanted) g.line(`${v}.push(${x});`);
      const ends = until && g.callback(until, x);
      g.flush();
      // An item reading nothing would be read forever.
      g.check(`o === ${start}`, "invalid", '"an item took no bytes"');
      if (ends !== undefined) g.line(`if (${ends}) break;`);
    });
    return v;
  }

  emitWrite(g: Gen, value: string): void {
    const { item, length } = this;
    g.check(
      `!Array.isArray(${value})`,
      "invalid",
      `"expected an array, got " + String(${value})`,
    );
    const count = g.let(`${value}.length`);
    if (typeof length === "object" && "until" in length) {
      // The last item, and only it, must end the array.
      g.check(`${count} === 0`, "invalid", '"needs an item ending it"');
      g.loop(count, (i) => {
        const x = g.let(`${value}[${i}]`, "let");
        item.emitWrite(g, x);
        const ends = g.callback(length.until, x);
        g.check(
          `!${ends} === (${i} === ${count} - 1)`,
          "invalid",
          `${ends} ? "an item before the last ends the array" : "the last item does not end the array"`,
        );
      });
      return;
    }
    writeLength(g, length, count, "items");
    const each = Number.isFinite(item.size) ? item.size : 0;
    if (g.mode === "size" && each) {
      g.skip(`${count} * ${each}`);
    } else if (item instanceof Primitive) {
      // Numbers: room for all of them first.
      const size = `${count} * ${item.size}`;
      g.need(size);
      g.loop(count, (i) =>
        item.store(g, g.let(`${value}[${i}]`), g.at(`${i} * ${item.size}`)),
      );
      g.skip(size);
    } else {
      // Items of a fixed size: room for all of them first.
      if (each) g.need(`${count} * ${each}`);
      g.loop(
        count,
        (i) => item.emitWrite(g, g.let(`${value}[${i}]`, "let")),
        each,
      );
    }
  }
}

/**
 * Items of `item`: as many as `length` says (a count read before them, as
 * `array(u16le, u8)`, is written from the array), or up to the first that
 * passes `until`, which is included (encoding needs exactly the last item to
 * pass it). `Infinity`: up to the end of the input or region.
 */
export function array<
  O,
  I,
  Ctx = never,
  ItemCtx = unknown,
  const L extends Length<Ctx> | { until: (item: O) => boolean } =
    | Length<Ctx>
    | { until: (item: O) => boolean },
>(
  item: Codec<O, I, ItemCtx>,
  length: L &
    (L extends { until: (item: O) => boolean }
      ? NoExtra<L, { until: (item: O) => boolean }>
      : unknown),
): Codec<
  O[],
  L extends { until: (item: O) => boolean }
    ? [I] extends [O]
      ? readonly I[]
      : never
    : readonly I[],
  ItemCtx & LengthNeeds<L, Ctx>
>;
export function array(
  item: AnyCodec,
  length: AnyLength | Until<unknown>,
): AnyCodec {
  if (typeof length === "object" && !(length instanceof Codec)) {
    for (const key of Object.keys(length)) {
      if (key !== "until") throw new TypeError(`unknown option \`${key}\``);
    }
    if (typeof length.until !== "function") {
      throw new TypeError("`until` is not a function");
    }
    return new List(item, { until: length.until });
  }
  return new List(item, checked(length));
}

class Sized extends Codec {
  private readonly length: AnyLength;
  private readonly inner: AnyCodec;

  constructor(length: AnyLength, inner: AnyCodec) {
    if (length instanceof Codec && !Number.isFinite(length.size)) {
      throw new TypeError(
        "the size of a region read before it must have a fixed size (e.g. `u32le`)",
      );
    }
    const size = fixed(length);
    super(
      size,
      inner.checks || !Number.isFinite(inner.size) || inner.size > size,
      [...lengthReads(length), ...inner.reads],
    );
    this.length = length;
    this.inner = inner;
  }

  override get preset(): { readonly value: unknown } | undefined {
    return this.inner.preset;
  }

  emitRead(g: Gen, wanted: boolean): string {
    const n = readLength(g, this.length);
    g.need(n);
    // The value may not read past the region, and the bytes it leaves are skipped.
    const codec = this.inner;
    const fn = g.k(compile(codec, "decode", wanted ? "all" : "none", true));
    const scope = scoped(codec) ? `, ${g.context(codec.reads)}` : "";
    g.flush();
    const [start, end, final, v] = [
      g.let("o"),
      g.let("cur.end"),
      g.let("cur.final"),
      g.let("undefined", "let"),
    ];
    g.line(`cur.offset = o; cur.end = o + ${n}; cur.final = true;`);
    g.guard(
      `${v} = ${fn}(cur${scope});`,
      `cur.end = ${end}; cur.final = ${final};`,
    );
    g.seek(`${start} + ${n}`);
    return wanted ? v : "";
  }

  emitWrite(g: Gen, value: string): void {
    const { length } = this;
    if (length instanceof Codec) {
      // The size, read before the value, is written once the value is.
      g.need(length.size);
      g.flush();
      const at = g.let("o - w.base");
      g.skip(length.size);
      g.call(this.inner, value);
      const used = g.let(`o - w.base - ${at} - ${length.size}`, "let");
      if (length instanceof Primitive) {
        length.store(g, used, `w.base + ${at}`);
      } else {
        const write = g.k(compile(length, "encode"));
        g.flush();
        if (g.mode !== "size") {
          g.guard(
            `const e = o; w.offset = w.base + ${at}; ${write}(w, ${used}); w.offset = o = e;`,
          );
        }
      }
      return;
    }
    g.flush();
    const start = g.let("o - w.base");
    g.call(this.inner, value);
    if (length === Infinity) return;
    const size = readLength(g, length);
    const used = g.let(`o - w.base - ${start}`);
    g.check(
      `${used} > ${size}`,
      "invalid",
      `"needs " + ${used} + " bytes, more than its size " + ${size}`,
    );
    const padding = g.let(`${size} - ${used}`);
    g.need(padding);
    g.write(`buf.fill(0, o, o + ${padding});`);
    g.skip(padding);
  }
}

/**
 * A value in a region of `length` bytes: it may not read past them (and
 * bytes it does not read are skipped); when encoding, the rest of them is
 * filled with zeros. A size read before the region (which must be of a
 * fixed size, e.g. `u32le`) is written after its value.
 *
 * @param length The number of bytes, a codec of it, a field or a function.
 * @param codec The codec of the value in the region.
 * @returns A codec of the value.
 */
export function sized<
  O,
  I,
  Ctx = never,
  ItemCtx = unknown,
  const L extends Length<Ctx> = Length<Ctx>,
  D extends boolean = false,
>(
  length: L,
  codec: Codec<O, I, ItemCtx> & { readonly [defaulted]?: D },
): Codec<O, I, ItemCtx & LengthNeeds<L, Ctx>> &
  ([D] extends [true] ? Defaulted : unknown) {
  return new Sized(checked(length as AnyLength), codec) as never;
}

/** A codec that reads `inner` and checks or converts its values. */
abstract class Wrapper extends Codec {
  protected readonly inner: AnyCodec;

  constructor(inner: AnyCodec, checks = inner.checks) {
    super(inner.size, checks, inner.reads);
    this.inner = inner;
  }
}

type Scalar = string | number | bigint | boolean;

class Literal extends Wrapper {
  private readonly value: Scalar;

  constructor(inner: AnyCodec, value: Scalar) {
    if (!["string", "number", "bigint", "boolean"].includes(typeof value)) {
      throw new TypeError(
        `a literal must be a string, number, bigint or boolean`,
      );
    }
    super(inner, true);
    this.value = value;
  }

  override get preset(): { readonly value: unknown } {
    return { value: this.value };
  }

  /**
   * An expression that is true if `v` is not the value (NaN and zeros are
   * compared as by `Object.is`).
   *
   * @param g The generator of the function.
   * @param v An expression of the value to compare.
   * @returns A `!==` comparison, or a negated call of `Object.is`.
   */
  private differs(g: Gen, v: string): string {
    return Number.isNaN(this.value) || this.value === 0
      ? `!Object.is(${v}, ${g.k(this.value)})`
      : `${v} !== ${g.k(this.value)}`;
  }

  emitRead(g: Gen, wanted: boolean): string {
    const at = g.let(g.at());
    const v = this.inner.emitRead(g, true);
    g.check(this.differs(g, v), "invalid", this.mismatch(v), at);
    return wanted ? g.k(this.value) : "";
  }

  emitWrite(g: Gen, value: string): void {
    g.line(`if (${value} === undefined) ${value} = ${g.k(this.value)};`);
    g.check(this.differs(g, value), "invalid", this.mismatch(value));
    this.inner.emitWrite(g, value);
  }

  private mismatch(value: string): string {
    return `${JSON.stringify(`expected ${String(this.value)}, got `)} + String(${value})`;
  }
}

/**
 * A fixed value: decoding checks it (as `Object.is`), and encoding writes
 * it. Its input may be omitted (if `codec` encodes it).
 *
 * @param codec The codec of the value.
 * @param value The value: a string, number, bigint or boolean.
 * @returns A codec of `value`.
 */
export function literal<O, I, Ctx, const V extends O & Scalar>(
  codec: Codec<O, I, Ctx>,
  value: V,
): Codec<V, [V] extends [I] ? V | undefined : never, Ctx> &
  Defaulted<[V] extends [I] ? true : false> {
  return new Literal(codec, value) as never;
}

class Refine extends Wrapper {
  private readonly test: (value: unknown) => boolean;
  private readonly message: string;

  constructor(
    inner: AnyCodec,
    test: (value: unknown) => boolean,
    message: string,
  ) {
    super(inner, true);
    this.test = test;
    this.message = message;
  }

  emitRead(g: Gen, wanted: boolean): string {
    const at = g.let(g.at());
    const v = this.inner.emitRead(g, true);
    g.check(
      `!${g.callbackAt(at, this.test, v)}`,
      "invalid",
      JSON.stringify(this.message),
      at,
    );
    return wanted ? v : "";
  }

  emitWrite(g: Gen, value: string): void {
    g.check(
      `!${g.callback(this.test, value)}`,
      "invalid",
      JSON.stringify(this.message),
    );
    this.inner.emitWrite(g, value);
  }
}

type SameDomain<I, O> = [I] extends [O]
  ? unknown
  : "refine needs a codec that encodes what it decodes";

/** Values that pass `test`, when decoding and encoding (others fail with `message`); a type guard narrows them. */
export function refine<O, I, Ctx, N extends O>(
  codec: Codec<O, I, Ctx> & SameDomain<I, O>,
  test: (value: O) => value is N,
  message?: string,
): Codec<N, I & N, Ctx>;
export function refine<O, I, Ctx>(
  codec: Codec<O, I, Ctx> & SameDomain<I, O>,
  test: (value: O) => boolean,
  message?: string,
): Codec<O, I, Ctx>;
export function refine(
  codec: AnyCodec,
  test: (value: unknown) => boolean,
  message = "invalid value",
): AnyCodec {
  return new Refine(codec, test, message);
}

class Mapped extends Wrapper {
  private readonly toValue: (raw: unknown) => unknown;
  private readonly toRaw: ((value: unknown) => unknown) | undefined;

  constructor(
    inner: AnyCodec,
    toValue: (raw: unknown) => unknown,
    toRaw?: (value: unknown) => unknown,
  ) {
    super(inner);
    this.toValue = toValue;
    this.toRaw = toRaw;
  }

  emitRead(g: Gen, wanted: boolean): string {
    if (!wanted) return this.inner.emitRead(g, false);
    const at = g.let(g.at());
    return g.callbackAt(at, this.toValue, this.inner.emitRead(g, true));
  }

  emitWrite(g: Gen, value: string): void {
    if (!this.toRaw) {
      g.fail(
        "invalid",
        '"this value can only be decoded (it has no encode function)"',
      );
      return;
    }
    this.inner.emitWrite(g, g.callback(this.toRaw, value));
  }
}

/**
 * Values converted both ways (the input is the decoded type, unless `encode`
 * takes another one), or, without `encode`, only when decoding.
 */
export function map<Raw, RawIn, Ctx, O, I = O>(
  codec: Codec<Raw, RawIn, Ctx>,
  convert: { decode: (value: Raw) => O; encode: (value: I) => RawIn },
): Codec<O, I, Ctx>;
export function map<Raw, RawIn, Ctx, O>(
  codec: Codec<Raw, RawIn, Ctx>,
  convert: { decode: (value: Raw) => O },
): Codec<O, never, Ctx>;
export function map(
  codec: AnyCodec,
  convert: {
    decode: (raw: unknown) => unknown;
    encode?: (value: unknown) => unknown;
  },
): AnyCodec {
  return new Mapped(codec, convert.decode, convert.encode);
}

class Presence extends Codec {
  private readonly flag: AnyCodec | undefined;
  private readonly condition: string | ((fields: Obj) => unknown) | undefined;
  private readonly inner: AnyCodec;

  constructor(
    inner: AnyCodec,
    flag?: AnyCodec,
    condition?: string | ((fields: Obj) => unknown),
  ) {
    super(Number.NaN, inner.checks || Boolean(flag?.checks), [
      ...(flag ? flag.reads : lengthReads(condition as AnyLength | undefined)),
      ...inner.reads,
    ]);
    this.flag = flag;
    this.condition = condition;
    this.inner = inner;
  }

  /**
   * Emits code computing the condition (`when`); returns it.
   *
   * @param g The generator of the function.
   * @returns An expression that is truthy if the condition holds.
   */
  private holds(g: Gen): string {
    const { condition } = this;
    if (typeof condition === "string") return g.ref(condition);
    const holds = g.callback(condition!, g.context());
    g.check(
      `typeof ${holds} !== "boolean"`,
      "invalid",
      `"the condition returned " + String(${holds}) + ", not a boolean"`,
    );
    return holds;
  }

  emitRead(g: Gen, wanted: boolean): string {
    const present = this.flag
      ? `${this.flag.emitRead(g, true)} !== 0`
      : this.holds(g);
    const v = wanted ? g.let("null", "let") : "";
    g.block(`if (${present})`, () => {
      const x = this.inner.emitRead(g, wanted);
      if (wanted) g.line(`${v} = ${x};`);
    });
    return v;
  }

  emitWrite(g: Gen, value: string): void {
    g.check(`${value} === undefined`, "invalid", '"expected a value, or null"');
    const present = g.let(`${value} !== null`);
    if (this.flag) {
      this.flag.emitWrite(g, g.let(`${present} ? 1 : 0`, "let"));
    } else {
      const holds = this.holds(g);
      g.check(
        `Boolean(${holds}) !== ${present}`,
        "invalid",
        `${present} ? "must be null (its condition is false)" : "is null, but its condition holds"`,
      );
    }
    g.block(`if (${present})`, () => this.inner.emitWrite(g, value));
  }
}

/**
 * A value after a flag that is non-zero if it is present, or `null`.
 * Encoding writes 0 for `null`, else 1.
 *
 * @param flag The codec of the flag.
 * @param codec The codec of the value.
 * @returns A codec of the value, or `null`.
 */
export function optional<O, I, Ctx = unknown>(
  flag: Codec<number>,
  codec: Codec<O, I, Ctx>,
): Codec<O | null, Exclude<I, undefined> | null, Ctx> {
  return new Presence(codec, flag) as never;
}

type Condition<Ctx> =
  | ([Ctx] extends [never] ? string : KeysOf<Ctx, unknown>)
  | ((fields: Ctx) => boolean);

/**
 * A value if `condition` holds, or `null`: an earlier field is truthy, or a
 * function of the earlier fields returns `true`. Encoding checks that values
 * are `null` exactly when it does not hold.
 *
 * @param condition The name of an earlier field, or a function of the fields.
 * @param codec The codec of the value.
 * @returns A codec of the value, or `null`.
 */
export function when<
  O,
  I,
  Ctx = never,
  ItemCtx = unknown,
  const C extends Condition<Ctx> = Condition<Ctx>,
>(
  condition: C,
  codec: Codec<O, I, ItemCtx>,
): Codec<
  O | null,
  Exclude<I, undefined> | null,
  ItemCtx & Needs<C, Ctx, unknown>
> {
  if (typeof condition !== "function" && typeof condition !== "string") {
    throw new TypeError(`invalid condition ${String(condition)}`);
  }
  return new Presence(
    codec,
    undefined,
    condition as string | ((fields: Obj) => unknown),
  ) as never;
}

class Lazy extends Codec {
  private readonly factory: () => AnyCodec;
  #target: AnyCodec | undefined;

  constructor(factory: () => AnyCodec) {
    super(Number.NaN, true);
    this.factory = factory;
  }

  private get target(): AnyCodec {
    return (this.#target ??= this.factory());
  }

  override get preset(): { readonly value: unknown } | undefined {
    return this.target.preset;
  }

  // Functions of their own, as the codec may contain itself.
  emitRead(g: Gen, wanted: boolean): string {
    return g.call(this.target, wanted);
  }

  emitWrite(g: Gen, value: string): void {
    g.call(this.target, value);
  }
}

/**
 * A codec defined later (when first used), for formats that contain
 * themselves: annotate the codec it is in (`const Tree: Codec<Tree> = …`).
 *
 * @param factory Returns the codec (it is called once, when first needed).
 * @returns A codec that decodes and encodes as the codec `factory` returns.
 */
export function lazy<O, I = O, D extends boolean = false>(
  factory: () => Codec<O, I> & { readonly [defaulted]?: D },
): Codec<O, I> & ([D] extends [true] ? Defaulted : unknown) {
  return new Lazy(factory) as never;
}

class Fail extends Codec<never> {
  private readonly message: string;

  constructor(message: string) {
    super(Number.NaN, true);
    this.message = message;
  }

  emitRead(g: Gen): string {
    g.fail("invalid", JSON.stringify(this.message));
    return "undefined";
  }

  emitWrite(g: Gen): void {
    g.fail("invalid", JSON.stringify(this.message));
  }
}

/**
 * Fails decoding and encoding (e.g. for parts that are not supported).
 *
 * @param message The detail of the errors.
 * @returns A codec that fails.
 */
export function fail(message: string): Codec<never> {
  return new Fail(message);
}
