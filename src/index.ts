/// <reference types="node" preserve="true" />
import type { Transform } from "node:stream";
import { parser } from "./compile.ts";
import {
  endOfInput,
  fixedSize,
  invalidLength,
  named,
  resolve,
  type Bit,
  type Callback,
  type Field,
  type Length as LengthSpec,
  type Named,
  type Obj,
  type Struct,
  type Tag,
  type Type,
  type ValueOptions,
} from "./fields.ts";
import {
  PRIMITIVE_TYPES,
  type PrimitiveName,
  type PrimitiveValue,
} from "./primitive-types.ts";
import { serialize, sizeOf } from "./serializer.ts";
import { stream } from "./stream.ts";

export type { PrimitiveName, PrimitiveValue } from "./primitive-types.ts";

/** A nested type: a parser, or the name of a primitive. */
export type TypeOption = Bin<object> | PrimitiveName;

/** The value a parser or primitive parses into. */
export type ValueOf<X> =
  X extends Bin<infer U>
    ? U
    : X extends PrimitiveName
      ? PrimitiveValue<X>
      : never;

/** `T` with a field `K` of type `V`. */
type With<T, K extends string, V> = T & { [P in K]: V };

/**
 * A length: a number of bytes or items (`Infinity`: the rest of the input),
 * the name of a field parsed before, or a function of the object parsed so far.
 */
export type Length<T> =
  number | (keyof T & string) | ((this: T, obj: T) => number);

/** A value the field must equal, or a check it must pass; parsing fails otherwise. */
type Assert<T, V> = Exclude<V, object> | ((this: T, value: V) => boolean);

/** Options of a field that is stored as parsed (`V`). */
export interface PlainOptions<T, V> {
  formatter?: undefined;
  /** Computes the value to serialize (e.g. a checksum). */
  deformatter?: (value: V, obj: T) => V;
  assert?: Assert<T, V>;
}

/** Options of a field that is stored as `formatter` returns it (`R`). */
export interface FormattedOptions<T, V, R> {
  formatter: (this: T, value: V) => R;
  /** Inverse of `formatter`, for serializing. */
  deformatter: (value: NoInfer<R>, obj: T) => V;
  /** Checks the formatted value. */
  assert?: Assert<T, NoInfer<R>>;
}

export type StringOptions<T> = {
  /** Default: `"utf8"`. */
  encoding?: BufferEncoding;
  /** Remove trailing zero bytes. */
  stripNull?: boolean;
} & (
  | { length: Length<T>; zeroTerminated?: boolean }
  /** Up to a zero byte, which is consumed (or up to `length` bytes). */
  | { length?: Length<T>; zeroTerminated: true }
);

export type BufferOptions<T> = {
  /** Copy the bytes instead of referencing the input. */
  clone?: boolean;
} & ({ length: Length<T> } | { readUntil: "eof" });

/** An array has `length` items, or items up to the end of the input or up to an item passing a check. */
export type ArrayOptions<T, E extends TypeOption> = { type: E } & (
  | { length: Length<T>; readUntil?: (item: ValueOf<E>) => boolean }
  | { readUntil: "eof" | ((item: ValueOf<E>) => boolean) }
);

/** Stores an array as an object, keyed by this field of its items. */
interface Keyed<E extends TypeOption> {
  key: keyof ValueOf<E> & string;
}

/** Choices by tag value. */
export type Choices = Record<string | number, TypeOption>;

export interface ChoiceOptions<
  T,
  C extends Choices,
  D extends TypeOption = never,
> {
  /** The field holding the tag, or a function computing it. */
  tag: (keyof T & string) | ((this: T, obj: T) => string | number);
  choices: C;
  /** Used for tag values not in `choices` (otherwise they are an error). */
  defaultChoice?: D;
}

/** Adds the fields of the (formatted) value to the parser's objects. */
interface Flatten {
  flatten: true;
}

interface NoFlatten {
  flatten?: false;
}

/** Options of `fixedSizeNest`. */
interface FixedSize<T, E extends TypeOption> {
  type: E;
  /** The size in bytes. */
  length: Length<T>;
}

