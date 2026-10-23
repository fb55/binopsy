/* eslint-disable */
import {
  bin,
  bytes,
  literal,
  match,
  string,
  u16le,
  u32le,
  u8,
  type Codec,
  type Input,
  type Output,
} from "../../src/index.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function expect<T extends true>(): T | void {}
declare const Kind: Codec<"a" | "b" | "c">;

export function typeTests(): void {
  const Ref = bin().u32le("row").u32le("uid");
  const FmString = string(u32le);

  // 1. A field picked by the tag.
  const Value = bin()
    .u8("flag")
    .u8("type")
    .field(
      "payload",
      match("type").case(1, u32le).case(15, Ref).case(26, FmString),
    )
    .u8("after");
  type ValueT =
    | { flag: number; type: 1; payload: number; after: number }
    | {
        flag: number;
        type: 15;
        payload: { row: number; uid: number };
        after: number;
      }
    | { flag: number; type: 26; payload: string; after: number };
  expect<Equal<Output<typeof Value>, ValueT>>();
  expect<Equal<Input<typeof Value>, ValueT>>();

  // 2. A match is a codec of its own: define once, use in several parsers.
  const Payload = match("type").case(1, u32le).case(26, FmString);
  const A = bin().u8("type").field("payload", Payload);
  const B = bin().u16le("type").u8("flags").field("payload", Payload);
  expect<
    Equal<
      Output<typeof A>,
      { type: 1; payload: number } | { type: 26; payload: string }
    >
  >();
  expect<
    Equal<
      Output<typeof B>,
      | { type: 1; flags: number; payload: number }
      | { type: 26; flags: number; payload: string }
    >
  >();

  // 3. Otherwise; no cases after it.
  const Defaulted = bin()
    .u8("t")
    .field("v", match("t").case(1, string(1)).otherwise(u16le));
  expect<
    Equal<
      Output<typeof Defaulted>,
      { t: 1; v: string } | { t: number; v: number }
    >
  >();
  // @ts-expect-error
  match("t").otherwise(u8).case(1, u8);
  const Kinds = bin()
    .field("kind", Kind)
    .field("v", match("kind").case("a", u8).otherwise(u32le));
  expect<
    Equal<
      Output<typeof Kinds>,
      { kind: "a"; v: number } | { kind: "b" | "c"; v: number }
    >
  >();

  // 4. Wrong cases.
  // @ts-expect-error -- not a field
  bin().u8("flag").field("payload", match("type").case(1, u32le));
  // @ts-expect-error -- the tag is always 1
  bin().field("tag", literal(u8, 1)).field("body", match("tag").case(2, u8));
  // @ts-expect-error -- a number tag is not "hello"
  bin().u8("tag").field("body", match("tag").case("hello", u8));
  // @ts-expect-error -- twice
  match("tag").case(1, u8).case(1, u16le);

  // 5. Two matches on one tag.
  const Twice = bin()
    .u8("tag")
    .field("a", match("tag").case(1, u8).case(2, string(1)))
    .field("b", match("tag").case(1, u16le).case(2, u8));
  expect<
    Equal<
      Output<typeof Twice>,
      { tag: 1; a: number; b: number } | { tag: 2; a: string; b: number }
    >
  >();
  bin()
    .u8("tag")
    .field("a", match("tag").case(1, u8))
    // @ts-expect-error -- only 1 is left
    .field("b", match("tag").case(3, u8));

  // 6. Cases depending on earlier fields.
  const Sized = bin()
    .u8("type")
    .u8("count")
    .field("data", match("type").case(1, bytes("count")).case(2, u8));
  expect<
    Equal<
      Output<typeof Sized>,
      | { type: 1; count: number; data: Uint8Array }
      | { type: 2; count: number; data: number }
    >
  >();
  bin()
    .u8("type")
    // @ts-expect-error -- no count field
    .field("data", match("type").case(1, bytes("count")));
  match("type").case(
    1,
    // @ts-expect-error -- `o` has no type here
    bytes((o) => o.count * 2),
  );
  match("type").case(
    1,
    bytes((o: { count: number }) => o.count * 2),
  );

  // 7. Computed tags.
  // @ts-expect-error -- `o` has no type here
  match((o) => (o.x > 5 ? "a" : "b"));
  const Computed = bin()
    .u8("x")
    .field(
      "w",
      match((o: { x: number }) => (o.x > 5 ? "a" : "b"))
        .case("a", u16le)
        .case("b", string(1)),
    );
  expect<Equal<Output<typeof Computed>, { x: number; w: number | string }>>();

  // 8. Flattened.
  const Message = bin().u8("length").field("message", string("length"));
  const Num = bin().u32le("number");
  const Flat = bin()
    .u8("tag")
    .merge(
      match("tag").case(1, Message).case(3, Num).otherwise(bin().u8("raw")),
    )
    .u8("end");
  type FlatT =
    | { tag: 1; length: number; message: string; end: number }
    | { tag: 3; number: number; end: number }
    | { tag: number; raw: number; end: number };
  expect<Equal<Output<typeof Flat>, FlatT>>();
  expect<Equal<Input<typeof Flat>, FlatT>>();
  // @ts-expect-error
  bin().u8("tag").merge(match("tag").case("hello", Message));
  // Plain merges still work.
  const Both = bin().u8("a").merge(bin().u8("b"));
  expect<Equal<Output<typeof Both>, { a: number; b: number }>>();

  // 9. Bigint tags.
  const Big = bin().u64le("id").field("v", match("id").case(1n, u8));
  expect<Equal<Output<typeof Big>, { id: 1n; v: number }>>();

  // 10. Fields read by name are numbers.
  bin()
    .u8("type")
    .field("length", string(1))
    // @ts-expect-error -- `length` has another type
    .field("data", match("type").case(1, string("length")));
  bin()
    .u8("type")
    .field("count", string(1))
    .field(
      "data",
      // @ts-expect-error -- `count` has another type
      match("type").case(
        1,
        bytes((o: { count: number }) => o.count * 2),
      ),
    );

  // 11. Parsers reading fields from outside.
  const Raw = bin<{ length: number }>().field("raw", bytes("length"));
  const Text = bin<{ length: number }>()
    .field(
      "message",
      string((o) => o.length - 1),
    )
    .u8("end");
  const Tlv = bin()
    .u8("tag")
    .u8("length")
    .merge(match("tag").case(1, Raw).case(2, Text));
  expect<
    Equal<
      Output<typeof Tlv>,
      | { tag: 1; length: number; raw: Uint8Array }
      | { tag: 2; length: number; message: string; end: number }
    >
  >();
  // @ts-expect-error -- `length` is not a field before this
  bin().u8("tag").merge(match("tag").case(1, Raw));
  // @ts-expect-error -- it needs `length`
  Raw.decode(new Uint8Array(4));
  // @ts-expect-error -- a typo
  bin<{ length: number }>().field("raw", bytes("lenght"));
}
