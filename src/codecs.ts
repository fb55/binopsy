import {
  Codec,
  fillIn,
  writeValue,
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
import { Wrapper } from "./wrapper.ts";

/** The names of the fields of type `V` in every variant of `T`. (Mapping `keyof T & string` keeps it from mapping each variant.) */
export type KeysOf<T, V> = {
  [K in keyof T & string]-?: [T[K]] extends [V] ? K : never;
}[keyof T & string];

/**
 * A length: a number (`Infinity`: up to the end of the input, or of the
 * enclosing `sized` region), the name of an earlier number field, a function
 * of the earlier fields, or a codec of a count read just before the value
 * (`string(u8)`). Lengths are non-negative safe integers. Outside a parser,
 * any name is accepted, and becomes a field the codec reads (see `Context`).
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

export type LengthNeeds<L, Ctx> = Needs<L, Ctx, number>;

type AnyLength = number | string | AnyCodec | ((fields: Obj) => number);

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

function checkCount(g: Gen, v: string): void {
  // Also when sizing: a negative length would take bytes off later fields.
  g.check(
    `!(Number.isSafeInteger(${v}) && ${v} >= 0)`,
    "invalid",
    `"invalid length " + String(${v})`,
    g.at(),
    true,
  );
}

/**
 * @param g The generator of the function.
 * @param length The length of the value.
 * @param unit The size of a unit in bytes (lengths of 2-byte units are even).
 * @returns The length if it is a number, else an expression of it.
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

function given(g: Gen, length: Exclude<AnyLength, number>): string {
  return typeof length === "string"
    ? g.ref(length)
    : typeof length === "function"
      ? g.callback(length, g.context())
      : length.emitRead(g, true);
}

/**
 * Writes the count `length` is read from, or checks that the value has the
 * length.
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
    writeValue(g, length, v);
    return;
  }
  if (g.mode === "size") return;
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
 * Bytes, decoded as views of the input: `new Uint8Array(b)` copies them
 * (`slice()` does not, for `Buffer`s). Encoding checks their length, or
 * writes the count read before them.
 *
 * @param length The number of bytes (`Infinity`: the rest of the input), an
 *   earlier field, a function, or a codec of a count before them.
 * @returns A codec of `Uint8Array`s.
 * @throws {TypeError} If `length` is invalid (when defined).
 * @example
 * const Chunk = bin().u32be("length").field("data", bytes("length"));
 */
export function bytes<Ctx = never, const L extends Length<Ctx> = Length<Ctx>>(
  length: L,
): Codec<Uint8Array, Uint8Array, LengthNeeds<L, Ctx>> {
  return new Bytes(checked(length as AnyLength));
}

/**
 * Text encodings. `latin1` maps bytes to the first 256 code points (it is
 * not Windows-1252). Decoding keeps byte order marks; malformed UTF-8
 * becomes U+FFFD, UTF-16 keeps unpaired surrogates, and ASCII ignores the
 * high bit. Encoding rejects characters that latin1 or ASCII do not have.
 */
export type Encoding = "utf8" | "latin1" | "ascii" | "utf16le";

interface Text {
  /** The size of a unit (of terminators and padding) in bytes. */
  unit: number;
  decode: (buf: Uint8Array, start: number, end: number) => string;
  /** The size of `text` in bytes (or -1 if it cannot be encoded). */
  size: (text: string) => number;
  /** Returns the size of the text written. */
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
 * Methods of Node.js buffers are faster than the fallbacks.
 *
 * @param method A method of `Buffer`s.
 * @param fallback The decoder where there are no `Buffer`s.
 * @returns The decoder.
 */
/* @__NO_SIDE_EFFECTS__ */
function decoder(
  method: keyof NodeBuffer["prototype"],
  fallback: Text["decode"],
): Text["decode"] {
  const slice = NodeBuffer?.prototype[method] as Slice | undefined;
  return slice ? (buf, start, end) => slice.call(buf, start, end) : fallback;
}

/* @__NO_SIDE_EFFECTS__ */
function fromCodes(size: 1 | 2, mask = 0xffff): Text["decode"] {
  return (buf, start, end) => {
    const codes = [];
    for (let i = start; i < end; i += size) {
      codes.push((size === 1 ? buf[i] : buf[i] | (buf[i + 1] << 8)) & mask);
    }
    let text = "";
    // In slices: spreading too many arguments overflows the stack.
    for (let i = 0; i < codes.length; i += 4096) {
      text += String.fromCharCode(...codes.slice(i, i + 4096));
    }
    return text;
  };
}

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

const utf8 = /* @__PURE__ */ new TextDecoder("utf-8", { ignoreBOM: true });
const utf8Encoder = /* @__PURE__ */ new TextEncoder();

const texts: Record<Encoding, Text> = {
  utf8: {
    unit: 1,
    decode: decoder("utf8Slice", (buf, start, end) =>
      utf8.decode(buf.subarray(start, end)),
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
 * Where there are no Node.js buffers.
 *
 * @param text Any string.
 * @returns Its size in UTF-8, where unpaired surrogates become U+FFFD.
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

function textSize(text: unknown, encoding: Encoding): number {
  if (typeof text !== "string") {
    throw new EncodeError(`expected a string, got ${String(text)}`);
  }
  const size = texts[encoding].size(text);
  if (size < 0) throw new EncodeError(`\`${text}\` is not ${encoding}`);
  return size;
}

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

/** Options of `string(length, options)`. */
export interface StringOptions {
  /** The text encoding (default `"utf8"`). */
  encoding?: Encoding | undefined;
  /**
   * The byte (or, in UTF-16, the 16-bit unit) ending text shorter than its
   * length. Decoding stops at the first one. Encoding writes it after the
   * text (in a fixed length, if there is room), and rejects text containing it.
   */
  terminator?: number | undefined;
  /**
   * The byte (or UTF-16 unit) filling the rest of the length when encoding
   * (default 0). Without a terminator, decoding removes it from the end of
   * the text, and encoding rejects text ending with it.
   */
  padRight?: number | undefined;
}

/** Options of `string({ terminator, max?, encoding? })`. */
export interface TerminatedStringOptions<Ctx = never> {
  /**
   * The byte (or, in UTF-16, the 16-bit unit) ending the text. Decoding
   * fails if the input ends first (unless `max` bytes are read); encoding
   * rejects text containing it.
   */
  terminator: number;
  /**
   * The most bytes the string takes, terminator included (default: no
   * limit): a number, an earlier number field or a function of the
   * earlier fields. A string of `max` bytes has no terminator.
   */
  max?: Exclude<Length<Ctx>, Codec<number>> | undefined;
  /** The text encoding (default `"utf8"`). */
  encoding?: Encoding | undefined;
}

/** Makes options outside `Shape` errors naming them (inferred type arguments skip excess property checks). */
type NoExtra<T, Shape> = {
  [K in Exclude<keyof T, keyof Shape>]: {
    readonly [Reason in `unknown option ${K & string}`]: never;
  };
};
type StringLength<Ctx> = Length<Ctx> | TerminatedStringOptions<Ctx>;
type StringBound<L> = L extends { max?: infer M } ? M : L;

const encodings = new Set<string>(["utf8", "latin1", "ascii", "utf16le"]);

function options(
  o: StringOptions,
  keys: readonly string[],
): StringOptions & { encoding: Encoding } {
  for (const key of Object.keys(o)) {
    if (!keys.includes(key)) throw new TypeError(`unknown option \`${key}\``);
  }
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
 * Text stored in `length` bytes, or ending with a terminator.
 *
 * `string(length, options?)` takes all of `length` bytes: without options,
 * the text fills them exactly; a `terminator` or `padRight` allows shorter
 * text. `string({ terminator, max? })` takes the bytes up to and including
 * the terminator, or `max` bytes. Lengths are in bytes, also in UTF-16. See
 * the README section on strings.
 *
 * @param length The number of bytes (`Infinity`: the rest of the input), an
 *   earlier field, a function, or a codec of a count before the text; or the
 *   options of text ending with a terminator.
 * @param options The encoding (default `"utf8"`), terminator and padding.
 * @returns A codec of strings.
 * @throws {TypeError} If the length or an option is invalid (when defined).
 * @example
 * string(u8); // A length byte, then UTF-8 text
 * string(16, { terminator: 0 }); // 16 bytes, the text ending with a zero
 * string({ terminator: 0, max: 64 }); // Up to a zero, at most 64 bytes
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
  /** The storage length, or the cap of `string({ terminator, max })` (`terminated`). */
  private readonly length: AnyLength;
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
    if (
      g.mode === "size" &&
      !this.terminated &&
      !(length instanceof Codec) &&
      length !== Infinity
    ) {
      // Its length, whatever its text's.
      g.skip(readLength(g, length, unit));
      return;
    }
    const size = g.callback(textSize, value, JSON.stringify(this.encoding));
    const t = terminator === undefined ? 0 : unit;
    if (this.terminated) {
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
   * Writes the text, then its terminator and padding up to `n` bytes.
   *
   * @param g The generator of the function.
   * @param value The variable of the text.
   * @param size The variable of the size of the text in bytes.
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
    if (encoding === "utf8" && terminator !== undefined && terminator < 128) {
      // ASCII bytes only occur as those characters in UTF-8.
      g.check(
        `${value}.includes(${g.k(String.fromCharCode(terminator))})`,
        "invalid",
        '"contains its terminator"',
      );
    } else if (terminator !== undefined) {
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
 * Writes UTF-8 text, then the count before it: room for 3 bytes per UTF-16
 * unit, if there is, saves measuring the text.
 *
 * @param g The generator of the function.
 * @param value The variable of the text.
 * @param count The codec of the count (of a fixed size), or `Infinity`.
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
    if (wanted && item instanceof Primitive) {
      g.usesView ||= item.usesView;
      const start = item.usesView ? g.let(g.viewAt()) : undefined;
      g.loop(String(n), (i) => {
        const index = `${i} * ${each}`;
        g.line(
          `${v}[${i}] = ${item.expr(g.at(index), start === undefined ? undefined : `${start} + ${index}`)};`,
        );
      });
      g.skip(typeof n === "number" ? n * each : `${n} * ${each}`);
      return v;
    }
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
    const terminated = typeof length === "object" && "until" in length;
    if (terminated && g.mode !== "size") {
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
    if (!terminated) writeLength(g, length, count, "items");
    const each = Number.isFinite(item.size) ? item.size : 0;
    if (g.mode === "size" && Number.isFinite(item.size)) {
      g.skip(each ? `${count} * ${each}` : 0);
    } else if (item instanceof Primitive) {
      // Numbers: one bounds check for all of them.
      const size = `${count} * ${item.size}`;
      g.need(size);
      g.loop(count, (i) =>
        item.store(g, g.let(`${value}[${i}]`), g.at(`${i} * ${item.size}`)),
      );
      g.skip(size);
    } else {
      // Items of a fixed size: one bounds check for all of them.
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
 * Items of one codec: as many as `length` says, or up to and including the
 * first for which `until` returns `true`.
 *
 * A count read before the items (`array(u16le, u8)`) is written from the
 * array; a field or function giving the length must agree with it. To be
 * encoded, an array with `until` needs exactly its last item to pass.
 * Without a count, an item that takes no bytes fails.
 *
 * @param item The codec of the items (not a bit field: use a parser of bit
 *   fields).
 * @param length The number of items (`Infinity`: up to the end of the
 *   input), an earlier field, a function, or a codec of a count before them;
 *   or `{ until }`.
 * @returns A codec of arrays.
 * @throws {TypeError} If `length` is invalid (when defined).
 * @example
 * bin().u8("count").field("ratings", array(u16le, "count"));
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

  override fills(): boolean {
    return this.inner.fills();
  }

  override emitFill(g: Gen, value: string): void {
    this.inner.emitFill(g, value);
  }

  emitRead(g: Gen, wanted: boolean): string {
    const n = readLength(g, this.length);
    g.need(n);
    const codec = this.inner;
    const mode =
      g.mode === "buffer" ? "buffer" : g.mode === "trace" ? "trace" : "decode";
    const fn = g.k(compile(codec, mode, wanted ? "all" : "none", true));
    const scope = scoped(codec) ? `, ${g.context(codec.reads)}` : "";
    g.flush();
    const [start, end, final, v] = [
      g.let("o"),
      g.let("cur.end"),
      g.let("cur.final"),
      g.let("undefined", "let"),
    ];
    const mark = g.mark();
    g.line(`cur.offset = o; cur.end = o + ${n}; cur.final = true;`);
    g.guard(
      `${v} = ${fn}(cur${scope});`,
      `cur.end = ${end}; cur.final = ${final};`,
    );
    g.traced(mark);
    g.seek(`${start} + ${n}`);
    return wanted ? v : "";
  }

  emitWrite(g: Gen, value: string): void {
    // Its value's default is in the fields after it.
    this.emitFill(g, value);
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
    if (g.mode === "size" && length !== Infinity) {
      // The region's size, whatever its value's.
      g.skip(readLength(g, length));
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
 * A value in a region of `length` bytes: the value may not read past the
 * region, and decoding skips the bytes it leaves. Encoding fills them with
 * zeros, and fails if the value takes more.
 *
 * A size read before the region (`sized(u32le, codec)`) is written after
 * the value is, so its codec must have a fixed size. In the region,
 * `Infinity` lengths (e.g. `bytes(Infinity)`) end at its end.
 *
 * @param length The number of bytes, an earlier field, a function, or a
 *   codec of a size before the region.
 * @param codec The codec of the value.
 * @returns A codec of the same values.
 * @throws {TypeError} If `length` is invalid, or a codec without a fixed
 *   size (when defined).
 * @example
 * const Message = bin().u8("type").field("text", string(u8));
 * const Frame = sized(u16be, Message); // A 16-bit size, then the message
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
   * NaN and zeros are compared as by `Object.is`.
   *
   * @param g The generator of the function.
   * @param v An expression of a value.
   * @returns An expression that is true if it is not the literal.
   */
  private differs(g: Gen, v: string): string {
    return Number.isNaN(this.value) || this.value === 0
      ? `!Object.is(${v}, ${g.k(this.value)})`
      : `${v} !== ${g.k(this.value)}`;
  }

  protected readValue(g: Gen, v: string, at: string, wanted: boolean): string {
    g.check(this.differs(g, v), "invalid", this.mismatch(v), at);
    return wanted ? g.k(this.value) : "";
  }

  protected writeValue(g: Gen, value: string): string {
    g.line(`if (${value} === undefined) ${value} = ${g.k(this.value)};`);
    g.check(this.differs(g, value), "invalid", this.mismatch(value));
    return value;
  }

  private mismatch(value: string): string {
    return `${JSON.stringify(`expected ${String(this.value)}, got `)} + String(${value})`;
  }
}

/**
 * A fixed value: decoding fails on any other (a `DecodeError` of code
 * `"invalid"`), and encoding writes it, so it may be omitted from the input.
 *
 * Values are compared as by `Object.is`, and must be ones `codec` stores
 * exactly (not `0.1` in an `f32le`).
 *
 * @param codec The codec of the value.
 * @param value The value: a string, number, bigint or boolean.
 * @returns A codec of `value`.
 * @throws {TypeError} If `value` is not a string, number, bigint or boolean
 *   (when defined).
 * @example
 * const Header = bin().field("magic", literal(string(4), "DATA")).u8("version");
 * Header.encode({ version: 1 }); // Uint8Array [68, 65, 84, 65, 1]
 */
export function literal<
  O,
  I,
  Ctx,
  const V extends O & Scalar,
  P extends boolean = false,
>(
  codec: Codec<O, I, Ctx, P>,
  value: V,
): Codec<V, [V] extends [I] ? V | undefined : never, Ctx, P> &
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

  protected readValue(g: Gen, v: string, at: string, wanted: boolean): string {
    g.check(
      `!${g.callbackAt(at, this.test, v)}`,
      "invalid",
      JSON.stringify(this.message),
      at,
    );
    return wanted ? v : "";
  }

  override fills(): boolean {
    return this.inner.preset !== undefined || this.inner.fills();
  }

  override emitFill(g: Gen, value: string): void {
    fillIn(g, this.inner, value);
  }

  protected writeValue(g: Gen, value: string): string {
    fillIn(g, this.inner, value);
    if (g.mode !== "size") {
      g.check(
        `!${g.callback(this.test, value)}`,
        "invalid",
        JSON.stringify(this.message),
      );
    }
    return value;
  }
}

type SameDomain<I, O> = [I] extends [O]
  ? unknown
  : "refine needs a codec that encodes what it decodes";

/**
 * Values of `codec` that pass `test`, checked when decoding and when
 * encoding: others fail with `message` (a `DecodeError` of code
 * `"invalid"`, or an `EncodeError`). A type guard as `test` narrows the type.
 *
 * @param codec The codec of the values; it must encode what it decodes.
 * @param test Whether a value is valid. It must have no side effects.
 * @param message The detail of the errors (default `"invalid value"`).
 * @returns A codec of the values that pass.
 * @example
 * const Width = refine(u32be, (width) => width > 0, "width must be positive");
 */
export function refine<O, I, Ctx, N extends O, P extends boolean = false>(
  codec: Codec<O, I, Ctx, P> & SameDomain<I, O>,
  test: (value: O) => value is N,
  message?: string,
): Codec<N, I & N, Ctx, P>;
export function refine<O, I, Ctx, P extends boolean = false>(
  codec: Codec<O, I, Ctx, P> & SameDomain<I, O>,
  test: (value: O) => boolean,
  message?: string,
): Codec<O, I, Ctx, P>;
export function refine(
  codec: AnyCodec,
  test: (value: unknown) => boolean,
  message = "invalid value",
): AnyCodec {
  return new Refine(codec, test, message);
}

/** Conversion callbacks around an inner codec. @internal */
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

  // A value that is not wanted is not converted: the inner codec steps over
  // the value, running its own checks.
  override emitRead(g: Gen, wanted: boolean): string {
    if (!wanted) return this.inner.emitRead(g, false);
    const at = g.let(g.at());
    return this.readValue(g, this.inner.emitRead(g, true), at, wanted);
  }

  protected readValue(
    g: Gen,
    raw: string,
    at: string,
    wanted: boolean,
  ): string {
    return wanted ? g.callbackAt(at, this.toValue, raw) : "";
  }

  override emitWrite(g: Gen, value: string): void {
    const raw = this.writeValue(g, value);
    if (this.toRaw) this.inner.emitWrite(g, raw);
  }

  protected writeValue(g: Gen, value: string): string {
    if (!this.toRaw) {
      g.fail(
        "invalid",
        '"this value can only be decoded (it has no encode function)"',
      );
      return "undefined";
    }
    return g.callback(this.toRaw, value);
  }
}

/**
 * Values converted both ways: `decode` converts each value `codec` decodes,
 * and `encode` converts each value back for `codec` to encode. Without
 * `encode`, the codec only decodes (encoding throws an `EncodeError`).
 *
 * The input type is the decoded type, unless `encode` takes another.
 *
 * @param codec The codec of the raw values.
 * @param convert `decode` from a raw value, and optionally `encode` back.
 * @returns A codec of the converted values.
 * @example
 * // An IPv4 address, as "192.168.0.1"
 * const address = map(bytes(4), {
 *   decode: (b) => b.join("."),
 *   encode: (text: string) => Uint8Array.from(text.split("."), Number),
 * });
 */
export function map<Raw, RawIn, Ctx, O, I = O, P extends boolean = false>(
  codec: Codec<Raw, RawIn, Ctx, P>,
  convert: { decode: (value: Raw) => O; encode: (value: I) => RawIn },
): Codec<O, I, Ctx, P>;
export function map<Raw, RawIn, Ctx, O, P extends boolean = false>(
  codec: Codec<Raw, RawIn, Ctx, P>,
  convert: { decode: (value: Raw) => O },
): Codec<O, never, Ctx, P>;
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
      writeValue(g, this.flag, g.let(`${present} ? 1 : 0`, "let"));
    } else if (g.mode !== "size") {
      const holds = this.holds(g);
      g.check(
        `Boolean(${holds}) !== ${present}`,
        "invalid",
        `${present} ? "must be null (its condition is false)" : "is null, but its condition holds"`,
      );
    }
    g.block(`if (${present})`, () => writeValue(g, this.inner, value));
  }
}

/**
 * A value after a flag, or `null`: decoding reads the flag, then the value
 * if the flag is not 0. Encoding writes 1 and the value, or 0 for `null`.
 *
 * @param flag The codec of the flag, e.g. `u8`.
 * @param codec The codec of the value.
 * @returns A codec of the value or `null` (encoding takes `null`, not
 *   `undefined`).
 * @example
 * const Comment = optional(u8, string(u8)); // A flag byte, then the text
 * Comment.encode(null); // Uint8Array [0]
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
 * A value if `condition` holds, or `null`. Encoding writes nothing for
 * `null`, and checks that the value is `null` exactly when the condition
 * does not hold.
 *
 * @param condition The name of an earlier field (it holds if the field is
 *   truthy), or a function of the earlier fields returning a boolean (other
 *   results fail).
 * @param codec The codec of the value.
 * @returns A codec of the value or `null`.
 * @throws {TypeError} If `condition` is not a string or a function (when
 *   defined).
 * @example
 * bin().u8("version").field("checksum", when((o) => o.version >= 2, u32le));
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
  #visiting = false;

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

  override fills(): boolean {
    return this.visit(() => this.target.fills()) ?? false;
  }

  override emitFill(g: Gen, value: string): void {
    this.visit(() => g.isolated(() => this.target.emitFill(g, value)));
  }

  /**
   * The codec may contain itself.
   *
   * @param f A function.
   * @returns What `f` returns, or `undefined` if `f` is already running.
   */
  private visit<T>(f: () => T): T | undefined {
    if (this.#visiting) return undefined;
    this.#visiting = true;
    try {
      return f();
    } finally {
      this.#visiting = false;
    }
  }

  // Functions of their own, as the codec may contain itself (it reads no
  // fields around it).
  emitRead(g: Gen, wanted: boolean): string {
    return g.isolated(() => g.call(this.target, wanted));
  }

  emitWrite(g: Gen, value: string): void {
    // Its value's default is in the fields after it.
    this.emitFill(g, value);
    g.isolated(() => g.call(this.target, value));
  }
}

/**
 * The codec `factory` returns, called when it is first needed: for formats
 * that contain themselves, or codecs defined later. TypeScript cannot infer
 * the type of a codec that refers to itself: annotate it.
 *
 * The codec sees no fields around it: functions in it get only the fields
 * of its own parsers.
 *
 * @param factory Returns the codec. It is called once, when a codec using
 *   it is first compiled (on its first `decode`, `encode`, …).
 * @returns A codec that decodes and encodes as the codec `factory` returns.
 * @example
 * interface Tree {
 *   name: string;
 *   children: Tree[];
 * }
 * const Tree: Codec<Tree> = bin()
 *   .field("name", string(u8))
 *   .field("children", array(lazy(() => Tree), u16le));
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
 * A codec that fails decoding and encoding, e.g. for parts of a format that
 * are not supported.
 *
 * @param message The detail of the errors (a `DecodeError` of code
 *   `"invalid"`, or an `EncodeError`).
 * @returns A codec of no values.
 * @example
 * match("compression")
 *   .case(0, bytes(u32le))
 *   .case(1, fail("compressed data is not supported"));
 */
export function fail(message: string): Codec<never> {
  return new Fail(message);
}
