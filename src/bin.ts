/**
 * Parsers, defined field by field: `bin().u8("count").field("items", array(Item, "count"))`.
 * Each method returns a new parser, and every parser is a codec of objects.
 */
import {
  Codec,
  ALL_FIELDS,
  type AnyCase,
  type AnyCodec,
  type Defaulted,
  type defaulted,
  type Input,
  type Obj,
  type Output,
  type Reads,
} from "./codec.ts";
import type { Gen, Selection } from "./compile.ts";
import {
  Match,
  type Value,
  type matchTypes,
  type IsUnion,
  type CaseCodec,
  type CaseValues as CaseValue,
} from "./match.ts";
import { primitives, type Numbers } from "./primitives.ts";

/*
 * Types: the fields of a parser are a union of objects (`T` decoded, `I`
 * encoded), built as intersections (which stay flat in long parsers) and
 * shown as object types. A parser without fields has `{}`.
 */
/* eslint-disable @typescript-eslint/no-empty-object-type */

/** Flattens intersections into object types (for each variant of a union). */
type Pretty<T> = T extends unknown ? { [K in keyof T]: T[K] } : never;
/** The field names of any variant of `T`. */
type Keys<T> = T extends unknown ? keyof T & string : never;
/** `T` with field `K` of type `V`. */
type Add<T, K extends string, V> = T extends unknown
  ? K extends unknown
    ? T & { [P in K]: V }
    : never
  : never;
/** `I` with field `K` of type `V`, which may be omitted if the codec supplies it (`D`). */
type AddInput<I, K extends string, V, D = false> = I extends unknown
  ? I & ([D] extends [true] ? { [P in K]?: V } : { [P in K]: V })
  : never;
/** Each variant of `A` combined with each of `B`. */
type Cross<A, B> = A extends unknown
  ? B extends unknown
    ? A & B
    : never
  : never;
/** The values functions see when encoding: omitted fields (which have optional keys) are supplied. */
type Resolved<I> = I extends unknown
  ? {
      [K in keyof I]-?: {} extends Pick<I, K> ? Exclude<I[K], undefined> : I[K];
    }
  : never;
/** The fields functions see: decoded, or (if they differ) encoded. */
type Available<T, I> = [Resolved<I>] extends [T] ? T : T | Resolved<I>;
type InScope<Fields, Outer> = Fields extends unknown
  ? Outer extends unknown
    ? Pretty<Omit<Outer, keyof Fields> & Fields>
    : never
  : never;
