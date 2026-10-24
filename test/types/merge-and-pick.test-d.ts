import { describe, expectTypeOf, it } from "vitest";

import {
  array,
  bin,
  bytes,
  match,
  string,
  u32le,
  u8,
  type Bin,
  type Codec,
  type Input,
  type Output,
} from "../../src/index.ts";

declare const dynamicKey: "a" | "b";

describe("Merges", () => {
  it("add the fields of a parser", () => {
    const Both = bin().u8("a").merge(bin().u8("b"));
    expectTypeOf<Output<typeof Both>>().toEqualTypeOf<{
      a: number;
      b: number;
    }>();
  });

  it("take only parsers, and matches of parsers", () => {
    const Plain: Codec<{ value: number }> = bin().u8("value");
    // @ts-expect-error The annotation hides the fields.
    bin().merge(Plain);
    // @ts-expect-error The cases are not parsers.
    bin().u8("tag").merge(match("tag").case(1, u8));
  });

  it("of picked parsers have no encoder", () => {
    const AfterPick = bin()
      .merge(bin().u8("tag").u8("omit").pick("tag"))
      .field("body", match("tag").case(1, u8));
    expectTypeOf<Output<typeof AfterPick>>().toEqualTypeOf<{
      tag: 1;
      body: number;
    }>();
    // @ts-expect-error A picked parser cannot encode.
    AfterPick.encode({ tag: 1, body: 1 });
  });
});

const withValues = <T extends { count: number }, I extends { count: number }>(
  b: Bin<T, I>,
) =>
  b.field(
    "values",
    bytes((o) => o.count * 2),
  );
const withArray = <T extends { count: number }, I extends { count: number }>(
  p: Bin<T, I>,
) =>
  p.field(
    "values",
    array(
      bytes((o) => o.count),
      (o) => o.count,
    ),
  );

describe("Groups of fields", () => {
  it("are generic functions of the parsers they extend", () => {
    const Grouped = bin().u8("count").pipe(withValues).u8("end");
    expectTypeOf<Output<typeof Grouped>>().toEqualTypeOf<{
      count: number;
      values: Uint8Array;
      end: number;
    }>();
    // @ts-expect-error `count` is missing.
    bin().u8("other").pipe(withValues);
    bin().u8("count").pipe(withArray);
  });

  it("may add codecs that read fields by name", () => {
    const Stored = array(bytes("count"), "count");
    const withStored = <
      T extends { count: number },
      I extends { count: number },
    >(
      p: Bin<T, I>,
    ) => p.field("data", Stored);
    expectTypeOf<
      Output<
        ReturnType<typeof withStored<{ count: number }, { count: number }>>
      >
    >().toEqualTypeOf<{ count: number; data: Uint8Array[] }>();
  });
});

describe("Picked fields", () => {
  it("keep the union of their tags", () => {
    const Small = bin()
      .u8("flag")
      .u8("type")
      .field(
        "payload",
        match("type").case(1, u32le).case(15, u8).case(26, string(u32le)),
      )
      .u8("after")
      .pick("type", "after");
    expectTypeOf<Output<typeof Small>>().toEqualTypeOf<
      | { type: 1; after: number }
      | { type: 15; after: number }
      | { type: 26; after: number }
    >();
    const PickedUnion = bin()
      .u8("tag")
      .field("body", match("tag").case(1, u8).case(2, string(1)))
      .pick("tag", "body");
    expectTypeOf<Output<typeof PickedUnion>>().toEqualTypeOf<
      { tag: 1; body: number } | { tag: 2; body: string }
    >();
  });

  it("are optional if their names may be one of several", () => {
    const DynamicField = bin().u8(dynamicKey);
    expectTypeOf<Output<typeof DynamicField>>().toEqualTypeOf<
      { a: number } | { b: number }
    >();
    expectTypeOf<Input<typeof DynamicField>>().toEqualTypeOf<{
      a: number;
      b: number;
    }>();
    const DynamicPick = bin().u8("a").u8("b").pick(dynamicKey);
    expectTypeOf<Output<typeof DynamicPick>>().toEqualTypeOf<{
      a?: number;
      b?: number;
    }>();
    const CertainPick = bin().u8("a").u8("b").pick("a", dynamicKey);
    expectTypeOf<Output<typeof CertainPick>>().toEqualTypeOf<{
      a: number;
      b?: number;
    }>();
  });
});
