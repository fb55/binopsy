/* eslint-disable */
import {
  bin,
  bytes,
  literal,
  string,
  map,
  custom,
  match,
  array,
  sized,
  optional,
  when,
  lazy,
  u8,
  type Input,
  type Output,
  type Codec,
  type Bin,
  type Context,
} from "../../src/index.ts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function expect<T extends true>(): T | void {}
export const undef = map(u8, {
  decode: (n) => n,
  encode: (n: number | undefined) => n ?? 0,
});
export const required = bin().field("count", undef);
expect<Equal<Input<typeof required>, { count: number | undefined }>>();
// @ts-expect-error accepts undefined as a value, but does not supply a default
required.encode({});
required.encode({ count: undefined });
required.field(
  "body",
  bytes((o) => o.count ?? 0),
);
required.field(
  "body",
  // @ts-expect-error encoding callback can see undefined
  bytes((o) => o.count.toFixed().length),
);
// @ts-expect-error a name requires a numeric input in both directions
required.field("body", bytes("count"));
export const fixed = bin()
  .field("count", literal(u8, 2))
  .field(
    "body",
    bytes((o) => o.count),
  );
fixed.encode({ body: Uint8Array.of(1, 2) });
fixed.encode({ count: undefined, body: Uint8Array.of(1, 2) });
expect<
  Equal<Input<typeof fixed>, { count?: 2 | undefined; body: Uint8Array }>
>();
export const merged = bin()
  .merge(fixed)
  .field(
    "tail",
    bytes((o) => o.count),
  );
export const calculated = bin()
  .field("count", undef)
  .computed("count", () => 2);
export const calculatedMerge = bin()
  .merge(calculated)
  .field(
    "tail",
    bytes((o) => o.count),
  );
calculatedMerge.encode({ tail: Uint8Array.of(0, 0) });
export const calculatedBatch = bin()
  .u8("count")
  .u8("size")
  .computed({ count: () => 2, size: () => 3 });
bin()
  .merge(calculatedBatch)
  .field(
    "body",
    bytes((o) => o.count + o.size),
  );
export const defaultBranch = bin()
  .u8("tag")
  .field("count", match("tag").case(1, literal(u8, 2)).case(2, undef));
defaultBranch.encode({ tag: 1 });
defaultBranch.encode({ tag: 2, count: undefined });
// @ts-expect-error only the literal branch supplies a count
defaultBranch.encode({ tag: 2 });
defaultBranch.field(
  "body",
  bytes((o) => o.count ?? 0),
);
defaultBranch.field(
  "body",
  // @ts-expect-error nonliteral branch remains possibly undefined
  bytes((o) => o.count.toFixed().length),
);
export const adapter = custom({
  decode: () => ({ value: 1, bytesRead: 1 }),
  encode: (n: number | undefined) => Uint8Array.of(n ?? 0),
});
const customField = bin().field("count", adapter);
// @ts-expect-error custom accepting undefined does not default its logical input
customField.encode({});
bin()
  .field(
    "count",
    map(literal(u8, 2), { decode: (n) => n, encode: (n: 2 | undefined) => n }),
  )
  // @ts-expect-error cannot manufacture a default through map
  .encode({});
export const opaque: Codec<2, 2 | undefined> = literal(u8, 2);
// @ts-expect-error a broad Codec annotation intentionally forgets literal default metadata
bin().field("count", opaque).encode({});
export const mixedCodec = Math.random() ? literal(u8, 2) : u8;
// @ts-expect-error a dynamically selected ordinary codec cannot promise a default
bin().field("count", mixedCodec).encode({});
export const bothDefaults = Math.random() ? literal(u8, 1) : literal(u8, 2);
// @ts-expect-error different input alternatives cannot infer one safe union codec
bin().field("count", bothDefaults).encode({});
// Transparent region and lazy wrappers retain a known literal default.
export const bounded = bin().field("count", sized(1, literal(u8, 2)));
bounded.encode({});
export const late = bin().field(
  "count",
  lazy(() => literal(u8, 2)),
);
late.encode({});
bin()
  .field("count", optional(u8, literal(u8, 2)))
  // @ts-expect-error optional literal still needs explicit absence/presence
  .encode({});
