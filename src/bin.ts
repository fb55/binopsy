/**
 * Parsers, defined field by field: `bin().u8("count").field("items", array(Item, "count"))`.
 * Each method returns a new parser, and every parser is a codec of objects.
 */
import {
  Codec,
  writeValue,
  type AnyCase,
  type AnyCodec,
  type Defaulted,
  type defaulted,
  type Input,
  type Obj,
  type Output,
  type types,
} from "./codec.ts";
import { ALL_FIELDS, type Gen, type Reads, type Selection } from "./compile.ts";
import type {
  Value,
  matchTypes,
  IsUnion,
  CaseCodec,
  CaseValues as CaseValue,
  ScalarValue,
  Subtract,
  Intersect,
} from "./match.ts";
import { primitives, type Numbers } from "./primitives.ts";

/*
 * Types: the fields of a parser are a union of objects (`T` decoded, `I`
 * encoded), built as intersections (which stay flat in long parsers) and
 * shown as object types. A parser without fields has `{}`.
 */
/* oxlint-disable typescript/no-empty-object-type */

/** Flattens each variant; `& {}` makes hovers expand the object instead of naming this alias. */
type Pretty<T> = { [K in keyof T]: T[K] } & {};
/** The field names of any variant of `T`. */
type Keys<T> = T extends unknown ? keyof T & string : never;
/** `T` with field `K` of type `V`; intersections distribute over variants of `T`. */
type Add<T, K extends string, V> = K extends unknown
  ? T & { [P in K]: V }
  : never;
/** `I` with field `K` of type `V`, which may be omitted if the codec supplies it (`D`). */
type AddInput<I, K extends string, V, D = false> = I &
  ([D] extends [true] ? { [P in K]?: V } : { [P in K]: V });
/** The values functions see when encoding: omitted fields (which have optional keys) are supplied. */
type Resolved<I> = {
  [K in keyof I]-?: {} extends Pick<I, K> ? Exclude<I[K], undefined> : I[K];
};
/** The fields functions see: decoded, or (if they differ) encoded. */
type Available<T, I> = [Resolved<I>] extends [T] ? T : T | Resolved<I>;
type InScope<Fields, Outer> = Fields extends unknown
  ? Outer extends unknown
    ? Pretty<Omit<Outer, keyof Fields> & Fields>
    : never
  : never;
/** The fields a codec added to a parser sees: the parser's, and those around it (`Ctx`). */
type Seen<T, I, Ctx> = unknown extends Ctx
  ? Pretty<Available<T, I>>
  : InScope<Available<T, I>, Ctx>;

/** The tag and cases of a match (`never` for other codecs). */
type MatchOf<X> = [X] extends [never]
  ? never
  : [X] extends [
        {
          tag: infer Tag extends string;
          cases: infer Cs;
          otherwise: infer D;
          context: infer C;
        },
      ]
    ? { tag: Tag; cases: Cs; otherwise: D; context: C }
    : never;
/** The type of field `Tag` in any variant of `T`. */
type TagOf<T, Tag extends string> = T extends unknown
  ? T[Tag & keyof T]
  : never;
/** Fields a match reads that are not in every variant of `F`. */
type Missing<M, F> = M extends { context: infer C }
  ? Exclude<keyof C, keyof F> & string
  : never;
/** Fields a match reads that have other types in a variant of `F`. */
type Mistyped<M, F> = M extends { context: infer C }
  ? F extends unknown
    ? {
        [K in keyof C & keyof F]: [F[K]] extends [C[K]] ? never : K;
      }[keyof C & keyof F] &
        string
    : never
  : never;
/** Case values that are not values of the tag. */
type Wrong<M, F> = M extends { tag: infer Tag extends string; cases: infer Cs }
  ? [Tag] extends [never]
    ? never
    : Exclude<ScalarValue<CaseValue<Cs>>, ScalarValue<TagOf<F, Tag>>>
  : never;
/** Why match `M` doesn't fit the fields `F` (else `never`). */
type Problem<M, F> = [Missing<M, F>] extends [never]
  ? [Mistyped<M, F>] extends [never]
    ? [Wrong<M, F>] extends [never]
      ? never
      : M extends { tag: infer Tag extends string }
        ? `case ${Wrong<M, F> & Value} is not a value of \`${Tag}\``
        : never
    : `\`${Mistyped<M, F>}\` has another type`
  : `\`${Missing<M, F>}\` is not a field before this`;
/** The parameter `P`, or why the match in `X` doesn't fit the fields `F`. */
type Checked<X, F, P> = [MatchOf<X>] extends [never]
  ? P
  : Problem<MatchOf<X>, F> extends infer E
    ? [E] extends [never]
      ? P
      : E
    : never;