/** Result of `parseFrom`. */
export interface ParseResult<T> {
  result: T;
  /** Offset of the first byte after the value. */
  offset: number;
}

interface FieldMethod<T extends object, V> {
  <K extends string, R>(
    name: K,
    options: FormattedOptions<T, V, R>,
  ): Bin<With<T, K, R>>;
  <K extends string>(name: K, options?: PlainOptions<T, V>): Bin<With<T, K, V>>;
}

// prettier-ignore
type BitWidth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16
  | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32;

/** `bit1` … `bit32`: unsigned bit fields. */
type BitMethods<T extends object> = {
  [N in BitWidth as `bit${N}`]: FieldMethod<T, number>;
};

/** Endianness is set by the method name, or by `endianness()` for `uint16` etc. */
type PrimitiveMethods<T extends object> = {
  [N in PrimitiveName | (typeof ALIASES)[number]]: FieldMethod<
    T,
    PrimitiveValue<N>
  >;
};

const ALIASES = [
  "uint16",
  "uint32",
  "uint64",
  "int16",
  "int32",
  "int64",
  "float",
  "double",
] as const;

/** A bit field whose run has not ended yet. */
type PendingBit = Named & { width: number };

// The bit and primitive methods are installed on the prototype below.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface Bin<T extends object = object>
  extends BitMethods<T>, PrimitiveMethods<T> {}

