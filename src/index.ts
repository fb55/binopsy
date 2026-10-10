import type { Transform } from "node:stream";
import {
  Parser,
  type ArrayParseOptions,
  type BufferParseOptions,
  type LengthOption,
  type ParseResult,
  type StringParseOptions,
} from "./parser.ts";
import {
  PRIMITIVE_NAMES,
  type PrimitiveName,
  type PrimitiveValue,
} from "./primitive-types.ts";
import { Serializer } from "./serializer.ts";
import { getType } from "./type-functions.ts";
import type { BitRequest, ConstructorFn, Obj, ResolvedType } from "./types.ts";

export type { PrimitiveName, PrimitiveValue } from "./primitive-types.ts";
export type { LengthOption, ParseResult } from "./parser.ts";

/** Anything usable as a nested type: a parser or the name of a primitive. */
export type TypeOption = Bin<object> | PrimitiveName;

/** The value a `TypeOption` parses into. */
export type ValueOf<X> =
  X extends Bin<infer U>
    ? U
    : X extends PrimitiveName
      ? PrimitiveValue<X>
      : never;

/** Adds a field `K` of type `V` to the object type `T`. */
export type With<T, K extends string, V> = T & { [P in K]: V };

/** Length of a string, buffer, array or fixed-size nest. */
export type Length<T> = number | (keyof T & string) | ((this: T) => number);

/** Options shared by all fields producing a value of type `V` (stored as `R`). */
export interface ValueOptions<T, V, R> {
  /** Maps the parsed value to the stored one. Requires `deformatter` for serialization. */
  formatter?: (this: T, value: V) => R;
  /** Inverse of `formatter`, used when serializing. */
  deformatter?: (value: NoInfer<R>, obj: T) => V;
  /** Fails parsing unless the value equals this constant or passes this check. */
  assert?: V extends string | number
    ? V | ((this: T, value: V) => boolean)
    : (this: T, value: V) => boolean;
}

/** `ValueOptions` with a formatter, which changes the stored type. */
export type FormattedOptions<T, V, R> = ValueOptions<T, V, R> & {
  formatter: (this: T, value: V) => R;
  deformatter: (value: NoInfer<R>, obj: T) => V;
};

export interface StringOptions<T, R = string> extends ValueOptions<
  T,
  string,
  R
> {
  encoding?: BufferEncoding;
  length?: Length<T>;
  zeroTerminated?: boolean;
  stripNull?: boolean;
}

export interface BufferOptions<T, R = Buffer> extends ValueOptions<
  T,
  Buffer,
  R
> {
  length?: Length<T>;
  readUntil?: "eof";
  /** Copy the bytes instead of referencing the input buffer. */
  clone?: boolean;
}

export interface ArrayOptions<T, E extends TypeOption, R> extends ValueOptions<
  T,
  ValueOf<E>[],
  R
> {
  type: E;
  length?: Length<T>;
  readUntil?: "eof" | ((item: ValueOf<E>) => boolean);
  /** Turn the array into an object, keyed by this field of each item. */
  key?: string;
}

export interface NestOptions<T, E extends TypeOption, R> extends ValueOptions<
  T,
  ValueOf<E>,
  R
> {
  type: E;
  /** Copy the nested fields into the current object instead of a sub-object. */
  flatten?: boolean;
}

export interface FixedSizeNestOptions<
  T,
  E extends TypeOption,
  R,
> extends NestOptions<T, E, R> {
  length: Length<T>;
}

export interface ChoiceOptions<
  T,
  C extends Record<string | number, TypeOption>,
  R,
> extends ValueOptions<T, ValueOf<C[keyof C]>, R> {
  /** Field holding the tag, or a function computing it. */
  tag: (keyof T & string) | ((this: T, obj: T) => string | number);
  choices: C;
  defaultChoice?: TypeOption;
  /** Copy the chosen type's fields into the current object. */
  flatten?: boolean;
}

/** Widths available as `bitN` methods. */
type BitWidth =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26
  | 27
  | 28
  | 29
  | 30
  | 31
  | 32;

type BitMethods<T extends object> = {
  [N in BitWidth as `bit${N}`]: {
    <K extends string, R>(
      varName: K,
      options: FormattedOptions<T, number, R>,
    ): Bin<With<T, K, R>>;
    <K extends string>(
      varName: K,
      options?: ValueOptions<T, number, number>,
    ): Bin<With<T, K, number>>;
  };
};

