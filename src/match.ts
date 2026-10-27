/** Matches: codecs picked by a tag, an earlier field or a value computed from them. */
import { Parser, objectOf, type Piece, type structured } from "./bin.ts";
import {
  Codec,
  fillIn,
  writeValue,
  type AnyCase,
  type AnyCodec,
  type Context,
  type Input,
  type Obj,
  type Output,
} from "./codec.ts";
import type { KeysOf, Needs } from "./codecs.ts";
import { ALL_FIELDS, type Gen } from "./compile.ts";

/** Types only: the key of a match's cases. */
export declare const matchTypes: unique symbol;

/** Values tags have. */
export type Value = string | number | bigint | boolean;

type IsAny<T> = 0 extends 1 & T ? true : false;
export type IsUnion<T, All = T> = T extends unknown
  ? [All] extends [T]
    ? false
    : true
  : never;
/** Why `V` is not a case value (else `never`): `Used` have cases, and the tag only has values `Allowed`. */
type CaseError<V, Used, Allowed> =
  IsAny<V> extends true
    ? "a case value must be a literal"
    : true extends IsUnion<V>
      ? "a case value must be one literal"
      : string extends V
        ? "a case value must be a literal"
        : number extends V
          ? "a case value must be a literal"
          : bigint extends V
            ? "a case value must be a literal"
            : [Extract<V, Used>] extends [never]
              ? [V] extends [Allowed]
                ? never
                : `${V & Value} is not a value of the tag`
              : `${V & Value} already has a case`;
type CaseArg<V, Used, Allowed> = [CaseError<V, Used, Allowed>] extends [never]
  ? V
  : { readonly [Reason in CaseError<V, Used, Allowed>]: never };

/** The codecs of cases `Cs` (pairs of a value and its codec). */
export type CaseCodec<Cs> = Cs extends readonly [unknown, infer C] ? C : never;
export type CaseValues<Cs> = Cs extends readonly [infer V, unknown] ? V : never;

/**
 * A codec picking one of its cases by the earlier field `Tag` (or by a
 * computed value, if `Tag` is `never`); `D` is the codec of other values.
 */
export interface Matched<Tag extends string, Cs, D, Ctx> extends Codec<
  Output<CaseCodec<Cs>> | Output<D>,
  Input<CaseCodec<Cs>> | Input<D>,
  Ctx
> {
  /** Types only: whether every case is a parser (so the match can be merged). */
  readonly [structured]: [
    Exclude<CaseCodec<Cs> | D, { readonly [structured]: true }>,
  ] extends [never]
    ? true
    : false;
  /** Types only: the tag and cases. */
  readonly [matchTypes]: { tag: Tag; cases: Cs; otherwise: D; context: Ctx };
}

/** A match that takes more cases. */
export interface Matching<Tag extends string, Cs, Ctx, Allowed> extends Matched<
  Tag,
  Cs,
  never,
  Ctx
> {
  /**
   * Uses `codec` when the tag is `value`, a literal (a number, string,
   * bigint or boolean) that has no case yet. (Functions in `codec` do not
   * know the fields of the parser the match will be in: annotate them.)
   */
  case<const V extends Value, C extends AnyCase>(
    value: CaseArg<V, CaseValues<Cs>, Allowed>,
    codec: C,
  ): Matching<Tag, Cs | readonly [V, C], Ctx & Context<C>, Allowed>;
  /** Uses `codec` for the other values (without it, they fail to decode and encode). */
  otherwise<C extends AnyCase>(codec: C): Matched<Tag, Cs, C, Ctx & Context<C>>;
}

type Selector<Ctx> =
  | ([Ctx] extends [never] ? string : KeysOf<Ctx, Value>)
  | ((fields: Ctx) => Value);

/**
 * A codec picking one of its cases (added with `.case(value, codec)`) by
 * the earlier field `tag`, or by a value computed from the earlier fields.
 * In a parser, a tag field narrows its objects to a union with a variant
 * for each case (`.field(name, match)` for a value of its own, or
 * `.merge(match)` for cases that are parsers, whose fields are added).
 * Functions of the earlier fields need their argument annotated.
 *
 * @param tag The name of an earlier field, or a function of the fields.
 * @returns A match without cases yet.
 */
export function match<
  Ctx = never,
  const S extends Selector<Ctx> = Selector<Ctx>,
>(
  tag: S,
): Matching<
  [S] extends [string] ? Extract<S, string> : never,
  never,
  Needs<S, Ctx, Value>,
  S extends (fields: never) => infer R ? R : Value
> {
  if (typeof tag !== "function" && typeof tag !== "string") {
    throw new TypeError(`invalid tag ${String(tag)}`);
  }
  return new Match(tag as never, [], undefined) as never;
}

const scalars = new Set(["string", "number", "bigint", "boolean"]);

/**
 * The JavaScript of `value`, as a `case` label.
 *
 * @param value The tag value of a case.
 * @returns A literal of the value.
 */
