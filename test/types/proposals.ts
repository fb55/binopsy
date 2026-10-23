import {
  bin,
  bytes,
  array,
  optional,
  literal,
  map,
  sized,
  string,
  u8,
  when,
  match,
  refine,
  type Bin,
  type Context,
  type Input,
  type Output,
} from "../../src/index.ts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function expect<T extends true>(): T | void {}
export const stored = bytes("count");
// @ts-expect-error stored dependency is number
bin().field("count", string(1)).field("data", stored);
declare const U: Bin<{ count: number } | { other: number }>;
// @ts-expect-error not available in every branch
U.field("data", bytes("count"));
export const optionalContext = bytes((o: { count?: number }) => o.count ?? 0);
// @ts-expect-error callbacks still need an object even if its properties are optional
optionalContext.decode(new Uint8Array());
export const composed = when("present", bytes("count"));
expect<
  Equal<
    Context<typeof composed>,
    Record<"count", number> & Record<"present", unknown>
  >
>();
export const annotated = array(
  bytes("size"),
  (o: { count: number }) => o.count,
);
export const callbackWhen = when(
  (o: { present: boolean }) => o.present,
  bytes("count"),
);
export const sizedCallback = sized(
  (o: { size: number }) => o.size,
  bytes("count"),
);
export const readonlyArray = array(u8, 2);
readonlyArray.encode([1, 2] as const);
export const scalarShape = { "~types": {} };
// @ts-expect-error fake codec
array(scalarShape, 2);
export const nested = bin()
  .u8("size")
  .u8("count")
  .field(
    "items",
    array(
      optional(
        u8,
        bytes((o) => o.size),
      ),
      "count",
    ),
  );
expect<
  Equal<
    Output<typeof nested>,
    { size: number; count: number; items: (Uint8Array | null)[] }
  >
>();
export const decodeOnly = map(u8, { decode: (n) => n });
export const literalDecoder = literal(decodeOnly, 1);
// @ts-expect-error literal must not resurrect encoder
literalDecoder.encode(1);
export const wrongLiteral = literal(
  map(u8, { decode: (n) => String(n), encode: (n: number) => n }),
  "x",
);
// @ts-expect-error decoded literal cannot be fed to unrelated input
wrongLiteral.encode("x");
export const optLit = bin().field("v", optional(u8, literal(u8, 1)));
// @ts-expect-error explicit presence needed
optLit.encode({});
export const saneLiteral = literal(u8, 1);
saneLiteral.encode(undefined);
export const reused = match("tag").case(1, array(bytes("count"), 2));
bin().u8("tag").u8("count").field("body", reused);
export const narrow = refine(u8, (n): n is 1 | 2 => n === 1 || n === 2);
expect<Equal<Output<typeof narrow>, 1 | 2>>();
expect<Equal<Input<typeof narrow>, 1 | 2>>();
export const converted = map(u8, {
  decode: (n) => new Date(n),
  encode: (s: string) => Number(s),
});
bin()
  .field("time", converted)
  .field(
    "data",
    // @ts-expect-error callback also runs on input, where time is a string
    bytes((o) => o.time.getTime()),
  );
export const dual = bin()
  .field("time", converted)
  .field(
    "data",
    bytes((o) =>
      typeof o.time === "string" ? Number(o.time) : o.time.getTime(),
    ),
  );
dual.encode({ time: "2", data: new Uint8Array(2) });
export const computedTag = bin()
  .u8("tag")
  .field("body", match("tag").case(1, u8).case(2, string(1)))
  .computed("tag", () => 1);
// @ts-expect-error the callback can only compute tag 1
computedTag.encode({ body: "x" });
computedTag.encode({ body: 4 });
export const batch = bin()
  .u8("a")
  .u8("b")
  .field("data", bytes("a"))
  .computed({ a: (v) => v.data.length, b: (v) => v.data.length });
batch.encode({ data: new Uint8Array(1) });
// @ts-expect-error finalized computation cannot be invalidated later
batch.u8("extra");
bin()
  .u8("a")
  .u8("b")
  // @ts-expect-error computed fields are absent from the computation's input
  .computed({ a: (v) => v.b, b: () => 1 });
// @ts-expect-error no implicit array flattening
bin().merge(array(u8, 2));
bin().merge(
  // @ts-expect-error object values do not carry a field plan
  map(u8, { decode: (n) => ({ n }), encode: (o: { n: number }) => o.n }),
);
export const bit32 = bin().bits("a", 3).bits("wide", 32).bits("next", 24);
// @ts-expect-error width range
bin().bits("a", 54);
export const limit = bin()
  .u8("limit")
  .field("text", string({ terminator: 0, max: (o) => o.limit }));
export const maxName = string({ terminator: 0, max: "limit" });
// @ts-expect-error max is a number dependency
bin().field("limit", string(1)).field("text", maxName);
export const untilMapped = array(
  map(u8, { decode: (n) => ({ n }), encode: (n: number) => n }),
  { until: (o) => o.n === 0 },
);
// @ts-expect-error predicate consumes decoded objects, not numeric inputs
untilMapped.encode([0]);
export const mixedLength = bytes(Math.random() ? "count" : 2);
// @ts-expect-error unions of length forms retain their possible name dependency
bin().field("count", string(1)).field("body", mixedLength);
export const mixedCallback = bytes(
  Math.random() ? 2 : (o: { count: number }) => o.count,
);
// @ts-expect-error callback union remains dependent
mixedCallback.decode(new Uint8Array());
export const genericLength = <T>(
  length: import("../../src/index.ts").Length<T>,
) => bytes(length);
declare const dynamicKey: "a" | "b";
export const dynamicField = bin().u8(dynamicKey);
expect<Equal<Output<typeof dynamicField>, { a: number } | { b: number }>>();
expect<Equal<Input<typeof dynamicField>, { a: number; b: number }>>();
export const dynamicPick = bin().u8("a").u8("b").pick(dynamicKey);
expect<Equal<Output<typeof dynamicPick>, { a?: number; b?: number }>>();
export const certainPick = bin().u8("a").u8("b").pick("a", dynamicKey);
expect<Equal<Output<typeof certainPick>, { a: number; b?: number }>>();
export const genericString = <T>(
  length: import("../../src/index.ts").Length<T>,
) => string(length);
export const genericArray = <T>(
  length: import("../../src/index.ts").Length<T>,
) => array(u8, length);
export const genericSized = <T>(
  length: import("../../src/index.ts").Length<T>,
) => sized(length, u8);
const mixedName = Math.random() ? "count" : 2;
// @ts-expect-error stored mixed string length needs numeric count
bin().field("count", string(1)).field("body", string(mixedName));
// @ts-expect-error stored mixed array length needs numeric count
bin().field("count", string(1)).field("body", array(u8, mixedName));
// @ts-expect-error stored mixed region length needs numeric count
bin().field("count", string(1)).field("body", sized(mixedName, u8));
