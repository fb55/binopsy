import { describe, expectTypeOf, it } from "vitest";

import {
  bin,
  bytes,
  lazy,
  literal,
  map,
  match,
  optional,
  sized,
  string,
  u8,
  when,
  type Input,
} from "../../src/index.ts";

/** A number (not a literal type). */
declare const one: number;

/** Accepts `undefined` when encoding, without a default. */
const undef = map(u8, {
  decode: (n) => n,
  encode: (n: number | undefined) => n ?? 0,
});

describe("Literals and computed fields", () => {
  it("may be omitted when encoding", () => {
    const Entry = bin()
      .field("name", string(100, { terminator: 0 }))
      .u32le("size")
      .field("magic", literal(string(6, { terminator: 0 }), "ustar"))
      .field("data", bytes("size"))
      .computed("size", (e) => e.data.length);
    expectTypeOf<Input<typeof Entry>>().toEqualTypeOf<{
      name: string;
      data: Uint8Array;
      magic?: "ustar" | undefined;
      size?: number;
    }>();
    Entry.encode({ name: "a.txt", data: new Uint8Array(3) });
    const LiteralTag = bin()
      .field("tag", literal(u8, 1))
      .field("body", match("tag").case(1, u8));
    expectTypeOf<Input<typeof LiteralTag>>().toEqualTypeOf<{
      tag?: 1 | undefined;
      body: number;
    }>();
    LiteralTag.encode({ body: 1 });
    bin()
      .field("tag", literal(u8, 1))
      .field("value", match("tag").case(1, literal(u8, 2)))
      .encode({});
    const ComputedTag = bin()
      .u8("tag")
      .field("body", match("tag").case(1, u8))
      .computed("tag", () => 1);
    expectTypeOf<Input<typeof ComputedTag>>().toEqualTypeOf<{
      tag?: 1;
      body: number;
    }>();
    ComputedTag.encode({ body: 1 });
  });

  it("are filled in for the functions after them", () => {
    const Fixed = bin()
      .field("count", literal(u8, 2))
      .field(
        "body",
        bytes((o) => o.count),
      );
    expectTypeOf<Input<typeof Fixed>>().toEqualTypeOf<{
      count?: 2 | undefined;
      body: Uint8Array;
    }>();
    Fixed.encode({ body: Uint8Array.of(1, 2) });
    Fixed.encode({ count: undefined, body: Uint8Array.of(1, 2) });
    bin()
      .merge(Fixed)
      .field(
        "tail",
        bytes((o) => o.count),
      );
    const Calculated = bin()
      .field("count", undef)
      .computed("count", () => 2);
    bin()
      .merge(Calculated)
      .field(
        "tail",
        bytes((o) => o.count),
      )
      .encode({ tail: Uint8Array.of(0, 0) });
    const CalculatedBatch = bin()
      .u8("count")
      .u8("size")
      .computed({ count: () => 2, size: () => 3 });
    bin()
      .merge(CalculatedBatch)
      .field(
        "body",
        bytes((o) => o.count + o.size),
      );
  });
});

describe("Computed fields", () => {
  it("allow only the cases of a tag they can compute", () => {
    const OneTag = bin()
      .u8("tag")
      .field("body", match("tag").case(1, u8).case(2, string(1)))
      .computed("tag", () => 1);
    // @ts-expect-error The tag is computed as 1, whose body is a number.
    OneTag.encode({ body: "x" });
    OneTag.encode({ body: 4 });
  });

  it("are computed from the input narrowed by the tag", () => {
    const Narrowed = bin()
      .u8("tag")
      .field("body", match("tag").case(1, u8).case(2, string(1)))
      .u8("length")
      .computed("length", (v) => (v.tag === 1 ? v.body : v.body.length));
    expectTypeOf<Input<typeof Narrowed>>().toEqualTypeOf<
      | { tag: 1; body: number; length?: number }
      | { tag: 2; body: string; length?: number }
    >();
    Narrowed.encode({ tag: 2, body: "x" });
  });

  it("are computed from the input without the computed fields", () => {
    bin()
      .u8("a")
      .u8("b")
      .field("data", bytes("a"))
      .computed({ a: (v) => v.data.length, b: (v) => v.data.length })
      .encode({ data: new Uint8Array(1) });
    bin()
      .u8("a")
      .u8("b")
      // @ts-expect-error `b` is computed too.
      .computed({ a: (v) => v.b, b: () => 1 });
  });
});

describe("Defaults", () => {
  it("are not given for codecs accepting undefined", () => {
    const Required = bin().field("count", undef);
    expectTypeOf<Input<typeof Required>>().toEqualTypeOf<{
      count: number | undefined;
    }>();
    // @ts-expect-error `count` is required, even if it may be undefined.
    Required.encode({});
    Required.encode({ count: undefined });
    Required.field(
      "body",
      bytes((o) => o.count ?? 0),
    );
    Required.field(
      "body",
      // @ts-expect-error `count` may be undefined when encoding.
      bytes((o) => o.count.toFixed(0).length),
    );
    // @ts-expect-error `count` may be undefined when encoding.
    Required.field("body", bytes("count"));
  });

  it("are those of the case of a match", () => {
    const DefaultBranch = bin()
      .u8("tag")
      .field("count", match("tag").case(1, literal(u8, 2)).case(2, undef));
    DefaultBranch.encode({ tag: 1 });
    DefaultBranch.encode({ tag: 2, count: undefined });
    // @ts-expect-error Only case 1 has a default.
    DefaultBranch.encode({ tag: 2 });
    DefaultBranch.field(
      "body",
      bytes((o) => o.count ?? 0),
    );
    DefaultBranch.field(
      "body",
      // @ts-expect-error `count` may be undefined in case 2.
      bytes((o) => o.count.toFixed(0).length),
    );
  });

  it("are kept by `sized` and `lazy`", () => {
    const Bounded = bin().field("count", sized(1, literal(u8, 2)));
    Bounded.encode({});
    Bounded.field(
      "body",
      bytes((o) => o.count),
    );
    const Late = bin().field(
      "count",
      lazy(() => literal(u8, 2)),
    );
    Late.encode({});
    Late.field(
      "body",
      bytes((o) => o.count),
    );
    // @ts-expect-error A region does not add a default.
    bin().field("count", sized(1, undef)).encode({});
  });

  it("are not kept by `map`, `optional`, `when` and unions", () => {
    bin()
      .field(
        "count",
        map(literal(u8, 2), {
          decode: (n) => n,
          encode: (n: 2 | undefined) => n,
        }),
      )
      // @ts-expect-error `map` loses the default.
      .encode({});
    bin()
      .field("count", optional(u8, literal(u8, 2)))
      // @ts-expect-error `optional` needs `null` or a value.
      .encode({});
    bin()
      .u8("flag")
      .field("count", when("flag", literal(u8, 2)))
      // @ts-expect-error `when` needs `null` or a value.
      .encode({ flag: 0 });
    const MaybeDefault = Math.random() ? literal(u8, one) : undef;
    // @ts-expect-error Only one of the codecs has a default.
    bin().field("count", MaybeDefault).encode({});
  });
});
