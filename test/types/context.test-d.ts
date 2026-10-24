import { describe, expectTypeOf, it } from "vitest";

import {
  array,
  bin,
  bytes,
  literal,
  map,
  optional,
  refine,
  sized,
  string,
  u32le,
  u8,
  when,
  type Bin,
  type Context,
  type Input,
  type Output,
} from "../../src/index.ts";

declare const CountOrOther: Bin<{ count: number } | { other: number }>;
declare const CountTypes: Bin<{ count: number } | { count: string }>;

describe("Lengths, conditions and functions", () => {
  it("read the fields before them", () => {
    const Ratings = bin()
      .u8("count")
      .field(
        "values",
        bytes((o) => (o.count > 5 ? 11 : 10)),
      );
    expectTypeOf<Output<typeof Ratings>>().toEqualTypeOf<{
      count: number;
      values: Uint8Array;
    }>();
    // @ts-expect-error `name` is not a number field.
    bin().field("name", string(u32le)).field("data", bytes("name"));
    // @ts-expect-error `cuont` is not a field.
    bin().u8("count").field("data", bytes("cuont"));
    bin()
      .u8("n")
      .field(
        "data",
        // @ts-expect-error `missing` is not a field before it.
        bytes((o) => o.missing),
      );
    // @ts-expect-error `hasExtt` is not a field.
    bin().u8("hasExt").field("ext", when("hasExtt", u8));
  });

  it("read number fields present in every variant", () => {
    // @ts-expect-error `count` is missing in a variant.
    CountOrOther.field("data", bytes("count"));
    // @ts-expect-error `count` is a string in a variant.
    CountTypes.field("data", bytes("count"));
    // @ts-expect-error An optional field may be missing.
    bin<{ length?: number }>().field("raw", bytes("length"));
  });

  it("read the fields of the parser before outer fields", () => {
    const Shadow = bin<{ count: number }>().field(
      "count",
      map(u8, { decode: (n) => String(n), encode: (s: string) => Number(s) }),
    );
    // @ts-expect-error The parser's `count` is a string.
    Shadow.field("data", bytes("count"));
  });

  it("are requirements of their codecs, kept by wrappers", () => {
    const Stored = bytes("count");
    expectTypeOf<Context<typeof Stored>>().toEqualTypeOf<{ count: number }>();
    // @ts-expect-error `count` is a string.
    bin().field("count", string(1)).field("data", Stored);
    bin()
      .u8("count")
      .field("a", optional(u8, Stored))
      .field("b", array(Stored, 2));
    // @ts-expect-error `count` is missing.
    bin().field("a", optional(u8, Stored));
    const Mapped = map(Stored, {
      decode: (b) => b,
      encode: (b: Uint8Array) => b,
    });
    // @ts-expect-error `count` is missing.
    bin().field("a", Mapped);
    const InArray = array(bytes("width"), "count");
    expectTypeOf<Context<typeof InArray>>().toEqualTypeOf<
      { width: number } & { count: number }
    >();
    const InRegion = sized("limit", bytes("width"));
    expectTypeOf<Context<typeof InRegion>>().toEqualTypeOf<
      { width: number } & { limit: number }
    >();
    const NamedWhen = when("flag", bytes("size"));
    expectTypeOf<Context<typeof NamedWhen>>().toEqualTypeOf<
      { size: number } & { flag: unknown }
    >();
    bin().u8("size").u8("flag").field("v", NamedWhen);
    const CallbackWhen = when(
      (o: { flag: boolean }) => o.flag,
      bytes((o: { size: number }) => o.size),
    );
    expectTypeOf<Context<typeof CallbackWhen>>().toEqualTypeOf<
      { flag: boolean } & { size: number }
    >();
    const Dependent = bin<{ count: number }>().field("value", bytes("count"));
    const Nested = bin().u8("count").field("region", sized(4, Dependent));
    expectTypeOf<Output<typeof Nested>>().toEqualTypeOf<{
      count: number;
      region: { value: Uint8Array };
    }>();
    // @ts-expect-error `count` is missing.
    bin().field("region", sized(4, Dependent));
  });

  it("in wrappers read the fields of the parser", () => {
    // oxfmt-ignore
    const Wrapped = bin()
      .u8("size")
      .u8("count")
      .field("array", array(bytes((o) => o.size), "count"))
      .field("optional", optional(u8, bytes((o) => o.size)))
      .field("when", when((o) => o.size > 0, bytes((o) => o.size)))
      .field("sized", sized("size", bytes((o) => o.size)))
      .field("map", map(bytes((o) => o.size), { decode: (b) => b, encode: (b) => b }))
      .field("refine", refine(bytes((o) => o.size), (b) => b.length > 0))
      .field("literal", literal(string((o) => o.size), "MAGIC"))
      .field("nested", sized("size", array(optional(u8, bytes((o) => o.size)), "count")));
    expectTypeOf<Output<typeof Wrapped>>().toEqualTypeOf<{
      size: number;
      count: number;
      array: Uint8Array[];
      optional: Uint8Array | null;
      when: Uint8Array | null;
      sized: Uint8Array;
      map: Uint8Array;
      refine: Uint8Array;
      literal: "MAGIC";
      nested: (Uint8Array | null)[];
    }>();
    expectTypeOf<Input<typeof Wrapped>>().toEqualTypeOf<{
      size: number;
      count: number;
      array: readonly Uint8Array[];
      optional: Uint8Array | null;
      when: Uint8Array | null;
      sized: Uint8Array;
      map: Uint8Array;
      refine: Uint8Array;
      literal?: "MAGIC" | undefined;
      nested: readonly (Uint8Array | null)[];
    }>();
  });

  it("see the values being encoded too", () => {
    const Time = map(u8, {
      decode: (n) => new Date(n),
      encode: (s: string) => Number(s),
    });
    bin()
      .field("time", Time)
      .field(
        "data",
        array(
          // @ts-expect-error `time` is a string when encoding.
          bytes((o) => o.time.getTime()),
          1,
        ),
      );
    const Dual = bin()
      .field("time", Time)
      .field(
        "data",
        bytes((o) =>
          typeof o.time === "string" ? Number(o.time) : o.time.getTime(),
        ),
      );
    Dual.encode({ time: "2", data: new Uint8Array(2) });
  });
});