/** Variant `T` with its tag `K` narrowed to `V` (`never` if it can't be `V`; tags from outside stay out). */
type Narrow<T, K extends string, V> = K extends keyof T
  ? [Intersect<T[K], V>] extends [never]
    ? never
    : {
        [P in keyof T]: P extends K
          ? Intersect<T[P], V> | (undefined extends T[P] ? undefined : never)
          : T[P];
      }
  : T;
/** The type of tag `K` for variant `T`, which may come from outside (`Outer`). */
type TagIn<T, Outer, K extends string> = K extends keyof T
  ? T[K]
  : K extends keyof Outer
    ? Outer[K]
    : never;
/** What a case adds: field `K`, or (if `K` is null) the case parser's fields. */
type Part<C, K extends string | null, S extends "out" | "in"> = S extends "out"
  ? K extends string
    ? { [P in K]: Output<C> }
    : Output<C>
  : [K] extends [string]
    ? AddInput<{}, K & string, Input<C>, [C] extends [Defaulted] ? true : false>
    : Input<C>;
type Branch<
  T,
  Tag extends string,
  V,
  C,
  K extends string | null,
  S extends "out" | "in",
> = [V] extends [never]
  ? never
  : [Narrow<T, Tag, V>] extends [never]
    ? never
    : Pretty<Narrow<T, Tag, V> & Part<C, K, S>>;
/** The variants of `T` after match `M` (field `K`, or flattened if `K` is null). */
type Apply<
  T,
  M,
  K extends string | null,
  S extends "out" | "in",
  Outer,
> = M extends {
  tag: infer Tag extends string;
  cases: infer Cs;
  otherwise: infer D;
}
  ? T extends unknown
    ? [Tag] extends [never]
      ? Pretty<T & Part<CaseCodec<Cs> | D, K, S>>
      :
          | (Cs extends readonly [infer V, infer C]
              ? Branch<T, Tag, V, C, K, S>
              : never)
          | ([D] extends [never]
              ? never
              : Branch<
                  T,
                  Tag,
                  Subtract<TagIn<T, Outer, Tag>, CaseValue<Cs>>,
                  D,
                  K,
                  S
                >)
    : never
  : never;

/** Methods adding a number field: `.u16le("length")` is `.field("length", u16le)`. */
type NumberFields<T, I, Ctx> = {
  [N in keyof Numbers]: <const K extends string>(
    name: K,
  ) => Bin<
    Add<T, K, Output<Numbers[N]>>,
    AddInput<I, K, Input<Numbers[N]>>,
    Ctx
  >;
};
/** Names surely picked (not unions of names). */
type Certain<Names extends readonly string[]> = number extends Names["length"]
  ? never
  : {
      [P in keyof Names]: true extends IsUnion<Names[P]> ? never : Names[P];
    }[number];
type Picked<T, Names extends readonly string[]> = T extends unknown
  ? Pretty<
      Pick<T, Certain<Names> & keyof T> &
        Partial<Pick<T, Exclude<Names[number], Certain<Names>> & keyof T>>
    >
  : never;
type Without<I, K extends PropertyKey> = I extends unknown
  ? Pretty<Omit<I, K>>
  : never;
type ValueOf<I, K> = I extends unknown
  ? K extends keyof I
    ? Exclude<I[K], undefined>
    : never
  : never;
type Computed<I, K, V> = I extends unknown
  ? K extends keyof I
    ? [Exclude<I[K], undefined> & V] extends [never]
      ? never
      : Pretty<Omit<I, K> & { [P in K & keyof I]?: I[P] & V }>
    : I
  : never;
type BatchComputed<I, K> = I extends unknown
  ? Pretty<Omit<I, K & PropertyKey> & { [P in K & keyof I]?: I[P] }>
  : never;

/** Types only: marks parsers (which can be merged). */
export declare const structured: unique symbol;

/**
 * A parser that takes no more fields, as it computes some or decodes only
 * some (`computed` and `pick` return one): `T` is the union of the objects it
 * decodes, `I` that of those it encodes, and `Ctx` holds fields it reads from
 * the parser it is added to.
 */
export interface Struct<T, I = T, Ctx = unknown> extends Codec<T, I, Ctx> {
  // Normalize only when a member is used. A normalized base type would
  // resolve every accumulated field at every step of a builder chain.
  readonly [types]: Codec<Pretty<T>, Pretty<I>, Ctx>[typeof types];
  decode: Codec<Pretty<T>, Pretty<I>, Ctx>["decode"];
  encode: Codec<Pretty<T>, Pretty<I>, Ctx>["encode"];
  encodeInto: Codec<Pretty<T>, Pretty<I>, Ctx>["encodeInto"];
  sizeOf: Codec<Pretty<T>, Pretty<I>, Ctx>["sizeOf"];

