/* eslint-disable */
// Astra's round-0 regression tests, adapted: outer types are written with Output<typeof …>.
import {
  bin,
  match,
  bytes,
  string,
  literal,
  optional,
  map,
  u8,
  u16le,
  type Bin,
  type Codec,
  type Context,
  type Input,
  type Output,
} from "../../src/index.ts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function expect<T extends true>(): T | void {}
declare const UnionBase: Bin<
  { tag: 1; a: number } | { tag: 2; b: number },
  { tag: 1; a: number } | { tag: 2; b: number }
>;
declare const MaybeCount: Bin<{ count?: number }>;
declare const AnyCount: Bin<{ count: any }>;
declare const AnyTag: Codec<any>;
export function tests() {
  const A = bin().field("tag", literal(u8, 1)).u8("a");
  const B = bin().field("tag", literal(u8, 2)).u8("b");
  const M = match("tag").case(1, u8).case(2, string(1));
  const merged = bin()
    .merge(Math.random() ? A : B)
    .field("body", M);
  type Expected =
    { tag: 1; a: number; body: number } | { tag: 2; b: number; body: string };
  expect<Equal<Output<typeof merged>, Expected>>();
  const genericUnion = UnionBase.field("body", M);
  expect<Equal<Output<typeof genericUnion>, Expected>>();
  const literalTag = bin()
    .field("tag", literal(u8, 1))
    .field("body", match("tag").case(1, u8));
  expect<
    Equal<Input<typeof literalTag>, { tag?: 1 | undefined; body: number }>
  >();
  literalTag.encode({ body: 1 });
  const computed = bin()
    .u8("tag")
    .field("body", match("tag").case(1, u8))
    .computed("tag", () => 1);
  expect<Equal<Input<typeof computed>, { tag?: 1; body: number }>>();
  computed.encode({ body: 1 });
  const computedAfter = bin()
    .u8("tag")
    .field("body", match("tag").case(1, u8))
    .computed("tag", () => 1);
  computedAfter.encode({ body: 1 });
  const picked = bin().u8("tag").u8("omit").pick("tag");
  const afterPick = bin().merge(picked).field("body", match("tag").case(1, u8));
  expect<Equal<Output<typeof afterPick>, { tag: 1; body: number }>>();
  // @ts-expect-error picked parser cannot encode
  afterPick.encode({ tag: 1, body: 1 });
  const Raw = bin<{ length: number }>().field("raw", bytes("length"));
  const Text = bin<{ length: number }>().field(
    "text",
    string((o) => o.length - 1),
  );
  const packet = bin()
    .u8("tag")
    .u8("length")
    .merge(match("tag").case(1, Raw).case(2, Text));
  expect<
    Equal<
      Output<typeof packet>,
      | { tag: 1; length: number; raw: Uint8Array }
      | { tag: 2; length: number; text: string }
    >
  >();
  // @ts-expect-error missing outer length, also after pick
  Raw.pick("raw").decode(new Uint8Array());
  // @ts-expect-error decodeAt is internal
  Raw.decodeAt({});
  // @ts-expect-error no length
  bin().u8("tag").merge(match("tag").case(1, Raw));
  // @ts-expect-error wrong length
  bin().u8("tag").field("length", string(1)).merge(match("tag").case(1, Raw));
  // @ts-expect-error typo in the declared outer fields
  bin<{ length: number }>().field("raw", bytes("lenght"));
  const Prefix = bin().u8("tag").u8("count");
  type Shared = Output<typeof Prefix>;
  const P = match("tag").case(
    1,
    bytes((o: Pick<Shared, "count">) => o.count * 2),
  );
  Prefix.field("data", P);
  bin().u16le("tag").u16le("count").field("data", P);
  // @ts-expect-error changed prefix has another count type
  bin().u8("tag").field("count", string(1)).field("data", P);
  const computedSelector = match((o: Pick<Shared, "count">) =>
    o.count > 5 ? "a" : "b",
  )
    .case("a", u8)
    .case("b", string(1));
  Prefix.field("data", computedSelector);
  // @ts-expect-error impossible computed case
  match((o: Shared) => (o.count > 5 ? "a" : "b")).case("z", u8);
  bin()
    .merge(MaybeCount)
    .u8("tag")
    // @ts-expect-error insufficient optional dependency
    .field("data", match("tag").case(1, bytes("count")));
  // @ts-expect-error optional outer declaration
  bin<{ length?: number }>().field("raw", bytes("length"));
  bin()
    .u8("tag")
    .field("count", string(1))
    .field(
      "body",
      // @ts-expect-error callback annotation drift is checked
      match("tag").case(
        1,
        bytes((o: { count: number }) => o.count),
      ),
    );
  bin()
    .u8("tag")
    .field("length", string(1))
    // @ts-expect-error wrapping named dependency preserves requirements
    .field("body", match("tag").case(1, optional(u8, bytes("length"))));
  const wrapped = map(bytes("length"), {
    decode: (b) => b,
    encode: (b: Uint8Array) => b,
  });
  bin()
    .u8("tag")
    .field("length", string(1))
    // @ts-expect-error mapping named dependency preserves requirements
    .field("body", match("tag").case(1, wrapped));
  match("tag")
    .case(1, u8)
    // @ts-expect-error overlapping union cases do not denote one runtime case
    .case(1 as 1 | 2, u8);
  // @ts-expect-error broad number does not describe a known runtime case
  match("tag").case(Math.random(), u8);
  // @ts-expect-error duplicate
  match("tag").case(1, u8).case(1, u16le);
  // any is an explicit TypeScript escape hatch, including for literal checks.
  match("tag").case(null as any, u8);
  const withValues = <T extends { count: number }, I extends { count: number }>(
    b: Bin<T, I>,
  ) =>
    b.field(
      "values",
      bytes((o) => o.count * 2),
    );
  const grouped = bin().u8("count").pipe(withValues).u8("end");
  expect<
    Equal<
      Output<typeof grouped>,
      { count: number; values: Uint8Array; end: number }
    >
  >();
  // @ts-expect-error count missing
  bin().u8("other").pipe(withValues);
  const reusable = match("tag").case(1, u8);
  bin().u8("tag").field("v", reusable);
  bin().field("tag", literal(u8, 1)).field("v", reusable);
  const extension = reusable.case(2, string(1));
  expect<Equal<Output<typeof reusable>, number>>();
  expect<Equal<Output<typeof extension>, number | string>>();
  bytes(4).decode(new Uint8Array());
  string(4).decode(new Uint8Array());
  expect<Equal<Context<ReturnType<typeof fixedBytes>>, unknown>>();
  // Deliberate any escapes remain part of TypeScript; recorded, not claimed safe.
  bin()
    .merge(AnyCount)
    .u8("tag")
    .field("body", match("tag").case(1, bytes("count")));
  bin().field("tag", AnyTag).field("body", match("tag").case("x", u8));
  // @ts-expect-error cannot flatten primitive cases
  bin().u8("tag").merge(match("tag").case(1, u8));
}
function fixedBytes() {
  return bytes(4);
}