/** The fields a codec added to a parser sees: the parser's, and those around it (`Ctx`). */
type Seen<T, I, Ctx> = unknown extends Ctx
  ? Available<T, I>
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
    : Exclude<CaseValue<Cs>, TagOf<F, Tag>>
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
  ? [T[K] & V] extends [never]
    ? never
    : {
        [P in keyof T]: P extends K
          ? (T[P] & V) | (undefined extends T[P] ? undefined : never)
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
      : | (Cs extends readonly [infer V, infer C]
            ? Branch<T, Tag, V, C, K, S>
            : never)
        | ([D] extends [never]
            ? never
            : Branch<
                T,
                Tag,
                Exclude<TagIn<T, Outer, Tag>, CaseValue<Cs>>,
                D,
                K,
                S
              >)
    : never
  : never;

type NumberFields<T, I, Ctx> = {
  [N in keyof Numbers]: <const K extends string>(
    name: K,
  ) => Bin<
    Add<T, K, Output<Numbers[N]>>,
    AddInput<I, K, Input<Numbers[N]>>,
    Ctx
  >;
};
// prettier-ignore
type BitWidth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | 51 | 52 | 53;

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
 * A parser that adds no more fields (as it computes some, or decodes only
 * some): `T` is the union of the objects it decodes, `I` that of those it
 * encodes, and `Ctx` holds fields it reads from the parser it is added to.
 */
export interface Struct<T, I = T, Ctx = unknown> extends Codec<
  Pretty<T>,
  Pretty<I>,
  Ctx
> {
  /** Types only: marks parsers. */
  readonly [structured]: true;
  /**
   * A decoder of only the named fields. It still reads (and checks) the
   * whole value, and decodes the fields that later ones depend on.
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
  /** Adds a field of `width` (1 to 53) bits; bit fields that follow each other share their bytes. */
  bits<const K extends string>(
    name: K,
    width: BitWidth,
  ): Bin<Add<T, K, number>, AddInput<I, K, number>, Ctx>;

  /**
   * Adds a field (starting at a byte). Its codec may read the fields before
   * it (`bytes("count")`, `bytes((o) => o.count * 2)`); functions get their
   * decoded values, or, when encoding, the values being encoded. A match on
   * an earlier field narrows the objects to a variant for each case.
   */
  field<const K extends string, O, In, X = never, D extends boolean = false>(
    name: K,
    codec: Checked<
      X,
      Seen<T, I, Ctx>,
      Codec<O, In, Seen<T, I, Ctx>> & {
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
   * Adds the fields of another parser (or of one of several: a union), or
   * of the case of a match of parsers (whose variants it adds).
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
    ? Bin<Cross<T, Output<B>>, Cross<I, Input<B>>, Ctx>
    : Bin<
        Apply<T, MatchOf<X>, null, "out", Ctx>,
        Apply<I, MatchOf<X>, null, "in", Ctx>,
        Ctx
      >;

  /** Applies a function adding fields (a group of fields used in several parsers). */
  pipe<R>(f: (bin: this) => R): R;

  /**
   * Computes field `name` from the rest of the value when encoding, so it
   * may be omitted (a value given must be the computed one). It ends the
   * parser: compute several fields with an object of functions.
   */
  computed<const K extends keyof I & string, const V extends ValueOf<I, K>>(
    name: K,
    compute: (value: Without<I, K>) => V,
  ): Struct<Pretty<T>, Computed<I, K, V>, Ctx>;

  /** Computes several fields; every function gets the value without any of them. */
  computed<const K extends keyof I & string>(fields: {
    [P in K]: (value: Without<I, K>) => ValueOf<I, P>;
  }): Struct<Pretty<T>, BatchComputed<I, K>, Ctx>;
}

/**
 * Any parser (a `Bin`, or a `Struct`), for constraints: inputs and contexts
 * are contravariant, so their top type is `never`. (Groups of fields keep
 * the parser's types with type parameters: `<T, I>(b: Bin<T, I>) => …`.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any output
export type AnyBin = Struct<any, never, never>;

/** Options of parsers. */
export interface BinOptions {
  /** The order bit fields take the bits of a byte in: most (default) or least significant first. */
  bitOrder?: "msb" | "lsb";
}

/** An empty parser. */
export function bin(options?: BinOptions): Bin<{}, {}>;
/**
 * An empty parser reading fields `Ctx` of the parser it is merged into (or
 * is a match case of): `bin<{ length: number }>()`.
 */
export function bin<Ctx>(options?: BinOptions): Bin<{}, {}, Ctx>;
export function bin(options: BinOptions = {}): unknown {
  for (const key of Object.keys(options))
    if (key !== "bitOrder") throw new TypeError(`unknown option \`${key}\``);
  const order = options.bitOrder ?? "msb";
  if (order !== "msb" && order !== "lsb")
    throw new TypeError(`invalid bit order ${String(order)}`);
  return new Parser([], order);
}

// Run time: a parser is a list of entries.

type Order = "msb" | "lsb";
type Compute = (value: Obj) => unknown;

type Entry =
  | { readonly kind: "field"; readonly name: string; readonly codec: AnyCodec }
  | {
      readonly kind: "bits";
      readonly name: string;
      readonly width: number;
      readonly order: Order;
    }
  /** A match of parsers, whose fields are added. */
  | { readonly kind: "match"; readonly match: Match }
  /** A parser computing fields or decoding some, whose fields are added. */
  | { readonly kind: "group"; readonly struct: Parser };

/** The names of fields an entry adds (of every case). */
function names(entry: Entry): string[] {
  switch (entry.kind) {
    case "match":
      return [...new Set(cases(entry.match).flatMap((s) => s.names()))];
    case "group":
      return entry.struct.names();
    default:
      return [entry.name];
  }
}

/** The parsers of the cases of a match. */
function cases(match: Match): Parser[] {
  const all = match.cases.map(([, codec]) => codec);
  if (match.default) all.push(match.default);
  return all as unknown as Parser[];
}

/** The size of entries, and whether reading them checks something. */
function measure(entries: readonly Entry[]): [size: number, checks: boolean] {
  let size = 0;
  let bits = 0;
  let checks = false;
  for (const entry of entries) {
    if (entry.kind === "bits") {
      bits += entry.width;
      continue;
    }
    size += Math.ceil(bits / 8);
    bits = 0;
    const codec =
      entry.kind === "field"
        ? entry.codec
        : entry.kind === "match"
          ? entry.match
          : entry.struct;
    size += codec.size;
    checks ||= codec.checks;
  }
  return [size + Math.ceil(bits / 8), checks];
}

/** Named fields read outside this plan, plus the callback-prefix marker. */
function unresolved(entries: readonly Entry[]): Reads {
  const own = new Set<string>();
  const reads = new Set<Reads[number]>();
  for (const entry of entries) {
    for (const name of readsOf(entry))
      if (name === ALL_FIELDS || !own.has(name)) reads.add(name);
    for (const name of names(entry)) own.add(name);
  }
  return [...reads];
}

/** A parser at run time: a list of entries. */
class Parser extends Codec<Obj> {
  readonly entries: readonly Entry[];
  readonly order: Order;
  /** The fields it computes (it adds no more fields). */
  readonly computes: readonly (readonly [string, Compute])[] | undefined;
  /** The fields it decodes (it only decodes). */
  readonly selection: ReadonlySet<string> | undefined;

  constructor(
    entries: readonly Entry[],
    order: Order,
    computes?: readonly (readonly [string, Compute])[],
    selection?: ReadonlySet<string>,
  ) {
    const [size, checks] = measure(entries);
    super(size, checks || Boolean(computes), unresolved(entries));
    this.entries = entries;
    this.order = order;
    this.computes = computes;
    this.selection = selection;
  }

  /** The names of the fields it outputs. */
  names(): string[] {
    const all = this.entries.flatMap(names);
    return this.selection ? all.filter((n) => this.selection!.has(n)) : all;
  }

  field(name: string, codec: AnyCodec): Parser {
    if (!(codec instanceof Codec))
      throw new TypeError(`the codec of \`${name}\` is not a codec`);
    return this.add([{ kind: "field", name, codec }]);
  }

  bits(name: string, width: number): Parser {
    if (!(Number.isInteger(width) && width >= 1 && width <= 53))
      throw new RangeError(`\`${name}\` has ${width} bits, not 1 to 53`);
    return this.add([{ kind: "bits", name, width, order: this.order }]);
  }

  merge(other: unknown): Parser {
    if (other instanceof Parser) {
      return this.add(
        other.computes || other.selection
          ? [{ kind: "group", struct: other }]
          : other.entries,
      );
    }
    if (
      other instanceof Match &&
      cases(other).every((c) => c instanceof Parser)
    ) {
      return this.add([{ kind: "match", match: other }]);
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
      if (typeof fn !== "function")
        throw new TypeError(`the computation of \`${key}\` is not a function`);
    }
    return new Parser(this.entries, this.order, computes);
  }

  pick(...picked: string[]): Parser {
    const own = new Set(this.names());
    for (const name of picked) {
      if (!own.has(name)) throw new Error(`no field \`${name}\``);
    }
    return new Parser(this.entries, this.order, this.computes, new Set(picked));
  }

  /** The parser with entries added, which must add new fields. */
  private add(entries: readonly Entry[]): Parser {
    if (this.computes || this.selection)
      throw new Error(
        "no fields can be added to a parser computing fields, or decoding some",
      );
    const taken = new Set(this.names());
    for (const entry of entries) {
      const added = names(entry);
      for (const name of added) {
        if (typeof name !== "string" || taken.has(name) || name === "__proto__")
          throw new Error(`invalid or duplicate field \`${name}\``);
      }
      // Fields of different cases may have the same names.
      for (const name of added) taken.add(name);
    }
    const last = this.entries.at(-1);
    if (
      last?.kind === "bits" &&
      entries[0]?.kind === "bits" &&
      last.order !== entries[0].order
    ) {
      throw new Error("bit fields of different orders cannot share bytes");
    }
    return new Parser([...this.entries, ...entries], this.order);
  }

  emitRead(g: Gen, wanted: boolean): string {
    if (!wanted && !this.checks && Number.isFinite(this.size)) {
      g.need(this.size);
      g.skip(this.size);
      return "";
    }
    return g.call(this as unknown as AnyCodec, wanted);
  }

  emitWrite(g: Gen, value: string): void {
    g.call(this as unknown as AnyCodec, value);
  }

  override emitBody(g: Gen, selection: Selection): string {
    if (g.mode === "encode") {
      g.check(
        'typeof v !== "object" || v === null',
        "invalid",
        '"expected an object, got " + String(v)',
      );
      this.encodeFields(g, "v");
      return "";
    }
    const wanted =
      selection === "all"
        ? new Set(this.names())
        : selection === "none"
          ? new Set<string>()
          : selection;
    const parts = this.decodeFields(g, wanted, new Set());
    return selection === "none" ? "" : objectOf(parts);
  }

  /**
   * Emits code decoding the fields; returns the parts of the object (with
   * the `wanted` fields). Fields of `later` ones are decoded too.
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
    // The fields read by those after each entry (all of them before a function).
    const needed: ReadonlySet<string>[] = [];
    let after = new Set(later);
    let all = false;
    for (let i = entries.length - 1; i >= 0; i--) {
      needed[i] = all ? ALL : new Set(after);
      const reads = readsOf(entries[i]);
      after = new Set(after);
      for (const name of reads) {
        if (name === ALL_FIELDS) all = true;
        else after.add(name);
      }
    }
    const parts: Piece[] = [];
    const want = (name: string, i: number) =>
      own.has(name) || needed[i] === ALL || needed[i].has(name);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.kind === "bits") {
        i = this.decodeBits(g, i, want, parts, output);
      } else if (entry.kind === "field") {
        const { name, codec } = entry;
        if (Number.isFinite(codec.size) && !g.available(codec.size)) {
          g.field = undefined;
          g.need(...run(entries, i));
        }
        g.field = name;
        const v = codec.emitRead(g, want(name, i));
        if (v) g.fields.set(name, v);
        if (output.has(name)) parts.push({ name, v });
      } else {
        // Before a function, every field.
        const after = needed[i] === ALL ? new Set(names(entry)) : needed[i];
        if (entry.kind === "group")
          parts.push(...entry.struct.decodeGroup(g, output, after));
        else
          parts.push(
            this.emitCases(g, entry.match, (struct) =>
              struct.decodeFields(g, output, after),
            ),
          );
      }
    }
    g.field = undefined;
    return parts;
  }

  /** Emits code decoding a parser added to another (its own fields are only its own). */
  private decodeGroup(
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

  /** Emits a match's field scopes, sharing the locals its cases define. */
  private emitCases(
    g: Gen,
    match: Match,
    emit: (struct: Parser) => Piece[] | void,
  ): Piece {
    g.field = undefined;
    const structs = cases(match);
    const shared = new Map<string, string>();
    for (const struct of structs) {
      for (const name of struct.names()) {
        if (!shared.has(name)) shared.set(name, g.hoist());
      }
    }
    const branch = g.mode === "encode" ? "" : g.hoist();
    const outer = g.fields;
    const parts: Piece[][] = [];
    match.emitSwitch(g, (_codec, i) => {
      g.fields = new Map(outer);
      const own = emit(structs[i]);
      for (const [name, v] of g.fields) {
        if (shared.has(name) && outer.get(name) !== v)
          g.line(`${shared.get(name)} = ${v};`);
      }
      if (own) {
        g.line(`${branch} = ${i};`);
        parts[i] = own.map((part) =>
          "branch" in part
            ? part
            : { name: part.name, v: shared.get(part.name)! },
        );
      }
    });
    g.fields = new Map(outer);
    for (const [name, v] of shared) g.fields.set(name, v);
    return { branch, cases: parts };
  }

  /** Emits code decoding the bit fields from entry `i` on; returns the index of the last. */
  private decodeBits(
    g: Gen,
    i: number,
    want: (name: string, i: number) => boolean,
    parts: Piece[],
    output: ReadonlySet<string>,
  ): number {
    const fields = bitRun(this.entries, i);
    const bytes = Math.ceil(fields.reduce((n, f) => n + f.width, 0) / 8);
    g.field = undefined;
    g.need(bytes);
    let offset = 0;
    fields.forEach((field, j) => {
      if (want(field.name, i + j)) {
        g.field = field.name;
        const v = g.let(extract(g.at(), field.order, offset, field.width));
        g.fields.set(field.name, v);
        if (output.has(field.name)) parts.push({ name: field.name, v });
      }
      offset += field.width;
    });
    g.skip(bytes);
    return i + fields.length - 1;
  }

  /** Emits code encoding the fields of the object in variable `object`. */
  encodeFields(
    g: Gen,
    object: string,
    supplied: ReadonlyMap<string, string> = new Map(),
  ): void {
    if (this.selection) {
      g.check(
        "true",
        "invalid",
        '"a parser decoding some fields cannot encode"',
      );
      return;
    }
    const computed = new Map(supplied);
    if (this.computes) {
      // Functions get the value without the computed fields: the fields of the parser only.
      const input = g.callback(
        project,
        object,
        g.k(this.names().filter((n) => !this.computes!.some(([k]) => k === n))),
        objectOf([...supplied].map(([name, v]) => ({ name, v }))),
      );
      for (const [name, compute] of this.computes) {
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
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.kind === "bits") {
        i = this.encodeBits(g, i, object, computed);
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
        const preset = codec.preset;
        if (preset)
          g.line(`if (${v} === undefined) ${v} = ${g.k(preset.value)};`);
        codec.emitWrite(g, v);
        g.fields.set(name, v);
      } else if (entry.kind === "group") {
        entry.struct.encodeFields(g, object, computed);
      } else {
        this.emitCases(g, entry.match, (struct) =>
          struct.encodeFields(g, object, computed),
        );
      }
    }
    g.field = undefined;
  }

  /** Emits code encoding the bit fields from entry `i` on; returns the index of the last. */
  private encodeBits(
    g: Gen,
    i: number,
    object: string,
    computed: ReadonlyMap<string, string>,
  ): number {
    const fields = bitRun(this.entries, i);
    const total = fields.reduce((n, f) => n + f.width, 0);
    const bytes: string[][] = Array.from(
      { length: Math.ceil(total / 8) },
      () => [],
    );
    let offset = 0;
    for (const { name, width, order } of fields) {
      g.field = name;
      const v = g.let(
        computed.get(name) ?? `${object}[${JSON.stringify(name)}]`,
        "let",
      );
      g.fields.set(name, v);
      g.check(
        width > 32
          ? `!(Number.isInteger(${v}) && ${v} >= 0 && ${v} <= ${2 ** width - 1})`
          : width === 32
            ? `typeof ${v} !== "number" || ${v} >>> 0 !== ${v}`
            : `typeof ${v} !== "number" || (${v} & ${2 ** width - 1}) !== ${v}`,
        "invalid",
        `"expected an unsigned integer of ${width} bits, got " + String(${v})`,
      );
      // Wider values in two parts: the bits above the low 32, and the low 32.
      const pieces =
        width > 32
          ? [
              { v: g.let(`Math.floor(${v} / ${2 ** 32})`), width: width - 32 },
              { v: g.let(`${v} >>> 0`), width: 32 },
            ]
          : [{ v, width }];
      if (order === "lsb") pieces.reverse();
      for (const piece of pieces) {
        // The parts of the piece in each byte it is in.
        const end = offset + piece.width;
        for (let j = offset >> 3; j <= (end - 1) >> 3; j++) {
          const shift = order === "msb" ? 8 * j + 8 - end : offset - 8 * j;
          const part =
            shift >= 0 ? `${piece.v} << ${shift}` : `${piece.v} >>> ${-shift}`;
          bytes[j].push(`(${part}) & 255`);
        }
        offset = end;
      }
    }
    g.field = undefined;
    g.need(bytes.length);
    bytes.forEach((parts, j) =>
      g.line(`buf[${g.at(j)}] = ${parts.join(" | ")};`),
    );
    g.skip(bytes.length);
    return i + fields.length - 1;
  }
}

/** The fields an entry reads. */
function readsOf(entry: Entry): Reads {
  if (entry.kind === "bits") return [];
  return (
    entry.kind === "field"
      ? entry.codec
      : entry.kind === "match"
        ? entry.match
        : entry.struct
  ).reads;
}

/** Every field, before a function (which gets all of them). */
const ALL: ReadonlySet<string> = new Set();

/** A piece of a decoded object: a field, or the fields of the case of a match (`branch` holds its index). */
type Piece =
  | { readonly name: string; readonly v: string }
  | { readonly branch: string; readonly cases: readonly (readonly Piece[])[] };

/** The expression of an object with `parts` (objects of each combination of cases, if they are few). */
function objectOf(parts: readonly Piece[]): string {
  const combinations = parts.reduce(
    (n, part) => ("branch" in part ? n * part.cases.length : n),
    1,
  );
  if (combinations > 16) {
    const entries = parts.map((part) =>
      "branch" in part
        ? `...(${part.cases
            .map((c, i) => `${part.branch} === ${i} ? ${objectOf(c)} : `)
            .join("")}{})`
        : `${JSON.stringify(part.name)}: ${part.v}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  const i = parts.findIndex((part) => "branch" in part);
  if (i < 0) {
    return `{ ${parts.map((p) => `${JSON.stringify((p as { name: string }).name)}: ${(p as { v: string }).v}`).join(", ")} }`;
  }
  const { branch, cases } = parts[i] as Extract<Piece, { branch: string }>;
  const objects = cases.map((c) =>
    objectOf([...parts.slice(0, i), ...c, ...parts.slice(i + 1)]),
  );
  return objects
    .map((o, j) =>
      j < objects.length - 1 ? `${branch} === ${j} ? ${o} : ` : o,
    )
    .join("");
}

/** The fields of `value` named `names` (those it has), for computations. */
function project(value: Obj, names: readonly string[], supplied: Obj): Obj {
  const projected: Obj = {};
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(supplied, name))
      projected[name] = supplied[name];
    else if (Object.prototype.hasOwnProperty.call(value, name))
      projected[name] = value[name];
  }
  return projected;
}

/** The bit fields from entry `i` on that share bytes. */
function bitRun(
  entries: readonly Entry[],
  i: number,
): Extract<Entry, { kind: "bits" }>[] {
  const run: Extract<Entry, { kind: "bits" }>[] = [];
  for (let j = i; j < entries.length; j++) {
    const entry = entries[j];
    if (
      entry.kind !== "bits" ||
      entry.order !== (entries[i] as { order: Order }).order
    )
      break;
    run.push(entry);
  }
  return run;
}

/** The expression of the `width` bits `offset` bits into the bytes at `at`. */
function extract(
  at: string,
  order: Order,
  offset: number,
  width: number,
): string {
  if (width > 32) {
    // The bits above the low 32 (first in msb order), times 2 ** 32.
    const high = order === "msb" ? offset : offset + 32;
    const low = order === "msb" ? offset + width - 32 : offset;
    return `(${extract(at, order, high, width - 32)}) * ${2 ** 32} + (${extract(at, order, low, 32)})`;
  }
  const first = offset >> 3;
  const span = ((offset + width - 1) >> 3) - first + 1;
  const byte = (k: number) => `buf[${at} + ${first + k}]`;
  // The bits from `first` on, big (msb) or little (lsb) endian.
  const shift = order === "msb" ? 8 * span - (offset % 8) - width : offset % 8;
  if (span <= 4) {
    const bytes = Array.from({ length: span }, (_, k) =>
      order === "msb"
        ? `${byte(k)} << ${8 * (span - 1 - k)}`
        : `${byte(k)} << ${8 * k}`,
    );
    const value = `(${bytes.join(" | ")}) >>> ${shift}`;
    return width === 32 ? value : `(${value}) & ${2 ** width - 1}`;
  }
  // Five bytes: more bits than bitwise operators take.
  const bytes = Array.from({ length: span }, (_, k) =>
    order === "msb" ? byte(k) : byte(span - 1 - k),
  );
  const value = bytes.reduce((acc, b) => `(${acc}) * 256 + ${b}`);
  return `Math.floor((${value}) / ${2 ** shift}) % ${2 ** width}`;
}

/** The bytes the fixed-size fields from `i` on take (with where each ends, for errors). */
function run(
  entries: readonly Entry[],
  i: number,
): [number, [string, number][]] {
  const ends: [string, number][] = [];
  let end = 0;
  for (let j = i; j < entries.length; j++) {
    const entry = entries[j];
    if (entry.kind !== "field" || !Number.isFinite(entry.codec.size)) break;
    ends.push([entry.name, (end += entry.codec.size)]);
  }
  return [end, ends];
}

for (const [name, codec] of Object.entries(primitives)) {
  Object.defineProperty(Parser.prototype, name, {
    value(this: Parser, field: string) {
      return this.field(field, codec as AnyCodec);
    },
  });
}