type PrimitiveMethod<T extends object, V> = {
  <K extends string, R>(
    varName: K,
    options: FormattedOptions<T, V, R>,
  ): Bin<With<T, K, R>>;
  <K extends string>(
    varName: K,
    options?: ValueOptions<T, V, V>,
  ): Bin<With<T, K, V>>;
};

type PrimitiveMethods<T extends object> = {
  [N in PrimitiveName]: PrimitiveMethod<T, PrimitiveValue<N>>;
} & {
  /** 16-bit unsigned integer in the parser's endianness. */
  uint16: PrimitiveMethod<T, number>;
  uint32: PrimitiveMethod<T, number>;
  uint64: PrimitiveMethod<T, bigint>;
  int16: PrimitiveMethod<T, number>;
  int32: PrimitiveMethod<T, number>;
  int64: PrimitiveMethod<T, bigint>;
  float: PrimitiveMethod<T, number>;
  double: PrimitiveMethod<T, number>;
};

// The bit and primitive methods are installed on the prototype below.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface Bin<T extends object = object>
  extends BitMethods<T>, PrimitiveMethods<T> {}

/**
 * A binary parser and serializer. `T` is the type of the parsed objects; it
 * grows with every field added.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class Bin<T extends object = object> {
  parser = new Parser();
  serializer = new Serializer();
  endian: "le" | "be" = "be";
  bitRequests: BitRequest[] = [];

  /** Creates an empty parser. */
  static start(): Bin {
    return new Bin();
  }

  /** Alias, so that `Bin.Parser` works as a drop-in replacement for binary-parser. */
  static Parser = Bin;

  /**
   * A parser that is defined by `factory` on first use. This allows
   * recursive formats, where a type contains itself:
   *
   * ```ts
   * const Tree: Bin<TreeNode> = Bin.start()
   *   .uint8("count")
   *   .array("children", { type: Bin.lazy(() => Tree), length: "count" });
   * ```
   *
   * Values are created as plain objects (`create()` on the target is ignored).
   */
  static lazy<U extends object>(factory: () => Bin<U>): Bin<U> {
    const lazy = new Bin<U>();
    let target: Bin<U> | undefined;
    const resolve = () => {
      if (!target) {
        target = factory();
        target._flushBitfield();
      }
      return target;
    };
    lazy.parser.readFunc = (read, obj, cb) => resolve().readFunc(read, obj, cb);
    lazy.parser.fixedSize = NaN;
    lazy.serializer.writeFunc = (obj, buf) => resolve().writeFunc(obj, buf);
    lazy.serializer.sizeFunc = (obj) => resolve().sizeFunc(obj);
    return lazy;
  }

  /** Serializes `obj`, into `buf` if given. */
  serialize(obj: T, buf?: Buffer): Buffer {
    this._flushBitfield();
    return this.serializer.serialize(obj as Obj, buf);
  }

  /** Byte size of `obj` when serialized; without `obj`, the fixed size of the type (`NaN` if variable). */
  sizeOf(obj?: T): number {
    if (obj == null) return this.parser.fixedSize;
    return this.serializer.sizeFunc(obj as Obj);
  }

  choice<K extends string, C extends Record<string | number, TypeOption>, R>(
    varName: K,
    options: ChoiceOptions<T, C, R> &
      FormattedOptions<T, ValueOf<C[keyof C]>, R>,
  ): Bin<With<T, K, R>>;
  choice<K extends string, C extends Record<string | number, TypeOption>>(
    varName: K,
    options: ChoiceOptions<T, C, ValueOf<C[keyof C]>> & { flatten: true },
  ): Bin<T & ValueOf<C[keyof C]>>;
  choice<K extends string, C extends Record<string | number, TypeOption>>(
    varName: K,
    options: ChoiceOptions<T, C, ValueOf<C[keyof C]>>,
  ): Bin<With<T, K, ValueOf<C[keyof C]>>>;
  choice(varName: string, options: Obj): Bin<object> {
    this._flushBitfield();

    const choices = options.choices as Record<string, TypeOption>;
    const mappedChoices: Record<string, ResolvedType> = {};

    for (const key in choices) {
      mappedChoices[key] = getType(choices[key]);
    }

    const defaultChoice =
      options.defaultChoice && getType(options.defaultChoice);

    const tag = options.tag as string | ((obj: Obj) => string | number);
    const getTag: (obj: Obj) => string | number =
      typeof tag === "function"
        ? (tag as unknown as (obj: Obj) => string | number)
        : (obj) => {
            if (!(tag in obj)) {
              throw new Error(`tag \`${tag}\` not found in object`);
            }
            return obj[tag] as string | number;
          };

    const getChoice = defaultChoice
      ? (obj: Obj) => {
          const key = getTag.call(obj, obj);
          return key in mappedChoices ? mappedChoices[key] : defaultChoice;
        }
      : (obj: Obj) => {
          const choice = mappedChoices[getTag.call(obj, obj)];
          if (!choice) throw new Error("invalid choice");
          return choice;
        };

    const opts = options as unknown as ChoiceOptionsInternal;
    this.parser.choice(varName, opts, getChoice);
    this.serializer.choice(varName, opts, getChoice);
    return this;
  }

  /** Use `constructorFn` to create parsed objects; fields are then set on its instances. */
  create<U extends object>(constructorFn: new () => U): Bin<T & U> {
    this.parser.create(constructorFn as unknown as ConstructorFn);
    return this as unknown as Bin<T & U>;
  }

  compile(): void {
    /* Do nothing */
  }

  getCode(): never {
    throw new Error("not implemented");
  }

  /** Parses `buffer` from the start. */
  parse(buffer: Buffer): T {
    this._flushBitfield();
    return (this.parser.parse(buffer) ?? {}) as T;
  }

  /**
   * Parses one value starting at `offset` and returns it together with the
   * offset of the first byte after it, so that consecutive values can be read
   * from one buffer without copying.
   */
  parseFrom(buffer: Buffer, offset = 0): ParseResult<T> {
    this._flushBitfield();
    const { result, offset: end } = this.parser.parseFrom(buffer, offset);
    if (end > buffer.length) {
      throw new RangeError(
        `out of bounds: needed ${end - buffer.length} more bytes at offset ${offset}`,
      );
    }
    return { result: (result ?? {}) as T, offset: end };
  }

  /** Returns a transform stream that parses its input into a sequence of values. */
  stream(): Transform {
    this._flushBitfield();
    return this.parser.stream();
  }

  nest<K extends string, E extends TypeOption, R>(
    varName: K,
    options: NestOptions<T, E, R> & FormattedOptions<T, ValueOf<E>, R>,
  ): Bin<With<T, K, R>>;
  nest<K extends string, E extends TypeOption>(
    varName: K,
    options: NestOptions<T, E, ValueOf<E>> & { flatten: true },
  ): Bin<T & ValueOf<E>>;
  nest<K extends string, E extends TypeOption>(
    varName: K,
    options: NestOptions<T, E, ValueOf<E>>,
  ): Bin<With<T, K, ValueOf<E>>>;
  nest(varName: string, options: Obj): Bin<object> {
    const type = getType(options.type, true);
    const opts = { ...(options as object), type } as NestOptionsInternal;

    if (type.bitRequests.length) {
      this.bitRequests = this.bitRequests.concat(
        type.bitRequests.map((req) => ({
          i: req.i,
          vars: [varName, ...req.vars],
          options: req.options,
          // TODO support constructors
        })),
      );
    }

    this.parser.nest(varName, opts);
    this.serializer.nest(varName, opts);
    return this;
  }

  /** Like `nest`, but the nested value always occupies exactly `length` bytes. */
  fixedSizeNest<K extends string, E extends TypeOption, R>(
    varName: K,
    options: FixedSizeNestOptions<T, E, R> & FormattedOptions<T, ValueOf<E>, R>,
  ): Bin<With<T, K, R>>;
  fixedSizeNest<K extends string, E extends TypeOption>(
    varName: K,
    options: FixedSizeNestOptions<T, E, ValueOf<E>>,
  ): Bin<With<T, K, ValueOf<E>>>;
  fixedSizeNest(varName: string, options: Obj): Bin<object> {
    this._flushBitfield();
    const type = getType(options.type);
    const opts = options as unknown as NestOptionsInternal & {
      length: LengthOption;
    };
    this.parser.fixedSizeNest(varName, opts, type);
    this.serializer.fixedSizeNest(varName, opts, type);
    return this;
  }

  string<K extends string, R>(
    varName: K,
    options: StringOptions<T, R> & FormattedOptions<T, string, R>,
  ): Bin<With<T, K, R>>;
  string<K extends string>(
    varName: K,
    options: StringOptions<T>,
  ): Bin<With<T, K, string>>;
  string(varName: string, options: Obj): Bin<object> {
    this._flushBitfield();
    const opts = options as unknown as StringParseOptions;
    this.parser.string(varName, opts);
    this.serializer.string(varName, opts);
    return this;
  }

  buffer<K extends string, R>(
    varName: K,
    options: BufferOptions<T, R> & FormattedOptions<T, Buffer, R>,
  ): Bin<With<T, K, R>>;
  buffer<K extends string>(
    varName: K,
    options: BufferOptions<T>,
  ): Bin<With<T, K, Buffer>>;
  buffer(varName: string, options: Obj): Bin<object> {
    this._flushBitfield();
    const opts = options as unknown as BufferParseOptions;
    this.parser.buffer(varName, opts);
    this.serializer.buffer(varName, opts);
    return this;
  }

  array<K extends string, E extends TypeOption, R>(
    varName: K,
    options: ArrayOptions<T, E, R> & FormattedOptions<T, ValueOf<E>[], R>,
  ): Bin<With<T, K, R>>;
  array<K extends string, E extends TypeOption>(
    varName: K,
    options: ArrayOptions<T, E, ValueOf<E>[]> & { key: string },
  ): Bin<With<T, K, Record<string, ValueOf<E>>>>;
  array<K extends string, E extends TypeOption>(
    varName: K,
    options: ArrayOptions<T, E, ValueOf<E>[]>,
  ): Bin<With<T, K, ValueOf<E>[]>>;
  array(varName: string, options: Obj): Bin<object> {
    this._flushBitfield();
    const type = getType(options.type);
    const opts = options as unknown as ArrayParseOptions;
    this.parser.array(varName, opts, type);
    this.serializer.array(varName, opts, type);
    return this;
  }

  /** Sets the byte order used by unsuffixed methods (`uint16`, …) and bit fields. */
  endianess(endianess: "little" | "big"): this {
    switch (endianess.toLowerCase()) {
      case "little":
        this.endian = "le";
        break;
      case "big":
        this.endian = "be";
        break;
      default:
        throw new Error(`Invalid endianess: ${endianess}`);
    }

    return this;
  }

  _flushBitfield(): void {
    let reqs = this.bitRequests;

    if (!reqs.length) return;
    if (this.endian === "le") reqs = reqs.reverse();

    const length = reqs.reduce((sum, req) => sum + req.i, 0);

    this.serializer._processBitfield(reqs, length);
    this.parser.processBitfield(reqs, length);

    this.bitRequests = [];
  }

  // Alias properties, so that parsers can be nested
  get writeFunc(): (obj: unknown, buf: Buffer) => number {
    return this.serializer.writeFunc as (obj: unknown, buf: Buffer) => number;
  }

  get sizeFunc(): (obj: unknown) => number {
    return this.serializer.sizeFunc as (obj: unknown) => number;
  }

  get readFunc(): ResolvedType["readFunc"] {
    return this.parser.readFunc;
  }

  get constructorFn(): ConstructorFn {
    return this.parser.constructorFn;
  }

  get fixedSize(): number {
    return this.parser.fixedSize;
  }
}