declare const BranchBase: Bin<
  { tag: 1; count: number } | { tag: 2; count: string },
  { tag: 1; count: number } | { tag: 2; count: string }
>;
export function additionalTests() {
  // Conservative limitation: requirements are checked against every prefix branch.
  // @ts-expect-error this safe branch-specific dependency is not supported
  BranchBase.field("body", match("tag").case(1, bytes("count")).case(2, u8));
  const externalTag = bin<{ tag: number }>().field(
    "body",
    match("tag").case(1, u8),
  );
  expect<Equal<Output<typeof externalTag>, { body: number }>>();
  const deadDefault = bin()
    .field("tag", literal(u8, 1))
    .field("body", match("tag").case(1, u8).otherwise(string(1)));
  expect<Equal<Output<typeof deadDefault>, { tag: 1; body: number }>>();
  const emptyCases = bin().u8("tag").field("body", match("tag").otherwise(u8));
  expect<Equal<Output<typeof emptyCases>, { tag: number; body: number }>>();
  const pickedUnion = bin()
    .u8("tag")
    .field("body", match("tag").case(1, u8).case(2, string(1)))
    .pick("tag", "body");
  expect<
    Equal<
      Output<typeof pickedUnion>,
      { tag: 1; body: number } | { tag: 2; body: string }
    >
  >();
  const computedUnion = bin()
    .u8("tag")
    .field("body", match("tag").case(1, u8).case(2, string(1)))
    .u8("length")
    .computed("length", (v) => (v.tag === 1 ? v.body : v.body.length));
  expect<
    Equal<
      Input<typeof computedUnion>,
      | { tag: 1; body: number; length?: number }
      | { tag: 2; body: string; length?: number }
    >
  >();
  bin()
    .u8("tag")
    .u8("count")
    .field(
      "body",
      match("tag").case(
        1,
        bytes((o: { count: number }) => o.count * 2),
      ),
    );
  const one = bin().u8("a"),
    two = bin().u8("b");
  const direct = (Math.random() ? one : two).field("c", u8);
  expect<
    Equal<
      Output<typeof direct>,
      { a: number; c: number } | { b: number; c: number }
    >
  >();
}

export function externalDefaults() {
  const finite = bin<{ tag: 1 }>().field(
    "body",
    match("tag").case(1, u8).otherwise(string(1)),
  );
  expect<Equal<Output<typeof finite>, { body: number }>>();
  const broad = bin<{ tag: number }>().field(
    "body",
    match("tag").case(1, u8).otherwise(string(1)),
  );
  expect<Equal<Output<typeof broad>, { body: number } | { body: string }>>();
}
