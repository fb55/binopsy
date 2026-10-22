/**
 * The definition of a parser as a list of normalized fields, shared by the
 * compiled parser (compile.ts), the stream reader (stream.ts) and the
 * serializer (serializer.ts). A field's options are turned into the
 * functions all of them use when the field is defined: `prepare` and `store`
 * apply a parsed value to the object being built, `load` gets the value to
 * serialize.
 */
import { PRIMITIVE_TYPES, type PrimitiveName } from "./primitive-types.ts";

/**
 * Objects built while parsing. Fields are added one by one, so internally
 * they are untyped; the public `Bin<T>` API carries the precise type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Obj = Record<string, any>;

/**
 * A user function. The public API (`Bin<T>`) types its `this` and arguments;
 * here they are the untyped objects and values being parsed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Callback<R> = (this: any, ...args: never[]) => R;

/** A length: a number (`Infinity`: the rest of the input), a parsed field, or computed. */
export type Length = number | string | Callback<number>;

/** A choice tag: a parsed field, or computed. */
export type Tag = string | Callback<string | number>;

/** Options all fields accept, as given by the user. */
export interface ValueOptions {
  formatter?: Callback<unknown>;
  deformatter?: Callback<unknown>;
  /** A value to compare with `===`, or a check. */
  assert?: unknown;
  flatten?: boolean;
}

/** A nested type: a primitive, a parser's fields, or a lazily defined parser. */
export type Type = PrimitiveName | Struct | (() => Struct);

/** A parser's fields, and the constructor of its objects (plain objects if unset). */
export interface Struct {
  readonly fields: readonly Field[];
  readonly create?: new () => object;
}

export interface Named {
  name: string;
  options: ValueOptions;
  /** Turns a parsed value into the stored one and checks it; unset if it is stored as is. */
  prepare: ((obj: Obj, value: unknown) => unknown) | undefined;
  /** Stores a parsed value: `prepare`, then assignment (or flatten). */
  store: (obj: Obj, value: unknown) => void;
  /** Gets the value to serialize (the field, or the object if flattened, then the deformatter). */
  load: (obj: Obj) => unknown;
}

/** One bit field; `pos` counts bits from the most significant bit of the run's first byte. */
export interface Bit extends Named {
  width: number;
  pos: number;
}

export type Field =
  | (Named & { kind: "primitive"; type: PrimitiveName })
  | { kind: "bits"; bits: readonly Bit[]; bytes: number }
  | (Named & {
      kind: "string";
      encoding: BufferEncoding;
      /** For zero-terminated strings, the maximum length. */
      length: Length;
      zeroTerminated: boolean;
    })
  | (Named & { kind: "buffer"; length: Length })
  | (Named & {
      kind: "array";
      type: Type;
      length: Length;
      /** Read up to the end of the input, or until an item passes this check. */
      until?: "eof" | Callback<boolean>;
    })
  | (Named & { kind: "nest"; type: Type; length?: Length })
  | (Named & {
      kind: "choice";
      tag: Tag;
      choices: Readonly<Record<string, Type>>;
      defaultChoice?: Type;
    });

export type Choice = Extract<Field, { kind: "choice" }>;

/** Resolves a lazily defined type. */
export function resolve(type: Type): PrimitiveName | Struct {
  return typeof type === "function" ? type() : type;
}

/** Thrown (as a `RangeError`) when the input ends before a value does. */
export function endOfInput(detail = ""): RangeError {
  return new RangeError(`unexpected end of input${detail}`);
}

function missing(what: string, name: string): never {
  throw new Error(`${what} \`${name}\` not found in object`);
}

/**
 * Evaluates the length of field `name` (`Infinity` is returned as is).
 * Lengths from fields and functions must be non-negative integers.
 */
export function lengthOf(length: Length, obj: Obj, name: string): number {
  if (typeof length === "number") return length;
  const value: unknown =
    typeof length === "function"
      ? length.call(obj, obj as never)
      : length in obj
        ? obj[length]
        : missing("length", length);
  if (!Number.isInteger(value) || (value as number) < 0) {
    invalidLength(value, name);
  }
  return value as number;
}

export function invalidLength(value: unknown, name: string): never {
  throw new Error(`invalid length \`${String(value)}\` for \`${name}\``);
}

/** For arrays up to the end of the input whose items read nothing. */
export function noProgress(name: string): never {
  throw new Error(`an item of \`${name}\` read no input`);
}

/** Evaluates a choice tag. */
export function tagOf(tag: Tag, obj: Obj): string | number {
  if (typeof tag === "function") return tag.call(obj, obj as never);
  return tag in obj ? (obj[tag] as string | number) : missing("tag", tag);
}

