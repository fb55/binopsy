/** Named wire values, with an explicit policy for unknown values. */
import { Bits } from "./bits.ts";
import type {
  AnyCodec,
  Codec,
  Context,
  Input,
  Output,
  Packing,
} from "./codec.ts";
import type { Gen } from "./compile.ts";
import type { Domain } from "./domain.ts";
import type { IsUnion, ScalarValue, Value } from "./match.ts";
import { Primitive } from "./primitives.ts";
import { Wrapper } from "./wrapper.ts";

type Name = string | boolean;
type Table = readonly Name[] | Readonly<Record<string | number, Value>>;
type Keys<T> = Extract<keyof T, string | number>;
/** Keys that spell numbers (`"1"`, not `"01"`), as numbers. */
type Numeric<K> = K extends number
  ? K
  : K extends `${infer N extends number}`
    ? `${N}` extends K
      ? N
      : never
    : never;
/** The member names of an enum or const object (`never` for a table of names by number). */
type Named<T> = {
  [K in Keys<T>]: [Numeric<K>] extends [never] ? K : never;
}[Keys<T>];
/** The decoded values: names, or members. */
type Known<T> = T extends readonly Name[]
  ? T[number]
  : T[[Named<T>] extends [never] ? Keys<T> : Named<T>];
/** The raw values: indexes, numeric keys, or members. */
type Wire<T> = T extends readonly Name[]
  ? number
  : [Named<T>] extends [never]
    ? Known<T> extends Name
      ? number
      : never
    : T[Named<T>];
type RawKind<T> = [T] extends [number]
  ? number
  : [T] extends [string]
    ? string
    : [T] extends [bigint]
      ? bigint
      : never;
/** `unknown` if table `T` fits codec `C` (raw values of its type, of a codec that encodes what it decodes or only decodes), else `never`. */
type Checked<C, T> = [Known<T>] extends [never]
  ? never
  : [Wire<T>] extends [never]
    ? never
    : [Wire<T>] extends [RawKind<Output<C>>]
      ? [Input<C>] extends [never]
        ? unknown
        : [Output<C>] extends [Input<C>]
          ? unknown
          : never
      : never;
// A union-valued member might name only one of its possible raw values.
type Members<T> = {
  [K in Named<T>]: IsUnion<T[K]> extends true ? never : ScalarValue<T[K]>;
}[Named<T>];
/** Whether raw values `V` are all the values of `C` (only provable for its `Domain`). */
type Covers<C, V, S = ScalarValue<V>> = number extends S
  ? false
  : Exclude<Domain<C>, S> extends never
    ? true
    : false;
/** Whether table `T` provably names every raw value of `C` (so the policy may be omitted). */
type Covered<C, T> = T extends readonly Name[]
  ? number extends T["length"]
    ? false
    : Covers<C, Numeric<Exclude<keyof T, keyof (readonly unknown[])>>>
  : string extends keyof T
    ? false
    : number extends ScalarValue<keyof T>
      ? false
      : Covers<C, [Named<T>] extends [never] ? Numeric<Keys<T>> : Members<T>>;
const reject = /* @__PURE__ */ Symbol("enumOf.reject");
const keep = /* @__PURE__ */ Symbol("enumOf.keep");
type Reject = typeof reject;
type Keep = typeof keep;
type Policy<V> = Reject | Keep | V;
type Decoded<C, T, P> = P extends Keep
  ? Known<T> | NonNullable<Output<C>>
  : Known<T>;

/**
 * Names for the raw values of `codec`, or members of a TypeScript enum or
 * const object (see `enumOf`).
 *
 * @param codec The codec of the raw values, e.g. `u8` or `bits(2)`.
 * @param values The names by raw value (an array or an object), or an enum
 *   or const object. It is read when the codec is defined.
 * @param policy For unknown raw values: `enumOf.reject`, `enumOf.keep`, or a
 *   name or member of `values` to decode them as.
 * @returns A codec of the names or members.
 */
function defineEnum<
  C extends AnyCodec,
  const T extends Table,
  const P extends Policy<NoInfer<Known<T>>> = Reject,
>(
  codec: C,
  values: T & Checked<NoInfer<C>, NoInfer<T>>,
  ...policy: Covered<C, T> extends true ? [policy?: P] : [policy: P]
): Codec<
  Decoded<C, T, P>,
  [Input<C>] extends [never] ? never : Decoded<C, T, P>,
  Context<C>,
  Packing<C>