function label(value: Value): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  return Object.is(value, -0) ? "0" : String(value);
}

/** One of several codecs, picked by a tag (or `otherwise`, for other tag values). @internal */
export class Match extends Codec {
  override readonly merged: this | undefined;
  readonly tag: string | ((fields: Obj) => Value);
  readonly cases: readonly (readonly [Value, AnyCodec])[];
  readonly default: AnyCodec | undefined;

  constructor(
    tag: string | ((fields: Obj) => Value),
    cases: readonly (readonly [Value, AnyCodec])[],
    otherwise: AnyCodec | undefined,
  ) {
    const codecs = cases.map(([, codec]) => codec);
    if (otherwise) codecs.push(otherwise);
    const sizes = new Set(codecs.map((codec) => codec.size));
    super(sizes.size === 1 ? codecs[0].size : Number.NaN, true, [
      typeof tag === "string" ? tag : ALL_FIELDS,
      ...codecs.flatMap((codec) => codec.reads),
    ]);
    this.tag = tag;
    this.cases = cases;
    this.default = otherwise;
    this.merged = codecs.every((codec) => codec instanceof Parser)
      ? this
      : undefined;
  }

  names(definite = false): string[] {
    const all = structsOf(this).map((s) => s.names(definite));
    return [...new Set(all.flat())].filter(
      (name) => !definite || all.every((fields) => fields.includes(name)),
    );
  }

  decodeGroup(
    g: Gen,
    wanted: ReadonlySet<string>,
    later: ReadonlySet<string>,
  ): Piece[] {
    return [
      emitCases(g, this, (struct) => struct.decodeFields(g, wanted, later)),
    ];
  }

  encodeFields(
    g: Gen,
    object: string,
    supplied: ReadonlyMap<string, string>,
  ): void {
    emitCases(g, this, (struct) => {
      struct.encodeFields(g, object, supplied);
      return [];
    });
  }

  override fills(): boolean {
    return [...this.cases.map(([, codec]) => codec), this.default].some(
      (codec) =>
        codec !== undefined && (codec.preset !== undefined || codec.fills()),
    );
  }

  override emitFill(g: Gen, value: string): void {
    if (!this.fills()) return;
    g.block(`if (${value} === undefined)`, () =>
      this.emitSwitch(g, (codec) => fillIn(g, codec, value)),
    );
  }

  case(value: Value, codec: AnyCodec): Match {
    if (this.default) throw new Error("no cases can follow `otherwise`");
    if (!scalars.has(typeof value) || Number.isNaN(value)) {
      throw new TypeError(`invalid case value ${String(value)}`);
    }
    if (this.cases.some(([v]) => v === value)) {
      throw new Error(`${String(value)} already has a case`);
    }
    if (!(codec instanceof Codec)) {
      throw new TypeError(`the case for ${String(value)} is not a codec`);
    }
    return new Match(this.tag, [...this.cases, [value, codec]], undefined);
  }

  otherwise(codec: AnyCodec): Match {
    if (this.default) throw new Error("a match has one `otherwise`");
    if (!(codec instanceof Codec)) {
      throw new TypeError("`otherwise` is not a codec");
    }
    return new Match(this.tag, this.cases, codec);
  }

  emitRead(g: Gen, wanted: boolean): string {
    const v = wanted ? g.let("undefined", "let") : "";
    this.emitSwitch(g, (codec) => {
      const x = codec.emitRead(g, wanted);
      if (wanted) g.line(`${v} = ${x};`);
    });
    return v;
  }

  emitWrite(g: Gen, value: string): void {
    this.emitSwitch(g, (codec) => {
      if (codec.preset) fillIn(g, codec, value);
      writeValue(g, codec, value);
    });
  }

  /**
   * Emits a `switch` on the tag, with `body` for each case (the index of
   * `otherwise` is that after the cases).
   *
   * @param g The generator of the function.
   * @param body Emits the code of a case, given its codec and index.
   */
  emitSwitch(g: Gen, body: (codec: AnyCodec, i: number) => void): void {
    const tag =
      typeof this.tag === "string"
        ? g.ref(this.tag)
        : g.callback(this.tag, g.context());
    if (typeof this.tag === "function") {
      g.check(
        `!${g.k(scalars)}.has(typeof ${tag})`,
        "invalid",
        `"the selector returned a nonscalar tag of type " + typeof ${tag}`,
      );
    }
    g.flush();
    g.line(`switch (${tag}) {`);
    for (const [i, [value, codec]] of this.cases.entries()) {
      g.block(`case ${label(value)}:`, () => body(codec, i), "break; }");
    }
    if (this.default) {
      g.block("default:", () => body(this.default!, this.cases.length));
    } else {
      g.line("default:");
      g.fail("no-match", `"no case for " + String(${tag})`);
    }
    g.line("}");
  }
}

