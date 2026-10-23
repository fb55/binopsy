/* eslint-disable */
/** The repo's type tests (test/types.ts), ported to the designed API. */
import {
  array,
  bin,
  bytes,
  fail,
  lazy,
  literal,
  map,
  match,
  optional,
  sized,
  string,
  u16le,
  u32le,
  u8,
  when,
  type Bin,
  type Codec,
  type Input,
  type Output,
} from "../../src/index.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function expect<T extends true>(): T | void {}

export function typeTests(): void {
  const FmString = string(u32le);
  const FmDate = map(bin().u16le("day").u16le("year"), {
    decode: (d) => (d.year === 1900 ? null : `${d.year}-${d.day}`),
    encode: (iso: string | null) => ({
      day: 1,
      year: iso ? Number(iso.slice(0, 4)) : 1900,
    }),
  });
  const Ref = bin().u32le("row").u32le("uid");

  // Fields, nesting and conversions.
  const Player = bin()
    .u8("version")
    .field("x08", optional(u8, fail("unsupported")))
    .field("pairs", array(bin().u8("a").u8("b"), u32le))
    .field("magic", literal(u32le, 0x46))
    .field("born", FmDate)
    .field("club", Ref);
  expect<
    Equal<
      Output<typeof Player>,
      {
        version: number;
        x08: null;
        pairs: { a: number; b: number }[];
        magic: 0x46;
        born: string | null;
        club: { row: number; uid: number };
      }
    >
  >();

  // Lengths and functions see the fields before them; names must be number fields.
  const Ratings = bin()
    .u8("count")
    .field(
      "values",
      bytes((o) => (o.count > 5 ? 11 : 10)),
    );
  expect<
    Equal<Output<typeof Ratings>, { count: number; values: Uint8Array }>
  >();
  // @ts-expect-error `name` is not a number field
  bin().field("name", FmString).field("data", bytes("name"));
  bin()
    .u8("n")
    .field(
      "data",
      // @ts-expect-error `missing` is not a field before it
      bytes((o) => o.missing),
    );

  // Dependencies are kept through wrappers; dependent codecs cannot decode on their own.
  const dependent = bytes("count");
  const mapped = map(dependent, {
    decode: (b) => b,
    encode: (b: Uint8Array) => b,
  });
  // @ts-expect-error missing `count`
  bin().field("a", mapped);
  // @ts-expect-error missing `count`
  bin().field("a", optional(u8, dependent));
  // @ts-expect-error missing `count`
  bin().field("a", array(dependent, 2));
  // @ts-expect-error missing `count`
  bin().u8("tag").field("a", match("tag").case(1, dependent));
  // @ts-expect-error needs an enclosing `count`
  dependent.decode(new Uint8Array());
  bin()
    .u8("count")
    .field("a", optional(u8, dependent))
    .field("b", array(dependent, 2));
  // @ts-expect-error `count` must be a number
  bin().field("count", string(1)).field("a", optional(u8, dependent));

  // Matches: discriminated unions; case values are values of the tag's type.
  const Value = bin()
    .u8("flag")
    .u8("type")
    .field(
      "payload",
      match("type").case(1, u32le).case(15, Ref).case(26, FmString),
    )
    .u8("after");
  const value = Value.decode(new Uint8Array());
  if (value.type === 26) expect<Equal<typeof value.payload, string>>();
  if (value.type === 15)
    expect<Equal<typeof value.payload, { row: number; uid: number }>>();
  // @ts-expect-error the tag must be a field before it
  bin().u8("flag").field("payload", match("type").case(1, u32le));
  // @ts-expect-error the tag is always 1
  bin().field("tag", literal(u8, 1)).field("body", match("tag").case(2, u8));
  // @ts-expect-error a number tag is not "hello"
  bin().u8("tag").field("body", match("tag").case("hello", u8));
  const StringTag = bin()
    .field("tag", string(1))
    .field("body", match("tag").case("1", u8).case("x", u16le));
  expect<
    Equal<
      Output<typeof StringTag>,
      { tag: "1"; body: number } | { tag: "x"; body: number }
    >
  >();
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
  const Merged = bin()
    .merge(bin().u8("tag"))
    .field("body", match("tag").case(1, u8));
  expect<Equal<Output<typeof Merged>, { tag: 1; body: number }>>();
  bin()
    .u8("tag")
    .field("value", match("tag").case(1, literal(u8, 0)))
    .encode({ tag: 1 });

  // A default case is a variant of its own; computed tags give no union.
  const Defaulted = bin()
    .u8("t")
    .field("v", match("t").case(1, string(1)).otherwise(u16le));
  expect<
    Equal<
      Output<typeof Defaulted>,
      { t: 1; v: string } | { t: number; v: number }
    >
  >();
  const Computed = bin()
    .u8("x")
    .field(
      "w",
      match((o: { x: number }) => (o.x > 5 ? "a" : "b"))
        .case("a", u16le)
        .case("b", string(1)),
    );
  expect<Equal<Output<typeof Computed>, { x: number; w: number | string }>>();

  // Arrays up to an item, values in regions.
  const Terminated = array(u8, { until: (item) => item === 0 });
  expect<Equal<Output<typeof Terminated>, number[]>>();
  const Region = bin()
    .u8("n")
    .field("text", sized("n", string(Infinity)));
  expect<Equal<Output<typeof Region>, { n: number; text: string }>>();
  // @ts-expect-error `n` is not a field before it
  bin().field("text", sized("n", string(Infinity)));

  // Reusable groups of fields.
  const withValues = <T extends { count: number }, I extends { count: number }>(
    b: Bin<T, I>,
  ) =>
    b.field(
      "values",
      bytes((o) => o.count * 2),
    );
  const Grouped = bin().u8("count").pipe(withValues).u8("end");
  expect<
    Equal<
      Output<typeof Grouped>,
      { count: number; values: Uint8Array; end: number }
    >
  >();
  // @ts-expect-error `count` is missing
  bin().u8("other").pipe(withValues);

  // Conditional parts give unions.
  const Server = bin().u32le("serverId");
  const full = Math.random() > 0.5;
  const Person = bin()
    .u32le("id")
    .merge(full ? Server : bin())
    .u8("tail");
  expect<
    Equal<
      Output<typeof Person>,
      | { id: number; serverId: number; tail: number }
      | { id: number; tail: number }
    >
  >();
  const Versioned = bin()
    .u8("version")
    .field(
      "ext",
      when((o) => o.version >= 2, bin().u8("x")),
    );
  expect<
    Equal<
      Output<typeof Versioned>,
      { version: number; ext: { x: number } | null }
    >
  >();
  const Flagged = bin().u8("hasExt").field("ext", when("hasExt", u8));
  expect<
    Equal<Output<typeof Flagged>, { hasExt: number; ext: number | null }>
  >();
  // @ts-expect-error not a field
  bin().u8("hasExt").field("ext", when("hasExtt", u8));

  // Inputs: computed fields and literals may be omitted.
  const Entry = bin()
    .field("name", string(100, { terminator: 0 }))
    .u32le("size")
    .field("magic", literal(string(6, { terminator: 0 }), "ustar"))
    .field("data", bytes("size"))
    .computed("size", (e) => e.data.length);
  expect<
    Equal<
      Input<typeof Entry>,
      {
        name: string;
        data: Uint8Array;
        magic?: "ustar" | undefined;
        size?: number;
      }
    >
  >();
  Entry.encode({ name: "a.txt", data: new Uint8Array(3) });
  const Sized = bin()
    .u8("tag")
    .field("body", match("tag").case(1, u8).case(2, string(1)))
    .u8("size")
    .computed("size", (v) => (v.tag === 1 ? v.body : v.body.length));
  Sized.encode({ tag: 2, body: "x" });

  // Decode-only values compose, and cannot be encoded.
  const People = array(
    bin()
      .u8("id")
      .field("born", map(Ref, { decode: (r) => r.row })),
    u32le,
  );
  expect<Equal<Output<typeof People>, { id: number; born: number }[]>>();
  // @ts-expect-error decode-only
  People.encode([{ id: 1, born: 1 }]);

  // Partial decoders, recursion, bit fields.
  const Small = Value.pick("type", "after");
  expect<
    Equal<
      Output<typeof Small>,
      | { type: 1; after: number }
      | { type: 15; after: number }
      | { type: 26; after: number }
    >
  >();
  // @ts-expect-error not a field
  Value.pick("nope");
  interface Tree {
    count: number;
    children: Tree[];
  }
  const Tree: Codec<Tree> = bin()
    .u8("count")
    .field(
      "children",
      array(
        lazy(() => Tree),
        "count",
      ),
    );
  void Tree;
  const Flags = bin().bits("kind", 3).bits("mode", 5).u16be("rest");
  expect<
    Equal<Output<typeof Flags>, { kind: number; mode: number; rest: number }>
  >();
  bin({ bitOrder: "lsb" }).bits("kind", 3).bits("mode", 5);
  // @ts-expect-error whole bytes have a byte order
  bin().u16("x");

  // Duplicate names fail at definition (not in the types: see DESIGN.md).

  // Strings.
  bin()
    .u8("n")
    .field("s", string("n", { padRight: 0x20 }));
  string({ terminator: 0, max: 32, encoding: "latin1" }).decode(
    new Uint8Array(),
  );
  bytes(4).decode(new Uint8Array());
  string(4).decode(new Uint8Array());
  // @ts-expect-error max needs a terminator and no length
  string(10, { terminator: 0, max: 5 });
  // @ts-expect-error a string without a length needs a terminator
  string({ max: 5 });

  // literal: scalars only; refine: codecs that encode what they decode.
  // @ts-expect-error not a scalar
  literal(bin().u8("a"), { a: 1 });
  refine(FmDate, (d) => d !== null);
  refine(
    // @ts-expect-error encodes more values than it decodes
    map(u8, {
      decode: (n) => (n ? "y" : "n"),
      encode: (s: string) => s.length,
    }),
    (s) => s === "y",
  );
  // @ts-expect-error a parser with literals encodes values without them
  refine(bin().field("m", literal(u8, 1)).u8("x"), (v) => v.x > 0);
}
import { refine } from "../../src/index.ts";