> {
  return new Enum(codec, values, policy[0]) as never;
}

/**
 * Names for the raw values of `codec`, or members of a TypeScript enum or
 * const object. The table is one of:
 *
 * - an array of string or boolean names, by raw value: `["low", "high"]`;
 * - an object of names by raw value: `{ 1: "data", 2: "ack", 0x3f: "error" }`;
 * - an enum or const object, whose members are both the raw and the decoded
 *   values (numbers, strings or bigints).
 *
 * For unknown raw values, `policy` is `enumOf.reject` (decoding fails, also
 * under `pick`), `enumOf.keep` (they decode and encode as they are), or a
 * name or member, which they decode as (lossy: it encodes to its own raw
 * value). The policy may be omitted only if the table names every raw value;
 * TypeScript proves this for `bits(1)` to `bits(5)`. Encoding a value not in
 * the table throws an `EncodeError`. An `enumOf` of a bit field is a bit
 * field. See the README section on enums.
 *
 * @param codec The codec of the raw values, e.g. `u8` or `bits(2)`.
 * @param values The table. It is read when the codec is defined: later
 *   changes to it have no effect.
 * @param policy For unknown raw values: `enumOf.reject`, `enumOf.keep`, or a
 *   name or member of the table to decode them as.
 * @returns A codec of the names or members.
 * @throws {TypeError} If the table is invalid (e.g. empty, or with
 *   duplicate names), the fallback is not in it, or a policy is needed (when
 *   defined).
 * @throws {RangeError} If a raw value does not fit an integer codec (when
 *   defined).
 * @example
 * enumOf(bits(2), ["low", "normal", "high", "reserved"]); // Every value named
 * enumOf(u8, { 1: "data", 2: "ack" }, enumOf.reject); // "data" | "ack"
 * enumOf(u8, { 1: "data", 2: "ack" }, enumOf.keep); // "data" | "ack" | number
 * enum Kind {
 *   Unknown = 0,
 *   Data = 1,
 * }
 * enumOf(u8, Kind, Kind.Unknown); // Other bytes decode as Kind.Unknown
 */
export const enumOf = /* @__PURE__ */ Object.assign(defineEnum, {
  /**
   * The policy of `enumOf` that rejects unknown raw values: decoding fails
   * with a `DecodeError` of code `"invalid"`.
   */
  reject,
  /**
   * The policy of `enumOf` that keeps unknown raw values: they decode as
   * they are, and encode as they are (with the inner codec's checks).
   */
  keep,
} as const);

/**
 * A value as written in code: strings quoted.
 *
 * @param value The value.
 * @returns Its spelling.
 */
