import {
  array,
  bin,
  bytes,
  literal,
  string,
  sized,
  when,
  match,
  map,
  u8,
  type Bin,
  type Codec,
  type Context,
  type Input,
  type Output,
  type Length,
} from "../../src/index.ts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function expect<T extends true>(): T | void {}
const stored = bytes("count");
expect<Equal<Context<typeof stored>, { count: number }>>();
// @ts-expect-error stored name requirement is numeric
bin().field("count", string(1)).field("data", stored);
declare const U: Bin<{ count: number } | { other: number }>;
// @ts-expect-error common keys only
U.field("data", bytes("count"));
// @ts-expect-error name typo is rejected at its literal
bin().u8("count").field("data", bytes("cuont"));
bin()
  .field("count", string(1))
  // @ts-expect-error nested name requirement remains numeric
  .field("data", array(bytes("count"), 1));
export const nested = bin()
  .u8("size")
  .u8("count")
  .field(
    "items",
    array(
      bytes((o) => o.size),
      "count",
    ),
  );
bin()
  .u8("tag")
  .u8("count")
  // @ts-expect-error case name requirements are checked on attachment
  .field("body", match("tag").case(1, bytes("cuont")));
export const maxName = bin()
  .u8("limit")
  .field("s", string({ terminator: 0, max: "limit" }));
export const maxCallback = bin()
  .u8("limit")
  .field("s", string({ terminator: 0, max: (o) => o.limit }));
export const combined = when(
  (o: { flag: boolean }) => o.flag,
  bytes((o: { size: number }) => o.size),
);
expect<Equal<Context<typeof combined>, { flag: boolean } & { size: number }>>();
export const namedWhen = when("flag", bytes("size"));
expect<
  Equal<Context<typeof namedWhen>, { size: number } & { flag: unknown }>
>();
bin().u8("size").u8("flag").field("v", namedWhen);
bin()
  .u8("size")
  .field(
    "v",
    when(
      // @ts-expect-error missing condition name
      "flag",
      bytes((o) => o.size),
    ),
  );
export const arrayRequirements = array(bytes("width"), "count");
expect<
  Equal<
    Context<typeof arrayRequirements>,
    { width: number } & { count: number }
  >
>();
export const sizeRequirements = sized("limit", bytes("width"));
expect<
  Equal<Context<typeof sizeRequirements>, { width: number } & { limit: number }>
>();
export const unionNames = bytes(Math.random() ? "a" : "b");
expect<Equal<Context<typeof unionNames>, { a: number; b: number }>>();
// @ts-expect-error every possible name is required
bin().u8("a").field("b", string(1)).field("v", unionNames);
export const unionForms = bytes(Math.random() ? 1 : "a");
expect<Equal<Context<typeof unionForms>, { a: number }>>();
export const unionCallbacks = bytes(
  Math.random() ? (o: { a: number }) => o.a : (o: { b: number }) => o.b,
);
expect<Equal<Context<typeof unionCallbacks>, { a: number } & { b: number }>>();
const maybeOptions = Math.random()
  ? 4
  : { terminator: 0, max: "limit" as const };
export const unionOptions = string(maybeOptions);
expect<Equal<Context<typeof unionOptions>, { limit: number }>>();
// @ts-expect-error a union of string forms retains its bound requirement
unionOptions.decode(new Uint8Array());
// @ts-expect-error options form does not take a second options object
string({ terminator: 0 }, { padRight: 0 });
// @ts-expect-error a max is a cap, not a prefix codec
string({ terminator: 0, max: u8 });
export const generic = <
  T extends { count: number },
  I extends { count: number },
>(
  p: Bin<T, I>,
) =>
  p.field(
    "values",
    array(
      bytes((o) => o.count),
      (o) => o.count,
    ),
  );
export const composed = bin().u8("count").pipe(generic);
export const genericLength = <T>(n: Length<T>) => sized(n, array(bytes(n), n));
export const annotated = bytes((o: { count?: number }) => o.count ?? 0);
expect<Equal<Context<typeof annotated>, { count?: number }>>();
// @ts-expect-error optional context is still a declared dependency
annotated.decode(new Uint8Array());
export const byteAligned = bin().bits("a", 3).bits("b", 32).u8("n");
// @ts-expect-error one bit-field spelling only
bin().u3("a");
export const mapped = map(u8, {
  decode: (n) => new Date(n),
  encode: (s: string) => Number(s),
});
bin()
  .field("time", mapped)
  .field(
    "v",
    array(
      // @ts-expect-error callbacks see the encode input representation too
      bytes((o) => o.time.getTime()),
      1,
    ),
  );
export const closedString = string({ terminator: 0 });
expect<Equal<Context<typeof closedString>, unknown>>();
expect<
  Equal<
    Input<typeof nested>,
    { size: number; count: number; items: readonly Uint8Array[] }
  >
>();
expect<
  Equal<
    Output<typeof nested>,
    { size: number; count: number; items: Uint8Array[] }
  >
>();
declare const compatible: Codec<number>;
export const prefixed = array(u8, compatible);
declare const differentCounts: Bin<{ count: number } | { count: string }>;
// @ts-expect-error length must be numeric in every variant
differentCounts.field("v", bytes("count"));
export const nestedLiteral = bin()
  .u8("size")
  .field(
    "magic",
    literal(
      string((o) => o.size),
      "MAGIC",
    ),
  );
// @ts-expect-error terminated max typo must not silently remove the cap
string({ terminator: 0, maxx: 4 });
// @ts-expect-error padRight belongs only to the fixed-region options
string({ terminator: 0, padRight: 0 });
// @ts-expect-error arrays do not have a combined length/until options form
array(u8, { until: (n) => n === 0, length: 4 });
