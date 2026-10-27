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
type Numeric<K> = K extends number
  ? K
  : K extends `${infer N extends number}`
    ? `${N}` extends K
      ? N
      : never
    : never;
type Named<T> = {
  [K in Keys<T>]: [Numeric<K>] extends [never] ? K : never;
}[Keys<T>];
type Known<T> = T extends readonly Name[]
  ? T[number]
  : T[[Named<T>] extends [never] ? Keys<T> : Named<T>];
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
type Covers<C, V, S = ScalarValue<V>> = number extends S
  ? false
  : Exclude<Domain<C>, S> extends never
    ? true
    : false;
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
 * Names or members for values of `codec`. Arrays name their indexes, numeric
 * records name their keys, and named records (including enums) keep their values.
 * Incomplete or unprovable coverage needs an explicit unknown-value policy.
 *
 * @param codec The codec of the raw value.
 * @param values The names or members, snapshotted at definition time.
 * @param policy Reject, keep, or replace unknown raw values.
 * @returns A codec of the names or members, preserving its inner context.
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

/** Names or members for raw values; unknown values need an explicit policy unless coverage is complete. */
export const enumOf = /* @__PURE__ */ Object.assign(defineEnum, {
  /** Fail decoding unknown raw values. */
  reject,
  /** Keep unknown raw values; encoding still runs the inner codec's checks. */
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
 * The values of an integer codec, where its type says them.
 *
 * @param inner The codec of raw values.
 * @returns Its name and the least and greatest values, or nothing.
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