function display(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * Whether a property name is how a number is written.
 *
 * @param key The property name.
 * @returns Whether `Number(key)` spells it.
 */
function numeric(key: string): boolean {
  return String(Number(key)) === key;
}

/**
 * The raw values and decoded values of a table (taken when the codec is
 * defined), each way.
 *
 * @param table An array, an object of numbers, or an enum.
 * @returns Maps from raw to decoded values and back.
 */
function normalize(table: Table): [Map<Value, Value>, Map<Value, Value>] {
  const forward = new Map<Value, Value>();
  const inverse = new Map<Value, Value>();
  const array = Array.isArray(table);
  const entries: (readonly [string, Value])[] = array
    ? Array.from({ length: table.length }, (_, i) => {
        if (!(i in table)) {
          throw new TypeError(`enumOf: array hole at ${i}; use an object`);
        }
        return [String(i), (table as readonly Name[])[i]] as const;
      })
    : Object.entries(table);
  const named = !array && entries.some(([key]) => !numeric(key));
  for (const [key, value] of entries) {
    // Only verified reverse entries of numeric TypeScript enums are ignored.
    if (named && numeric(key)) {
      if ((table as Record<string, unknown>)[value as string] !== Number(key)) {
        throw new TypeError(`enumOf: ${key} is not the value of a member`);
      }
      continue;
    }
    if (
      named
        ? !["number", "string", "bigint"].includes(typeof value)
        : typeof value !== "string" && typeof value !== "boolean"
    ) {
      throw new TypeError(
        named
          ? "enumOf: members must be numbers, strings or bigints"
          : "enumOf: names must be strings or booleans",
      );
    }
    const raw = named ? value : Number(key);
    if (!named && inverse.has(value)) {
      throw new TypeError(
        `enumOf: duplicate name ${display(value)} for raw values ${display(inverse.get(value))} and ${display(raw)}`,
      );
    }
    forward.set(raw, value);
    inverse.set(value, raw);
  }
  if (forward.size === 0) throw new TypeError("enumOf: no values");
  return [forward, inverse];
}

/**
 * The values an integer codec holds, for bounds and coverage checks.
 *
 * @param inner The codec of raw values.
 * @returns Its name and least and greatest values (`undefined` for codecs
 *   other than `bits(n)` and `u8` to `i32be`).
 */
function range(inner: AnyCodec): [string, number, number] | undefined {
  if (inner instanceof Bits) {
    return [`bits(${inner.width})`, 0, 2 ** inner.width - 1];
  }
  if (!(inner instanceof Primitive)) return undefined;
  const { sign, width } =
    /^(?<sign>[iu])(?<width>8|16|24|32)/u.exec(inner.name)?.groups ?? {};
  if (width === undefined) return undefined;
  const count = 2 ** Number(width);
  return sign === "u"
    ? [inner.name, 0, count - 1]
    : [inner.name, -count / 2, count / 2 - 1];
}

class Enum extends Wrapper {
  private readonly forward: readonly Value[] | ReadonlyMap<Value, Value>;
  private readonly inverse: ReadonlyMap<Value, Value>;
  private readonly policy: Policy<Value>;
  private readonly rawType: string;

  constructor(inner: AnyCodec, table: Table, policy?: Policy<Value>) {
    const [forward, inverse] = normalize(table);
    const bounds = range(inner);
    if (bounds) {
      const [name, min, max] = bounds;
      for (const raw of forward.keys()) {
        if (
          !(
            Number.isInteger(raw) &&
            (raw as number) >= min &&
            (raw as number) <= max
          )
        ) {
          throw new RangeError(
            `enumOf: raw value ${display(raw)} is outside ${name}, which holds ${min}..${max}`,
          );
        }
      }
    }
    let reason = "the codec has values without names";
    // Coverage is checked for domains of up to 8 bits.
    if (bounds && bounds[2] - bounds[1] <= 255) {
      reason = "";
      for (let raw = bounds[1]; raw <= bounds[2]; raw++) {
        if (!forward.has(raw)) {
          reason = `${bounds[0]} value ${raw} has no name`;
          break;
        }
      }
    }
    if (policy === undefined && reason) {
      throw new TypeError(
        `enumOf: a policy is needed: ${reason} (enumOf.reject, enumOf.keep or a fallback value)`,
      );
    }
    if (
      policy !== undefined &&
      policy !== reject &&
      policy !== keep &&
      !inverse.has(policy)
    ) {
      throw new TypeError(
        `enumOf: fallback ${display(policy)} is not one of the values`,
      );
    }
    super(inner, policy === undefined || policy === reject);
    this.policy = policy ?? reject;
    this.inverse = inverse;
    this.rawType = typeof forward.keys().next().value;
    // Raw values 0 to n - 1 are looked up in an array (without a prototype,
    // so no raw value finds an inherited property), others in the map.
    const values = Array.from({ length: forward.size }, (_, i) =>
      forward.get(i),
    );
    this.forward = values.every((value) => value !== undefined)
      ? (Object.setPrototypeOf(values, null) as Value[])
      : forward;
  }

  protected readValue(
    g: Gen,
    raw: string,
    at: string,
    wanted: boolean,
  ): string {
    if (!wanted && this.policy !== reject) return "";
    const table = g.k(this.forward);
    const value = g.let(
      Array.isArray(this.forward) ? `${table}[${raw}]` : `${table}.get(${raw})`,
    );
    if (this.policy === reject) {
      g.check(
        `${value} === undefined`,
        "invalid",
        `"unknown value " + String(${raw})`,
        at,
      );
      return wanted ? value : "";
    }
    return wanted
      ? g.let(
          `${value} === undefined ? ${this.policy === keep ? raw : g.k(this.policy)} : ${value}`,
        )
      : "";
  }

  protected writeValue(g: Gen, value: string): string {
    const raw = g.let(`${g.k(this.inverse)}.get(${value})`, "let");
    if (this.policy === keep) {
      g.line(
        `if (${raw} === undefined && typeof ${value} === ${JSON.stringify(this.rawType)}) ${raw} = ${value};`,
      );
    }
    g.check(
      `${raw} === undefined`,
      "invalid",
      `"unknown value " + String(${value})`,
    );
    return raw;
  }
}