/**
 * A binary parser and serializer. Each field method adds a field and returns
 * the parser, whose type `T` (the type of parsed values) grows accordingly.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class Bin<T extends object = object> {
  #fields: Field[] = [];
  #names = new Set<string>();
  #create: Struct["create"];
  #endian: "le" | "be" = "be";
  /** Consecutive bit fields are read together once the run ends. */
  #bits: PendingBit[] = [];
  /** The fields as of the last change, shared by everything using this parser. */
  #struct: Struct | undefined;
  #lazy: (() => Struct) | undefined;
  /** Parse functions by selected fields (as JSON; `undefined`: all), dropped on every change. */
  #parsers = new Map<string | undefined, Parse>();
  /** The same by `fields` array, as one array is usually passed for many values (with a copy, to notice changes). */
  #parsersByFields = new WeakMap<
    readonly string[],
    { names: string[]; parse: Parse }
  >();

  /** Creates an empty parser. */
  static start(): Bin {
    return new Bin();
  }

  /**
   * A parser defined by `factory` on first use, for formats that contain
   * themselves:
   *
   * ```ts
   * const Tree: Bin<TreeNode> = Bin.start()
   *   .uint8("count")
   *   .array("children", { type: Bin.lazy(() => Tree), length: "count" });
   * ```
   */
  static lazy<U extends object>(factory: () => Bin<U>): Bin<U> {
    const bin = new Bin<U>();
    let struct: Struct | undefined;
    bin.#lazy = () => (struct ??= resolve(factory().#type()) as Struct);
    return bin;
  }

  static {
    const proto = this.prototype as unknown as Record<string, unknown>;
    for (const type of Object.keys(PRIMITIVE_TYPES) as PrimitiveName[]) {
      proto[type] = function (this: Bin, name: string, options?: ValueOptions) {
        return this.#add({ kind: "primitive", ...named(name, options), type });
      };
    }
    for (const alias of ALIASES) {
      proto[alias] = function (
        this: Bin,
        name: string,
        options?: ValueOptions,
      ) {
        const type: PrimitiveName = `${alias}${this.#endian}`;
        return this.#add({ kind: "primitive", ...named(name, options), type });
      };
    }
    for (let width = 1; width <= 32; width++) {
      proto[`bit${width}`] = function (
        this: Bin,
        name: string,
        options?: ValueOptions,
      ) {
        const bit = { ...named(name, options), width };
        this.#claim(name);
        this.#bits.push(bit);
        return this;
      };
    }
  }

  /** Sets the byte order of `uint16` etc. and of bit fields (default: big). */
  endianness(endianness: "little" | "big"): this {
    // Any letter case, as in binary-parser.
    const order = String(endianness).toLowerCase();
    if (order !== "little" && order !== "big") {
      throw new Error(`invalid endianness \`${String(endianness)}\``);
    }
    // Bit fields defined so far keep their byte order.
    this.#flushBits();
    this.#endian = order === "little" ? "le" : "be";
    return this;
  }

  /** Creates parsed values with `new constructorFn()` instead of as plain objects. */
  create<U extends object>(constructorFn: new () => U): Bin<T & U> {
    this.#checkNotLazy();
    this.#create = constructorFn;
    this.#changed();
    return this as unknown as Bin<T & U>;
  }

  string<K extends string, R>(
    name: K,
    options: StringOptions<T> & FormattedOptions<T, string, R>,
  ): Bin<With<T, K, R>>;
  string<K extends string>(
    name: K,
    options: StringOptions<T> & PlainOptions<T, string>,
  ): Bin<With<T, K, string>>;
  string(name: string, options: StringOptionsInternal): Bin {
    const { encoding = "utf8", length, zeroTerminated = false } = options;
    if (length === undefined && !zeroTerminated) {
      throw new Error(`\`${name}\` needs a length or zeroTerminated`);
    }
    const strip = options.stripNull
      ? (value: unknown) => (value as string).replace(/\0+$/, "")
      : undefined;
    return this.#add({
      kind: "string",
      ...named(name, options, strip),
      encoding,
      length: checkLength(name, length ?? Infinity),
      zeroTerminated,
    });
  }

  buffer<K extends string, R>(
    name: K,
    options: BufferOptions<T> & FormattedOptions<T, Buffer, R>,
  ): Bin<With<T, K, R>>;
  buffer<K extends string>(
    name: K,
    options: BufferOptions<T> & PlainOptions<T, Buffer>,
  ): Bin<With<T, K, Buffer>>;
  buffer(name: string, options: BufferOptionsInternal): Bin {
    const length = options.readUntil === "eof" ? Infinity : options.length;
    if (length === undefined) {
      throw new Error(`\`${name}\` needs a length or readUntil: "eof"`);
    }
    const clone = options.clone
      ? (value: unknown) => Buffer.from(value as Buffer)
      : undefined;
    return this.#add({
      kind: "buffer",
      ...named(name, options, clone),
      length: checkLength(name, length),
    });
  }

  array<K extends string, E extends TypeOption, R>(
    name: K,
    options: ArrayOptions<T, E> & { key?: undefined } & FormattedOptions<
        T,
        ValueOf<E>[],
        R
      >,
  ): Bin<With<T, K, R>>;
  /** With `key`, an array is stored as an object, keyed by that field of its items. */
  array<K extends string, E extends TypeOption, R>(
    name: K,
    options: ArrayOptions<T, E> &
      Keyed<E> &
      FormattedOptions<T, Record<string, ValueOf<E>>, R>,
  ): Bin<With<T, K, R>>;
  array<K extends string, E extends TypeOption>(
    name: K,
    options: ArrayOptions<T, E> &
      Keyed<E> &
      PlainOptions<T, Record<string, ValueOf<E>>>,
  ): Bin<With<T, K, Record<string, ValueOf<E>>>>;
  array<K extends string, E extends TypeOption>(
    name: K,
    options: ArrayOptions<T, E> & { key?: undefined } & PlainOptions<
        T,
        ValueOf<E>[]
      >,
  ): Bin<With<T, K, ValueOf<E>[]>>;
  array(name: string, options: ArrayOptionsInternal): Bin {
    const { key, length = Infinity } = options;
    // `length: Infinity` reads up to the end of the input, like `readUntil: "eof"`.
    const until =
      options.readUntil ?? (length === Infinity ? "eof" : undefined);
    if (options.length === undefined && options.readUntil === undefined) {
      throw new Error(`\`${name}\` needs a length or readUntil`);
    }
    if (typeof until === "function" && until.length > 1) {
      throw new Error("read-ahead is not supported in readUntil functions");
    }
    const field =
      key === undefined
        ? named(name, options)
        : named(
            name,
            options,
            (items) => keyBy(items as Obj[], key, name),
            (map) => unkey(map as Record<string, Obj>, key, name),
          );
    return this.#add({
      kind: "array",
      ...field,
      type: Bin.#resolve(options.type),
      length: until === "eof" ? Infinity : checkLength(name, length),
      until,
    });
  }

  /** With `flatten`, the fields of the (formatted) value are added to this parser's objects. */
  nest<E extends TypeOption, R extends object>(
    name: string,
    options: { type: E } & Flatten & FormattedOptions<T, ValueOf<E>, R>,
  ): Bin<T & R>;
  nest<E extends Bin<object>>(
    name: string,
    options: { type: E } & Flatten & PlainOptions<T, ValueOf<E>>,
  ): Bin<T & ValueOf<E>>;
  nest<K extends string, E extends TypeOption, R>(
    name: K,
    options: { type: E } & NoFlatten & FormattedOptions<T, ValueOf<E>, R>,
  ): Bin<With<T, K, R>>;
  nest<K extends string, E extends TypeOption>(
    name: K,
    options: { type: E } & NoFlatten & PlainOptions<T, ValueOf<E>>,
  ): Bin<With<T, K, ValueOf<E>>>;
  nest(name: string, options: NestOptionsInternal): Bin {
    return this.#add({
      kind: "nest",
      ...named(name, options),
      type: Bin.#resolve(options.type, flattened(name, options)),
    });
  }

  /** Like `nest`, but the nested value occupies exactly `length` bytes (padded after it). */
  fixedSizeNest<E extends TypeOption, R extends object>(
    name: string,
    options: FixedSize<T, E> & Flatten & FormattedOptions<T, ValueOf<E>, R>,
  ): Bin<T & R>;
  fixedSizeNest<E extends Bin<object>>(
    name: string,
    options: FixedSize<T, E> & Flatten & PlainOptions<T, ValueOf<E>>,
  ): Bin<T & ValueOf<E>>;
  fixedSizeNest<K extends string, E extends TypeOption, R>(
    name: K,
    options: FixedSize<T, E> & NoFlatten & FormattedOptions<T, ValueOf<E>, R>,
  ): Bin<With<T, K, R>>;
  fixedSizeNest<K extends string, E extends TypeOption>(
    name: K,
    options: FixedSize<T, E> & NoFlatten & PlainOptions<T, ValueOf<E>>,
  ): Bin<With<T, K, ValueOf<E>>>;
  fixedSizeNest(name: string, options: NestOptionsInternal): Bin {
    const { length } = options;
    if (length === undefined || length === Infinity) {
      throw new Error(`\`${name}\` needs a finite length`);
    }
    return this.#add({
      kind: "nest",
      ...named(name, options),
      type: Bin.#resolve(options.type, flattened(name, options)),
      length: checkLength(name, length),
    });
  }

  /** Parses one of several types, chosen by a tag. */
  choice<C extends Choices, R extends object, D extends TypeOption = never>(
    name: string,
    options: ChoiceOptions<T, C, D> &
      Flatten &
      FormattedOptions<T, ValueOf<C[keyof C] | D>, R>,
  ): Bin<T & R>;
  choice<
    C extends Record<string | number, Bin<object>>,
    D extends Bin<object> = never,
  >(
    name: string,
    options: ChoiceOptions<T, C, D> &
      Flatten &
      PlainOptions<T, ValueOf<C[keyof C] | D>>,
  ): Bin<T & ValueOf<C[keyof C] | D>>;
  choice<K extends string, C extends Choices, R, D extends TypeOption = never>(
    name: K,
    options: ChoiceOptions<T, C, D> &
      NoFlatten &
      FormattedOptions<T, ValueOf<C[keyof C] | D>, R>,
  ): Bin<With<T, K, R>>;
  choice<K extends string, C extends Choices, D extends TypeOption = never>(
    name: K,
    options: ChoiceOptions<T, C, D> &
      NoFlatten &
      PlainOptions<T, ValueOf<C[keyof C] | D>>,
  ): Bin<With<T, K, ValueOf<C[keyof C] | D>>>;
  choice(name: string, options: ChoiceOptionsInternal): Bin {
    const choices = Object.create(null) as Record<string, Type>;
    for (const [key, type] of Object.entries(options.choices)) {
      choices[key] = Bin.#resolve(type, flattened(name, options));
    }
    const { defaultChoice } = options;
    return this.#add({
      kind: "choice",
      ...named(name, options),
      tag: options.tag,
      choices,
      defaultChoice:
        defaultChoice === undefined
          ? undefined
          : Bin.#resolve(defaultChoice, flattened(name, options)),
    });
  }

  /** Parses a value from the start of `buffer` (later bytes are ignored). */
  parse(buffer: Buffer): T {
    return this.parseFrom(buffer).result;
  }

  /**
   * Parses a value at `offset`, and returns it with the offset after it, so
   * that consecutive values can be read from one buffer.
   *
   * With `options.fields`, only these top-level fields are decoded; the
   * others are stepped over (and fields that lengths or tags refer to are
   * decoded too). `fields: []` skips the value.
   */
  parseFrom<K extends keyof T & string>(
    buffer: Buffer,
    offset: number,
    options: { fields: readonly K[] },
  ): ParseResult<Pick<T, K>>;
  parseFrom(buffer: Buffer, offset?: number): ParseResult<T>;
  parseFrom(
    buffer: Buffer,
    offset = 0,
    options?: { fields: readonly string[] },
  ): ParseResult<unknown> {
    if (!Number.isInteger(offset) || offset < 0 || offset > buffer.length) {
      throw new RangeError(`offset ${offset} is outside the buffer`);
    }
    const fields = options?.fields;
    const cached = fields && this.#parsersByFields.get(fields);
    let parse =
      fields === undefined
        ? this.#parsers.get(undefined)
        : cached && sameNames(cached.names, fields)
          ? cached.parse
          : undefined;
    if (!parse) {
      const key = fields && JSON.stringify(fields);
      parse = this.#parsers.get(key);
      if (!parse) {
        const selection = fields ? new Set(fields) : "all";
        this.#parsers.set(key, (parse = parser(this.#type(), selection)));
      }
      if (fields)
        this.#parsersByFields.set(fields, { names: [...fields], parse });
    }
    const parsed = parse(buffer, offset);
    if (parsed) return parsed;
    throw endOfInput(
      ` (value at offset ${offset}, buffer of ${buffer.length} bytes)`,
    );
  }

  /** Serializes `obj`, into `buffer` if given; returns the bytes written. */
  serialize(obj: T, buffer?: Buffer): Buffer {
    return serialize(this.#type(), obj, buffer);
  }

  /** Byte size of `obj` when serialized; without `obj`, the size of every value (`NaN` if it varies). */
  sizeOf(obj?: T): number {
    const type = this.#type();
    return obj === undefined ? fixedSize(type) : sizeOf(type, obj);
  }

  /** Returns a transform stream that parses its input into a sequence of values. */
  stream(): Transform {
    return stream(this.#type());
  }

  /** The type as currently defined (pending bit fields are added first). */
  #type(): Type {
    if (this.#lazy) return this.#lazy;
    // Pending bit fields are included, but their run may still grow.
    const fields = this.#bits.length
      ? [...this.#fields, this.#bitRun()]
      : [...this.#fields];
    return (this.#struct ??= { fields, create: this.#create });
  }

  /** Resolves a type option; for a field `flattened` without a formatter, it must be a parser. */
  static #resolve(type: TypeOption, flatField?: string): Type {
    if (type instanceof Bin) {
      const resolved = type.#type();
      if (flatField === undefined) return resolved;
      const plain = (struct: Struct) => {
        if (!struct.create) return struct;
        throw new Error(
          `\`${flatField}\`: objects of a class cannot be flattened (only with a formatter)`,
        );
      };
      // A lazy parser is checked when its factory runs (on first use).
      return typeof resolved === "function"
        ? () => plain(resolved())
        : plain(resolved as Struct);
    }
    if (flatField !== undefined) {
      throw new Error(`\`${flatField}\`: only parsers can be flattened`);
    }
    if (Object.hasOwn(PRIMITIVE_TYPES, type)) return type;
    throw new Error(`invalid type \`${String(type)}\``);
  }

  /** Registers a new field. */
  #claim(name: string): void {
    this.#checkNotLazy();
    if (name === "__proto__") throw new Error("invalid field name `__proto__`");
    if (this.#names.has(name)) throw new Error(`duplicate field \`${name}\``);
    this.#names.add(name);
    this.#changed();
  }

  #checkNotLazy(): void {
    if (this.#lazy) {
      throw new Error(
        "a lazy parser cannot be changed; change the parser its factory returns",
      );
    }
  }

  #changed(): void {
    this.#struct = undefined;
    this.#parsers.clear();
    this.#parsersByFields = new WeakMap();
  }

  #push(field: Field): this {
    if (field.kind !== "bits") this.#claim(field.name);
    this.#fields.push(field);
    this.#struct = undefined;
    return this;
  }

  #add(field: Field): this {
    this.#flushBits();
    return this.#push(field);
  }

  /** Ends the run of pending bit fields. */
  #flushBits(): void {
    if (!this.#bits.length) return;
    const run = this.#bitRun();
    this.#bits = [];
    this.#push(run);
  }

  /** The pending bit fields as a run; with little endian, the first field takes the last bits. */
  #bitRun(): Field {
    const total = this.#bits.reduce((sum, bit) => sum + bit.width, 0);
    let before = 0;
    const bits = this.#bits.map((bit): Bit => {
      const pos = this.#endian === "le" ? total - before - bit.width : before;
      before += bit.width;
      return { ...bit, pos };
    });
    return { kind: "bits", bits, bytes: Math.ceil(total / 8) };
  }
}