/**
 * The parsers of the cases of a matched.
 *
 * @param matched A matched of parsers.
 * @returns The parsers of the cases in order, then the default (if any).
 */
function structsOf(matched: Match): Parser[] {
  const all = matched.cases.map(([, codec]) => codec);
  if (matched.default) all.push(matched.default);
  return all as unknown as Parser[];
}

/**
 * Emits a matched's field scopes, sharing the locals its cases define.
 *
 * @param g The generator of the function.
 * @param matched A matched of parsers.
 * @param emit Emits the code of a case's parser; returns its parts.
 * @returns The piece of the cases (whose parts are only kept when decoding).
 */
function emitCases(
  g: Gen,
  matched: Match,
  emit: (struct: Parser) => Piece[],
): Piece {
  g.field = undefined;
  const structs = structsOf(matched);
  const shared = new Map<string, string>();
  for (const struct of structs) {
    for (const name of struct.names()) {
      if (!shared.has(name)) shared.set(name, g.hoist());
    }
  }
  const branch = g.hoist();
  const outer = g.fields;
  const parts: Piece[][] = [];
  // The cases setting each field, and when it is present in them.
  const sets = new Map<string, [i: number, when: string | undefined][]>();
  matched.emitSwitch(g, (_codec, i) => {
    g.fields = new Map(outer);
    const own = emit(structs[i]);
    for (const [name, v] of g.fields) {
      if (shared.has(name) && outer.get(name) !== v) {
        g.line(`${shared.get(name)} = ${v};`);
        sets.set(name, [...(sets.get(name) ?? []), [i, g.present.get(v)]]);
      }
    }
    g.line(`${branch} = ${i};`);
    if (!g.encoding) {
      parts[i] = own.map((part) =>
        "name" in part ? { name: part.name, v: shared.get(part.name)! } : part,
      );
    }
  });
  g.fields = new Map(outer);
  for (const [name, v] of shared) {
    g.fields.set(name, v);
    // Fields set by every case (whatever their nested matches) are present.
    const setters = sets.get(name) ?? [];
    if (
      setters.length === structs.length &&
      setters.every(([, when]) => when === undefined)
    ) {
      continue;
    }
    let when = setters
      .map(([i, inner]) =>
        inner === undefined
          ? `${branch} === ${i}`
          : `(${branch} === ${i} && (${inner}))`,
      )
      .join(" || ");
    // In other cases, a field around the parser of the same name is seen.
    const around = outer.get(name);
    if (around !== undefined) {
      g.line(`if (!(${when || "false"})) ${v} = ${around};`);
      const inherited = g.present.get(around);
      if (inherited === undefined) continue;
      when = when ? `${when} || (${inherited})` : inherited;
    }
    g.present.set(v, when || "false");
  }
  return new Cases(branch, parts);
}

/** Deferred construction of an object containing merged cases. */
class Cases {
  readonly count: number;
  readonly branch: string;
  readonly cases: readonly (readonly Piece[])[];
  constructor(branch: string, cases: readonly (readonly Piece[])[]) {
    this.branch = branch;
    this.cases = cases;
    this.count = cases.length;
  }
  /**
   * Builds an object: complete literals for few combinations (faster for small
   * objects), or assignments to avoid copying objects and linear case lookup.
   *
   * @param g The generator of the function.
   * @param parts The fields, and the cases of matches, in order.
   * @param into An existing object to add the fields to.
   * @returns An object expression, or the variable holding the object.
   */
  object(g: Gen, parts: readonly Piece[], into?: string): string {
    const combinations = parts.reduce(
      (n, part) => ("name" in part ? n : n * part.count),
      1,
    );
    if (into !== undefined || combinations > 16) {
      const object = into ?? g.let("{}");
      for (const part of parts) {
        if (part instanceof Cases) {
          g.line(`switch (${part.branch}) {`);
          for (const [j, fields] of part.cases.entries()) {
            g.line(`case ${j}:`);
            objectOf(g, fields, object);
            g.line("break;");
          }
          g.line("}");
        } else {
          objectOf(g, [part], object);
        }
      }
      return object;
    }
    const i = parts.indexOf(this);
    const matched = parts[i] as Cases;
    return choice(matched, (j) =>
      objectOf(g, [
        ...parts.slice(0, i),
        ...matched.cases[j],
        ...parts.slice(i + 1),
      ]),
    );
  }
}

/**
 * An expression that is `of(j)` if the matched is in its case `j`.
 *
 * @param matched The cases, and the variable of the index of the one decoded.
 * @param of The expression for a case, given its index.
 * @returns A chain of conditional expressions (or `of(0)`, for one case).
 */
function choice(matched: Cases, of: (j: number) => string): string {
  const last = matched.cases.length - 1;
  return matched.cases
    .map((_, j) =>
      j < last ? `${matched.branch} === ${j} ? ${of(j)} : ` : of(j),
    )
    .join("");
}