  /** Types only: marks parsers. */
  readonly [structured]: true;
  /**
   * A decoder of only the named fields: it steps over the others without
   * decoding them (no strings, objects or `map` conversions), but still
   * reads and checks the whole value (literals, refinements, …).
   *
   * Fields that later lengths or tags name are decoded too (but not
   * returned). Without names, it steps over whole values, e.g. to count them.
   * The result only decodes, and takes no more fields.
   *
   * @param names The fields to decode.
   * @returns A parser decoding objects of the named fields.
   * @throws {Error} If the parser has no field of a name (when defined).
   * @example
   * const Song = bin().u32le("id").field("title", string(u8)).f64le("duration");
   * const Summary = Song.pick("id", "duration"); // { id: number; duration: number }
   */
  pick<const Names extends readonly Keys<T>[]>(
    ...names: Names
  ): Struct<Picked<T, Names>, never, Ctx>;
}

/**
 * A parser, defined field by field: each method returns a new parser.
 * `T` is the union of the objects it decodes, `I` that of those it encodes
 * (fields with values the parser supplies, as literals, may be omitted),
 * and `Ctx` holds fields it reads from the parser it is added to.
 */
export interface Bin<T, I = T, Ctx = unknown>
  extends Struct<T, I, Ctx>, NumberFields<T, I, Ctx> {
  /**
   * Adds a field `name`, decoded and encoded with `codec`.
   *
   * The codec may read the fields before it: by name (`bytes("count")`,
   * `when("flag", …)`, `match("type")`), or with a function of them
   * (`bytes((o) => o.count * 2)`). Functions get the decoded fields, or, when
   * encoding, the values being encoded (with omitted literals and computed
   * fields filled in). A match on an earlier field makes the objects a union,
   * with a variant for each case.
   *
   * @param name The name of the field, unique in the parser.
   * @param codec The codec of its value.
   * @returns A new parser, with the field added.
   * @throws {Error} If the parser has a field `name` (when defined), or, from
   *   JavaScript, if `codec` reads a field that is not before it (when first
   *   used).
   * @example
   * bin().u8("count").field("data", bytes((o) => o.count * 2));
   */
  field<const K extends string, O, In, X = never, D extends boolean = false>(
    name: K,
    codec: Checked<
      X,
      Seen<T, I, Ctx>,
      Codec<O, In, Seen<T, I, Ctx>, boolean> & {
        readonly [matchTypes]?: X;
        readonly [defaulted]?: D;
      }
    >,
  ): [MatchOf<X>] extends [never]
    ? Bin<Add<T, K, O>, AddInput<I, K, In, D>, Ctx>
    : Bin<
        Apply<T, MatchOf<X>, K, "out", Ctx>,
        Apply<I, MatchOf<X>, K, "in", Ctx>,
        Ctx
      >;

  /**
   * Adds the fields of another parser, as if they were written here.
   *
   * `other` may also be one of several parsers (`cond ? A : B`, adding a
   * union), or a match whose cases are parsers: the fields of the case are
   * added, and the objects become a union with a variant for each case. The
   * merged parser may read fields of this one, which it declares:
   * `bin<{ length: number }>()`.
   *
   * @param other A parser, or a match of parsers.
   * @returns A new parser, with the fields added.
   * @throws {Error} If a field name is taken (the cases of one match may
   *   share names), or adjoining bit fields have different orders (when
   *   defined).
   * @example
   * const Message = bin()
   *   .u8("type")
   *   .merge(
   *     match("type")
   *       .case(1, bin().field("name", string(u8)))
   *       .case(2, bin().u32be("room").field("text", string(u16be))),
   *   );
   * // { type: 1; name: string } | { type: 2; room: number; text: string }
   */
  merge<B extends AnyCase, X = never>(
    other: Checked<
      X,
      Seen<T, I, Ctx>,
      B &
        Codec<object, never, Seen<T, I, Ctx>> & {
          readonly [matchTypes]?: X;
        } & ([B] extends [{ readonly [structured]: true }]
          ? unknown
          : {
              readonly "merge needs a parser; use field(name, codec) for a value": never;
            })
    >,
  ): [MatchOf<X>] extends [never]
    ? Bin<T & Output<B>, I & Input<B>, Ctx>
    : Bin<
        Apply<T, MatchOf<X>, null, "out", Ctx>,
        Apply<I, MatchOf<X>, null, "in", Ctx>,
        Ctx
      >;

  /**
   * Skips `size` bytes: decoding steps over them, and encoding writes zeros.
   *
   * @param size The number of bytes.
   * @returns A new parser.
   * @throws {RangeError} If `size` is not a non-negative safe integer.
   */
  skip(size: number): Bin<T, I, Ctx>;

  /**
   * Skips to the next multiple of `size` bytes from the start of the parser
   * (a merged parser counts from its own start); encoding writes zeros.
   *
   * @param size The alignment in bytes.
   * @returns A new parser.
   * @throws {RangeError} If `size` is not a positive safe integer.
   * @example
   * // A RIFF chunk takes an even number of bytes
   * bin().field("id", string(4)).u32le("size").field("data", bytes("size")).align(2);
   */
  align(size: number): Bin<T, I, Ctx>;

  /**
   * Calls `f` with this parser: for a group of fields used in several
   * parsers.
   *
   * @param f A function adding fields to a parser. Give lengths in it as
   *   functions: names cannot be checked against a type parameter.
   * @returns What `f` returns.
   * @example
   * const withValues = <T extends { count: number }, I extends { count: number }>(
   *   b: Bin<T, I>,
   * ) => b.field("values", bytes((o) => o.count * 2));
   * const Record = bin().u8("count").pipe(withValues);
   */
  pipe<R>(f: (bin: this) => R): R;

  /**
   * Computes field `name` when encoding, so the input may omit it: a value
   * given for it must be the computed one (as by `Object.is`). Decoding is
   * unchanged.
   *
   * `compute` gets the value without the field (and without omitted
   * literals), and must not return `undefined`. The parser takes no more
   * fields.
   *
   * @param name The field to compute.
   * @param compute Computes the field from the value being encoded.
   * @returns A parser that computes the field.
   * @throws {Error} If the parser has no field `name` (when defined).
   * @example
   * const Chunk = bin()
   *   .u32be("length")
   *   .field("data", bytes("length"))
   *   .computed("length", (chunk) => chunk.data.length);
   * Chunk.encode({ data: Uint8Array.of(1, 2) }); // Uint8Array [0, 0, 0, 2, 1, 2]
   */
  computed<const K extends keyof I & string, const V extends ValueOf<I, K>>(
    name: K,
    compute: (value: Without<I, K>) => V,
  ): Struct<Pretty<T>, Computed<I, K, V>, Ctx>;

  /**
   * Computes several fields when encoding, so the input may omit them. Each
   * function gets the value without any of the computed fields, so they do
   * not see each other's results. The parser takes no more fields.
   *
   * @param fields The function computing each field, by name.
   * @returns A parser that computes the fields.
   * @throws {Error} If the parser has no field of a name (when defined).
   * @example
   * const Packet = bin()
   *   .u8("count")
   *   .u16le("size")
   *   .field("items", array(u16le, "count"))
   *   .field("data", bytes("size"))
   *   .computed({ count: (p) => p.items.length, size: (p) => p.data.length });
   * Packet.encode({ items: [1], data: Uint8Array.of(2) }); // Uint8Array [1, 1, 0, 1, 0, 2]
   */
  computed<const K extends keyof I & string>(fields: {
    [P in K]: (value: Without<I, K>) => ValueOf<I, P>;
  }): Struct<Pretty<T>, BatchComputed<I, K>, Ctx>;
}