bin()
  .u8("flag")
  .field("count", when("flag", literal(u8, 2)))
  // @ts-expect-error conditional literal still needs explicit absence/presence
  .encode({ flag: 0 });
export const genericCallback = <
  T extends { count: number },
  I extends { count: number },
>(
  p: Bin<T, I>,
) =>
  p.field(
    "data",
    array(
      bytes((o) => o.count),
      (o) => o.count,
    ),
  );
export const genericStored = <
  T extends { count: number },
  I extends { count: number },
>(
  p: Bin<T, I>,
) => p.field("data", stored);
const stored = array(bytes("count"), "count");
expect<
  Equal<
    Output<
      ReturnType<typeof genericStored<{ count: number }, { count: number }>>
    >,
    { count: number; data: Uint8Array[] }
  >
>();

export const maybeDefault = Math.random() ? literal(u8, 1 as number) : undef;
export const maybeDefaultField = bin().field("count", maybeDefault);
// @ts-expect-error same input type is not evidence that every branch defaults
maybeDefaultField.encode({});

// Every possible selector contributes requirements. A possible callback suppresses tag correlation.
const nameChoice = match(Math.random() ? "a" : "b").case(1, u8);
expect<
  Equal<
    Context<typeof nameChoice>,
    {
      a: string | number | bigint | boolean;
      b: string | number | bigint | boolean;
    }
  >
>();
// @ts-expect-error b is another possible selector
bin().u8("a").field("value", nameChoice);
export const choice = bin().u8("a").u8("b").field("value", nameChoice);
expect<
  Equal<
    Output<typeof choice>,
    { a: 1; b: number; value: number } | { a: number; b: 1; value: number }
  >
>();
const cbChoice = match(
  Math.random() ? (o: { a: number }) => o.a : (o: { b: number }) => o.b,
).case(1, u8);
expect<Equal<Context<typeof cbChoice>, { a: number } & { b: number }>>();
// @ts-expect-error both possible callbacks must be callable
bin().u8("a").field("value", cbChoice);
const mixedSelector = match(
  Math.random() ? "a" : (o: { b: number }) => o.b,
).case(1, u8);
// @ts-expect-error mixed selector keeps its callback requirement
bin().u8("a").field("value", mixedSelector);
export const mixedSelection = bin()
  .u8("a")
  .u8("b")
  .field("value", mixedSelector);
expect<
  Equal<Output<typeof mixedSelection>, { a: number; b: number; value: number }>
>();

bounded.field(
  "body",
  bytes((o) => o.count),
);
late.field(
  "body",
  bytes((o) => o.count),
);
// A wrapper does not invent a default for an undefined-accepting map.
// @ts-expect-error ordinary required input through a region
bin().field("count", sized(1, undef)).encode({});
bin()
  .field(
    "count",
    lazy(() => undef),
  )
  // @ts-expect-error ordinary required input through lazy
  .encode({});
const unionThroughRegion = sized(1, maybeDefault);
// @ts-expect-error a dynamic mixture does not guarantee a default
bin().field("count", unionThroughRegion).encode({});

string(Math.random() ? 4 : { terminator: 0, max: 4 });
array(u8, Math.random() ? 4 : { until: (n: number) => n === 0 });

const rawBuffer = new Uint8Array(new SharedArrayBuffer(2));
expect<Equal<ReturnType<typeof u8.encode>, Uint8Array<ArrayBuffer>>>();
bytes(2).decode(rawBuffer);
bytes(2).encodeInto(rawBuffer, rawBuffer);
const adapterBuffer = custom({
  decode: (b) => ({ value: b, bytesRead: b.length }),
  encode: (b) => b,
}).encode(rawBuffer);
expect<Equal<typeof adapterBuffer, Uint8Array<ArrayBuffer>>>();

// Check each options branch before forming a runtime union (current workaround).
const boundedOptions = {
  terminator: 0,
  max: 4,
} satisfies import("../../src/index.ts").TerminatedStringOptions;
string(Math.random() ? 4 : boundedOptions);
const invalidOptions = {
  terminator: 0,
  // @ts-expect-error the explicit shape check catches the typo before a union can erase it
  maxx: 4,
} satisfies import("../../src/index.ts").TerminatedStringOptions;
void invalidOptions;