type ChoiceOptionsInternal = Parameters<Parser["choice"]>[1];
type NestOptionsInternal = Parameters<Parser["nest"]>[1];

type Methods = Record<
  string,
  (this: Bin, varName: string, options?: Obj) => Bin
>;

for (const name of PRIMITIVE_NAMES) {
  (Bin.prototype as unknown as Methods)[name] = function (
    this: Bin,
    varName,
    options,
  ) {
    this._flushBitfield();
    this.parser.primitive(name, varName, options);
    this.serializer.primitive(name, varName, options);
    return this;
  };
}

for (const alias of [
  "uint16",
  "uint32",
  "uint64",
  "int16",
  "int32",
  "int64",
  "float",
  "double",
]) {
  (Bin.prototype as unknown as Methods)[alias] = function (
    this: Bin,
    varName,
    options,
  ) {
    return (this as unknown as Methods)[alias + this.endian].call(
      this,
      varName,
      options,
    );
  };
}

for (let i = 1; i <= 32; i++) {
  (Bin.prototype as unknown as Methods)[`bit${i}`] = function (
    this: Bin,
    varName,
    options,
  ) {
    // TODO support constructors
    this.bitRequests.push({ i, vars: [varName], options });
    return this;
  };
}

/** `Parser` is the name used by binary-parser. */
export { Bin as Parser };
export default Bin;