/**
 * Any parser (a `Bin`, or a `Struct`), for constraints: inputs and contexts
 * are contravariant, so their top type is `never`. (Groups of fields keep
 * the parser's types with type parameters: `<T, I>(b: Bin<T, I>) => …`.)
 */
export type AnyBin = Struct<unknown, never, never>;

/** Options of `bin`. */
export interface BinOptions {
  /**
   * The order bit fields take the bits of a byte in: most significant first
   * (`"msb"`, the default, as in network protocols), or least significant
   * first (`"lsb"`).
   */
  bitOrder?: "msb" | "lsb" | undefined;
}

/**
 * An empty parser: a codec of objects, defined field by field. Each method
 * adds a field, and returns a new parser typed from the fields before it.
 * Lengths, counts, tags and conditions may name earlier fields, which
 * TypeScript checks.
 *
 * @param options `bitOrder`: whether bit fields take the most (`"msb"`, the
 *   default) or the least (`"lsb"`) significant bits of a byte first.
 * @returns A parser without fields.
 * @throws {TypeError} If an option is unknown or invalid.
 * @example
 * const Player = bin()
 *   .u32le("id")
 *   .field("name", string(u8))
 *   .u8("count")
 *   .field("ratings", array(u16le, "count"));
 * const player = Player.decode(input);
 * // { id: number; name: string; count: number; ratings: number[] }
 * Player.encode(player); // The bytes again
 */