/** The type a choice picks for the tag value `key`. */
export function pick(field: Choice, key: string | number): Type {
  const type = field.choices[key] ?? field.defaultChoice;
  if (type === undefined) {
    throw new Error(`invalid choice \`${key}\` for \`${field.name}\``);
  }
  return type;
}

/** Copies the fields of a nested value into `obj` (the `flatten` option). */
function flatten(obj: Obj, value: unknown): void {
  if (
    typeof value !== "object" ||
    (value !== null && Object.hasOwn(value, "__proto__"))
  ) {
    throw new Error(
      "only objects without a `__proto__` field can be flattened",
    );
  }
  Object.assign(obj, value);
}

/**
 * Builds the members of a field that apply its options. `transform` and
 * `untransform` convert between the raw value and the parsed one before the
 * options apply (e.g. stripping zeros, or keying an array).
 */
export function named(
  name: string,
  options: ValueOptions = {},
  transform?: (value: unknown) => unknown,
  untransform?: (value: unknown) => unknown,
): Named {
  const { formatter, deformatter, assert } = options;
  if (formatter && !deformatter) {
    throw new Error(`\`${name}\` has a formatter but no deformatter`);
  }

  const prepare =
    transform || formatter || assert !== undefined
      ? (obj: Obj, raw: unknown): unknown => {
          let value = transform ? transform(raw) : raw;
          if (formatter) value = formatter.call(obj, value as never);
          if (
            assert !== undefined &&
            (typeof assert === "function"
              ? !(assert as Callback<boolean>).call(obj, value as never)
              : value !== assert)
          ) {
            throw new Error(
              `Assert error: \`${name}\` is \`${String(value)}\``,
            );
          }
          return value;
        }
      : undefined;
  const store = (obj: Obj, raw: unknown): void => {
    const value = prepare ? prepare(obj, raw) : raw;
    if (options.flatten) flatten(obj, value);
    else obj[name] = value;
  };

  const load = (obj: Obj): unknown => {
    let value: unknown = options.flatten ? obj : obj[name];
    // A deformatter may compute an omitted value.
    if (deformatter) value = deformatter(value as never, obj as never);
    else if (!options.flatten && !(name in obj)) missing("field", name);
    return untransform ? untransform(value) : value;
  };

  return { name, options, prepare, store, load };
}

/**
 * The size of every value of `type` in bytes, or `NaN` if it varies.
 */
export function fixedSize(type: Type): number {
  if (typeof type === "function") return NaN;
  if (typeof type === "string") return PRIMITIVE_TYPES[type].size;
  let size = 0;
  for (const field of type.fields) size += fieldSize(field);
  return Number.isFinite(size) ? size : NaN;
}

function fieldSize(field: Field): number {
  const length =
    "length" in field && typeof field.length === "number" ? field.length : NaN;
  switch (field.kind) {
    case "primitive":
      return PRIMITIVE_TYPES[field.type].size;
    case "bits":
      return field.bytes;
    case "string":
      return field.zeroTerminated ? NaN : length;
    case "buffer":
      return length;
    case "array":
      if (field.until) return NaN;
      return length === 0 ? 0 : length * fixedSize(field.type);
    case "nest":
      return field.length === undefined ? fixedSize(field.type) : length;
    case "choice":
      return NaN;
  }
}

/** Reads `width` bits starting `pos` bits into `buf[offset]` (most significant bit first). */
export function readBits(
  buf: Buffer,
  offset: number,
  pos: number,
  width: number,
): number {
  let value = 0;
  for (let i = pos, end = pos + width; i < end;) {
    const n = Math.min(8 - (i % 8), end - i);
    const byte = buf[offset + Math.floor(i / 8)];
    value = value * 2 ** n + ((byte >> (8 - (i % 8) - n)) & ((1 << n) - 1));
    i += n;
  }
  return value;
}

/** Inverse of `readBits`; the other bits of the bytes are kept. */
export function writeBits(
  buf: Buffer,
  offset: number,
  pos: number,
  width: number,
  value: number,
): void {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** width) {
    throw new RangeError(`${value} does not fit in ${width} bits`);
  }
  for (let i = pos, end = pos + width; i < end;) {
    const n = Math.min(8 - (i % 8), end - i);
    const shift = 8 - (i % 8) - n;
    const bits = Math.floor(value / 2 ** (end - i - n)) % 2 ** n;
    const at = offset + Math.floor(i / 8);
    buf[at] = (buf[at] & ~(((1 << n) - 1) << shift)) | (bits << shift);
    i += n;
  }
}