/** Turns an array into an object, keyed by a field of its items. */
function keyBy(items: Obj[], key: string, name: string): Obj {
  const keys = new Set<string>();
  for (const item of items) {
    const k = String(item[key]);
    if (keys.has(k)) {
      throw new Error(`\`${name}\`: two items have ${key} \`${k}\``);
    }
    keys.add(k);
  }
  // Own properties even for keys such as `__proto__`.
  return Object.fromEntries(items.map((item) => [item[key], item]));
}

/** Inverse of `keyBy`. */
function unkey(map: Record<string, Obj>, key: string, name: string): Obj[] {
  return Object.entries(map).map(([k, item]) => {
    if (String(item[key]) !== k) {
      throw new Error(`\`${name}\`: item \`${k}\` has ${key} \`${item[key]}\``);
    }
    return item;
  });
}

/** Checks a length given as a number: a non-negative integer, or `Infinity`. */
function checkLength<L extends LengthSpec>(name: string, length: L): L {
  if (
    typeof length === "number" &&
    length !== Infinity &&
    !(Number.isInteger(length) && length >= 0)
  ) {
    invalidLength(length, name);
  }
  return length;
}

type Parse = ReturnType<typeof parser>;

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The name of a field whose value is flattened as parsed (so its type must be a parser). */
function flattened(name: string, options: ValueOptions): string | undefined {
  return options.flatten && !options.formatter ? name : undefined;
}

type StringOptionsInternal = ValueOptions & {
  encoding?: BufferEncoding;
  length?: LengthSpec;
  zeroTerminated?: boolean;
  stripNull?: boolean;
};
type BufferOptionsInternal = ValueOptions & {
  length?: LengthSpec;
  readUntil?: "eof";
  clone?: boolean;
};
type ArrayOptionsInternal = ValueOptions & {
  type: TypeOption;
  length?: LengthSpec;
  readUntil?: "eof" | Callback<boolean>;
  key?: string;
};
type NestOptionsInternal = ValueOptions & {
  type: TypeOption;
  length?: LengthSpec;
};
type ChoiceOptionsInternal = ValueOptions & {
  tag: Tag;
  choices: Choices;
  defaultChoice?: TypeOption;
};

/** `Parser` is the name binary-parser uses. */
export { Bin as Parser };