export function bin(options?: BinOptions): Bin<{}, {}>;
/**
 * An empty parser that reads fields `Ctx` of the parser it is merged into
 * (or is a match case of).
 *
 * @param options `bitOrder`: whether bit fields take the most (`"msb"`, the
 *   default) or the least (`"lsb"`) significant bits of a byte first.
 * @returns A parser without fields, whose codecs may read the fields `Ctx`.
 * @throws {TypeError} If an option is unknown or invalid.
 * @example
 * const Payload = bin<{ length: number }>().field("body", bytes("length"));
 * const Packet = bin().u8("kind").u16le("length").merge(Payload);
 */
export function bin<Ctx>(options?: BinOptions): Bin<{}, {}, Ctx>;
export function bin(options: BinOptions = {}): unknown {
  for (const key of Object.keys(options)) {
    if (key !== "bitOrder") throw new TypeError(`unknown option \`${key}\``);
  }
  const order = options.bitOrder ?? "msb";
  if (order !== "msb" && order !== "lsb") {
    throw new TypeError(`invalid bit order ${String(order)}`);
  }
  return new ParserWithNumbers([], order);
}

// Run time: a parser is a list of entries.

export type Order = "msb" | "lsb";
type Compute = (value: Obj) => unknown;

/** @internal */
export type Entry =
  | {
      readonly kind: "field";
      readonly name: string;
      readonly codec: AnyCodec;
      readonly order: Order;
    }
  /** A codec whose fields are added without flattening its entries. */
  | { readonly kind: "group"; readonly codec: AnyCodec & Merged }
  /** Bytes skipped: `size` of them, or (`align`) up to a multiple of `size` from the start of the parser. */
  | { readonly kind: "pad"; readonly size: number; readonly align: boolean };

/**
 * @param entry An entry of a parser.
 * @param definite Whether to leave out the fields of only some cases.
 * @returns The names of the fields it adds, each once.
 */
function names(entry: Entry, definite = false): string[] {
  return entry.kind === "pad"
    ? []
    : entry.kind === "group"
      ? entry.codec.names(definite)
      : [entry.name];
}

/**
 * Also checks that no name is taken.
 *
 * @param entry The entry being added.
 * @param own The names of the fields before it.
 * @param definite Those of them set whatever the cases of matches.
 * @param reads Dependencies not already supplied by earlier fields.
 */
function addNames(
  entry: Entry,
  own: Set<string>,
  definite: Set<string>,
  reads: Set<Reads[number]>,
): void {
  for (const name of readsOf(entry)) {
    if (name === ALL_FIELDS || !definite.has(name)) reads.add(name);
  }
  for (const name of names(entry)) {
    if (typeof name !== "string" || own.has(name) || name === "__proto__") {
      throw new Error(`invalid or duplicate field \`${name}\``);
    }
    own.add(name);
  }
  for (const name of names(entry, true)) definite.add(name);
}

/** @internal */
export class Parser extends Codec<Obj> {
  readonly entries: readonly Entry[];
  readonly order: Order;
  /** The names of its fields in order (those of the cases of a match once). */
  private readonly own: ReadonlySet<string>;
  /** Those set whatever the cases of its matches (where they are not, fields around it are read). */
  private readonly definite: ReadonlySet<string>;
  /** Opaque layout of the last run, maintained by its codec. */
  private readonly tail: { size: number } | undefined;
  /** The fields it computes (it adds no more fields). */
  readonly computes: readonly (readonly [string, Compute])[] | undefined;
  /** The fields it decodes (it only decodes). */
  readonly selection: ReadonlySet<string> | undefined;

  constructor(
    entries: readonly Entry[],
    order: Order,
    prefix?: Parser,
    computes?: readonly (readonly [string, Compute])[],
    selection?: ReadonlySet<string>,
  ) {
    const own = new Set(prefix?.own);
    const definite = new Set(prefix?.definite);
    const reads = new Set(prefix?.reads);
    let size = prefix?.size ?? 0;
    let checks = prefix?.checks ?? false;
    let tail = prefix?.tail;
    for (let i = prefix?.entries.length ?? 0; i < entries.length; i++) {
      const entry = entries[i];
      addNames(entry, own, definite, reads);
      if (entry.kind === "pad") {
        size += entry.align ? Number.NaN : entry.size;
        tail = undefined;
      } else {
        const { codec } = entry;
        checks ||= codec.checks;
        tail =
          entry.kind === "field"
            ? codec.packing?.layout(tail, entry.order)
            : undefined;
        size += tail?.size ?? codec.size;
      }
    }
    super(size, checks || Boolean(computes), [...reads]);
    this.own = own;
    this.definite = definite;
    this.tail = tail;
    this.entries = entries;
    this.order = order;
    this.computes = computes;
    this.selection = selection;
  }

  /**
   * @returns Whether it aligns fields after fields of varying sizes (after
   *   fixed sizes, aligning is skipping).
   */
  private get aligns(): boolean {
    return this.entries.some((entry) => entry.kind === "pad" && entry.align);
  }

  /**
   * @param definite Whether to leave out the fields of only some cases.
   * @returns The names in order (if it decodes some fields, those).
   */
  names(definite = false): string[] {
    const all = [...(definite ? this.definite : this.own)];
    return this.selection ? all.filter((n) => this.selection!.has(n)) : all;
  }

  field(name: string, codec: AnyCodec): Parser {
    if (!(codec instanceof Codec)) {
      throw new TypeError(`the codec of \`${name}\` is not a codec`);
    }
    return this.add([{ kind: "field", name, codec, order: this.order }]);
  }

  skip(size: number): Parser {
    if (!(Number.isSafeInteger(size) && size >= 0)) {
      throw new RangeError(`invalid size ${String(size)}`);
    }
    return this.add([{ kind: "pad", size, align: false }]);
  }

  align(size: number): Parser {
    if (!(Number.isSafeInteger(size) && size >= 1)) {
      throw new RangeError(`invalid alignment ${String(size)}`);
    }
    // After fields of fixed sizes, the bytes to skip are known.
    return Number.isFinite(this.size)
      ? this.skip((size - (this.size % size)) % size)
      : this.add([{ kind: "pad", size, align: true }]);
  }

  merge(other: unknown): Parser {
    if (other instanceof Parser) {
      // Parsers aligning fields keep their start.
      return this.add(
        other.computes || other.selection || other.aligns
          ? [{ kind: "group", codec: other }]
          : other.entries,
      );
    }
    if (other instanceof Codec && other.merged) {
      return this.add([{ kind: "group", codec: other.merged }]);
    }
    throw new TypeError(
      "merge needs a parser, or a match of parsers; use field(name, codec) for a value",
    );
  }

  pipe<R>(f: (bin: this) => R): R {
    return f(this);
  }

  computed(name: string | Record<string, Compute>, compute?: Compute): Parser {
    const computes =
      typeof name === "string"
        ? [[name, compute!] as const]
        : Object.entries(name);
    const own = new Set(this.names());
    for (const [key, fn] of computes) {
      if (!own.has(key)) throw new Error(`no field \`${key}\``);
      if (typeof fn !== "function") {
        throw new TypeError(`the computation of \`${key}\` is not a function`);
      }
    }
    return new Parser(this.entries, this.order, this, computes);
  }

  pick(...picked: string[]): Parser {
    const own = new Set(this.names());
    for (const name of picked) {
      if (!own.has(name)) throw new Error(`no field \`${name}\``);
    }
    return new Parser(
      this.entries,
      this.order,
      this,
      this.computes,
      new Set(picked),
    );
  }

  private add(entries: readonly Entry[]): Parser {
    if (this.computes || this.selection) {
      throw new Error(
        "no fields can be added to a parser computing fields, or decoding some",
      );
    }
    return new Parser([...this.entries, ...entries], this.order, this);
  }

  // Parsers of a fixed size are inlined in the code of others (their code is bounded by their size).

  emitRead(g: Gen, wanted: boolean): string {
    if (!Number.isFinite(this.size)) {
      return g.call(this, wanted);
    }
    const object = g.inline(() => this.emitBody(g, wanted ? "all" : "none"));
    return object && g.let(object);
  }

  emitWrite(g: Gen, value: string): void {
    if (Number.isFinite(this.size)) g.inline(() => this.encodeObject(g, value));
    else g.call(this, value);
  }

  private encodeObject(g: Gen, value: string): void {
    g.check(
      `typeof ${value} !== "object" || ${value} === null`,
      "invalid",
      `"expected an object, got " + String(${value})`,
    );
    this.encodeFields(g, value);
  }

  override emitBody(g: Gen, selection: Selection): string {
    if (g.encoding) {
      this.encodeObject(g, "v");
      return "";
    }
    const wanted =
      selection === "all" ? new Set(this.names()) : new Set<string>();
    const parts = this.decodeFields(g, wanted, new Set());
    return selection === "none" ? "" : objectOf(g, parts);
  }

  /**
   * Fields that `later` names are decoded too, but not returned.
   *
   * @param g The generator of the function.
   * @param wanted The names of the fields in the object.
   * @param later The names of the fields that entries after these read.
   * @returns The parts of the object, in order.
   */
  decodeFields(
    g: Gen,
    wanted: ReadonlySet<string>,
    later: ReadonlySet<string>,
  ): Piece[] {
    const { entries } = this;
    const own = this.selection ?? wanted;
    const output = this.selection
      ? new Set([...wanted].filter((n) => this.selection!.has(n)))
      : wanted;
    // The fields of each entry that the entries after it read (all of them
    // before a function getting every field).
    const after: ReadonlySet<string>[] = [];
    const read = new Set(later);
    let all = false;
    for (let i = entries.length - 1; i >= 0; i--) {
      const defined = names(entries[i]);
      after[i] = new Set(
        all ? defined : defined.filter((name) => read.has(name)),
      );
      for (const name of readsOf(entries[i])) {
        if (name === ALL_FIELDS) all = true;
        else read.add(name);
      }
    }
    const parts: Piece[] = [];
    const want = (name: string, i: number): boolean =>
      own.has(name) || after[i].has(name);
    const start = this.aligns ? g.let(valueOffset(g)) : "";
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.kind === "field" && entry.codec.packing) {
        i = entry.codec.packing.decodeRun(g, entries, i, want, parts, output);
      } else if (entry.kind === "pad") {
        pad(g, entry, start);
      } else if (entry.kind === "field") {
        const { name, codec } = entry;
        if (Number.isFinite(codec.size) && !g.available(codec.size)) {
          g.field = undefined;
          g.need(...run(entries, i));
        }
        g.field = name;
        const from = g.mode === "trace" ? g.let(g.at()) : "";
        const v = codec.emitRead(g, want(name, i));
        if (from) g.trace(from, v);
        if (v) g.fields.set(name, v);
        if (output.has(name)) parts.push({ name, v });
      } else {
        parts.push(...entry.codec.decodeGroup(g, output, after[i]));
      }
    }
    g.field = undefined;
    return parts;
  }

  /**
   * For a parser merged into another: its own fields stay its own.
   *
   * @param g The generator of the function.
   * @param wanted The names of the fields in the object.
   * @param later The names of the fields that entries after the group read.
   * @returns The parts of the object, in order.
   */
  decodeGroup(
    g: Gen,
    wanted: ReadonlySet<string>,
    later: ReadonlySet<string>,
  ): Piece[] {
    if (!this.selection) return this.decodeFields(g, wanted, later);
    // Fields not picked stay in the group.
    const outer = g.fields;
    g.fields = new Map(outer);
    const parts = this.decodeFields(g, wanted, this.selection);
    const picked = g.fields;
    g.fields = outer;
    for (const name of this.selection) {
      const v = picked.get(name);
      if (v !== undefined) g.fields.set(name, v);
    }
    return parts;
  }

  /**
   * @returns The fields that sizes of values depend on: those of variable
   *   sizes, and those their codecs read.
   */
  private sizedBy(): Set<Reads[number]> {
    const fields = new Set<Reads[number]>();
    for (const entry of this.entries) {
      if (
        entry.kind === "pad" ||
        (entry.kind === "field" && entry.codec.packing) ||
        Number.isFinite(entry.codec.size)
      ) {
        continue;
      }
      for (const name of [...names(entry), ...entry.codec.reads]) {
        fields.add(name);
      }
    }
    return fields;
  }

  /**
   * @param g The generator of the function.
   * @param object The variable of the object.
   * @param supplied The variables of fields computed around it, by name.
   */
  encodeFields(
    g: Gen,
    object: string,
    supplied: ReadonlyMap<string, string> = new Map(),
  ): void {
    if (this.selection) {
      g.fail("invalid", '"a parser decoding some fields cannot encode"');
      return;
    }
    const computed = new Map(supplied);
    // Sizing computes only the fields that sizes depend on.
    const sizes = g.mode === "size" ? this.sizedBy() : undefined;
    const computes = this.computes?.filter(
      ([name]) => !sizes || sizes.has(ALL_FIELDS) || sizes.has(name),
    );
    if (computes !== undefined && computes.length > 0) {
      // Functions get the value without the computed fields: the fields of the parser only.
      const input = g.callback(
        project,
        object,
        g.k(this.names().filter((n) => !this.computes!.some(([k]) => k === n))),
        objectOf(
          g,
          [...supplied].map(([name, v]) => ({ name, v })),
        ),
      );
      for (const [name, compute] of computes) {
        g.field = name;
        const key = supplied.get(name) ?? `${object}[${JSON.stringify(name)}]`;
        const v = g.callback(compute, input);
        g.check(`${v} === undefined`, "invalid", '"is computed as undefined"');
        g.check(
          `${key} !== undefined && !Object.is(${key}, ${v})`,
          "invalid",
          `"is " + String(${key}) + ", but computed as " + String(${v})`,
        );
        computed.set(name, v);
      }
    }
    const { entries } = this;
    const start = this.aligns ? g.let(valueOffset(g)) : "";
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.kind === "field" && entry.codec.packing) {
        i = entry.codec.packing.encodeRun(g, entries, i, object, computed);
      } else if (entry.kind === "pad") {
        pad(g, entry, start);
      } else if (entry.kind === "field") {
        const { name, codec } = entry;
        if (Number.isFinite(codec.size) && !g.available(codec.size)) {
          g.field = undefined;
          g.need(run(entries, i)[0]);
        }
        g.field = name;
        const v = g.let(
          computed.get(name) ?? `${object}[${JSON.stringify(name)}]`,
          "let",
        );
        const { preset } = codec;
        if (preset) {
          g.line(`if (${v} === undefined) ${v} = ${g.k(preset.value)};`);
        }
        writeValue(g, codec, v);
        g.fields.set(name, v);
      } else {
        entry.codec.encodeFields(g, object, computed);
      }
    }
    g.field = undefined;
  }
}

/**
 * @param g The generator of the function.
 * @param entry The bytes: a number of them, or an alignment.
 * @param start The variable of the offset of the parser in the value.
 */
function pad(
  g: Gen,
  entry: Extract<Entry, { kind: "pad" }>,
  start: string,
): void {
  const { size } = entry;
  g.field = undefined;
  const n = entry.align
    ? g.let(`(${size} - (${valueOffset(g)} - ${start}) % ${size}) % ${size}`)
    : size;
  g.need(n);
  if (g.encoding) g.write(`buf.fill(0, ${g.at()}, ${g.at(n)});`);
  g.skip(n);
}

/**
 * @param g The generator of the function.
 * @returns An expression of the offset in the value (when encoding, from
 *   `w.base`, which a growing writer moves).
 */
function valueOffset(g: Gen): string {
  return g.encoding ? `${g.at()} - w.base` : g.at();
}

function readsOf(entry: Entry): Reads {
  return entry.kind === "pad" ? [] : entry.codec.reads;
}

/** A codec adding fields to a parser. @internal */
export type Merged = Pick<Parser, "names" | "decodeGroup" | "encodeFields">;

/** A decoded field, or a codec's deferred object construction. */
export type Piece =
  | Field
  | {
      object(g: Gen, parts: readonly Piece[], into?: string): string;
    };
export interface Field {
  readonly name: string;
  readonly v: string;
}

/**
 * Merged matches build objects of their own variants.
 *
 * @param g The generator of the function.
 * @param parts The fields in order.
 * @param into An existing object to add the fields to.
 * @returns An object expression, or the variable holding the object.
 */
export function objectOf(
  g: Gen,
  parts: readonly Piece[],
  into?: string,
): string {
  const deferred = parts.find((part) => "object" in part);
  if (deferred) return deferred.object(g, parts, into);
  const fields = parts as Field[];
  if (into !== undefined) {
    for (const { name, v } of fields) {
      g.line(`${into}[${JSON.stringify(name)}] = ${v};`);
    }
    return into;
  }
  return `{ ${fields.map(({ name, v }) => `${JSON.stringify(name)}: ${v}`).join(", ")} }`;
}

/**
 * @param value The object being encoded.
 * @param keys The fields to take, if `value` has them.
 * @param supplied Values of fields computed around it, which take precedence.
 * @returns A new object, for computations.
 */
function project(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  supplied: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const name of keys) {
    if (Object.hasOwn(supplied, name)) {
      projected[name] = supplied[name];
    } else if (Object.hasOwn(value, name)) {
      projected[name] = value[name];
    }
  }
  return projected;
}

/**
 * @param entries The entries of a parser.
 * @param i The index of a field.
 * @returns The bytes the fixed-size fields from `i` on take, and the fields
 *   (for errors).
 */
function run(
  entries: readonly Entry[],
  i: number,
): [number, [string, number, number][]] {
  const fields: [string, number, number][] = [];
  let end = 0;
  for (let j = i; j < entries.length; j++) {
    const entry = entries[j];
    if (entry.kind !== "field" || !Number.isFinite(entry.codec.size)) break;
    fields.push([entry.name, end, (end += entry.codec.size)]);
  }
  return [end, fields];
}

const ParserWithNumbers = /* @__PURE__ */ (() => {
  for (const [name, codec] of Object.entries(primitives)) {
    Object.defineProperty(Parser.prototype, name, {
      value(this: Parser, field: string) {
        return this.field(field, codec as AnyCodec);
      },
    });
  }
  return Parser;
})();
