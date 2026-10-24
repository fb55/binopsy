import { describe, expectTypeOf, it } from "vitest";

import {
  bin,
  bytes,
  literal,
  match,
  string,
  u16le,
  u32le,
  u8,
  type Bin,
  type Codec,
  type Context,
  type Input,
  type Output,
} from "../../src/index.ts";

declare const Kind: Codec<"a" | "b" | "c">;
// oxlint-disable-next-line typescript/no-explicit-any
declare const AnyTag: Codec<any>;
declare const Base: Bin<
  | { readonly kind: 1; note?: string; a: number }
  | { readonly kind: 2; note?: string; b: number }
>;

describe("Matches", () => {
  it("give a discriminated union of their cases", () => {
    const Value = bin()
      .u8("flag")
      .u8("type")
      .field(
        "payload",
        match("type")
          .case(1, u32le)
          .case(15, bin().u32le("row").u32le("uid"))
          .case(26, string(u32le)),
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
    expectTypeOf<Output<typeof Value>>().toEqualTypeOf<ValueT>();
    expectTypeOf<Input<typeof Value>>().toEqualTypeOf<ValueT>();
    const StringTag = bin()
      .field("tag", string(1))
      .field("body", match("tag").case("1", u8).case("x", u16le));
    expectTypeOf<Output<typeof StringTag>>().toEqualTypeOf<
      { tag: "1"; body: number } | { tag: "x"; body: number }
    >();
    const BigintTag = bin().u64le("id").field("v", match("id").case(1n, u8));
    expectTypeOf<Output<typeof BigintTag>>().toEqualTypeOf<{
      id: 1n;
      v: number;
    }>();
  });

  it("on a tag already matched have its cases", () => {
    const Twice = bin()
      .u8("tag")
      .field("a", match("tag").case(1, u8).case(2, string(1)))
      .field("b", match("tag").case(1, u16le).case(2, u8));
    expectTypeOf<Output<typeof Twice>>().toEqualTypeOf<
      { tag: 1; a: number; b: number } | { tag: 2; a: string; b: number }
    >();
    bin()
      .u8("tag")
      .field("a", match("tag").case(1, u8))
      // @ts-expect-error The tag is 1 here.
      .field("b", match("tag").case(3, u8));
  });

  it("are codecs of their own, for several parsers", () => {
    const Payload = match("type").case(1, u32le).case(26, string(u32le));
    const A = bin().u8("type").field("payload", Payload);
    const B = bin().u16le("type").u8("flags").field("payload", Payload);
    expectTypeOf<Output<typeof A>>().toEqualTypeOf<
      { type: 1; payload: number } | { type: 26; payload: string }
    >();
    expectTypeOf<Output<typeof B>>().toEqualTypeOf<
      | { type: 1; flags: number; payload: number }
      | { type: 26; flags: number; payload: string }
    >();
    const Reusable = match("tag").case(1, u8);
    bin().u8("tag").field("v", Reusable);
    bin().field("tag", literal(u8, 1)).field("v", Reusable);
    const Extended = Reusable.case(2, string(1));
    expectTypeOf<Output<typeof Reusable>>().toEqualTypeOf<number>();
    expectTypeOf<Output<typeof Extended>>().toEqualTypeOf<number | string>();
  });

  it("have a variant for the other values with `otherwise`", () => {
    const Defaulted = bin()
      .u8("t")
      .field("v", match("t").case(1, string(1)).otherwise(u16le));
    expectTypeOf<Output<typeof Defaulted>>().toEqualTypeOf<
      { t: 1; v: string } | { t: number; v: number }
    >();
    const Kinds = bin()
      .field("kind", Kind)
      .field("v", match("kind").case("a", u8).otherwise(u32le));
    expectTypeOf<Output<typeof Kinds>>().toEqualTypeOf<
      { kind: "a"; v: number } | { kind: "b" | "c"; v: number }
    >();
    const Unreachable = bin()
      .field("tag", literal(u8, 1))
      .field("body", match("tag").case(1, u8).otherwise(string(1)));
    expectTypeOf<Output<typeof Unreachable>>().toEqualTypeOf<{
      tag: 1;
      body: number;
    }>();
    const OnlyOtherwise = bin()
      .u8("tag")
      .field("body", match("tag").otherwise(u8));
    expectTypeOf<Output<typeof OnlyOtherwise>>().toEqualTypeOf<{
      tag: number;
      body: number;
    }>();
    const OuterLiteral = bin<{ tag: 1 }>().field(
      "body",
      match("tag").case(1, u8).otherwise(string(1)),
    );
    expectTypeOf<Output<typeof OuterLiteral>>().toEqualTypeOf<{
      body: number;
    }>();
    const OuterNumber = bin<{ tag: number }>().field(
      "body",
      match("tag").case(1, u8).otherwise(string(1)),
    );
    expectTypeOf<Output<typeof OuterNumber>>().toEqualTypeOf<
      { body: number } | { body: string }
    >();
  });

  it("have one case for each value of the tag", () => {
    // @ts-expect-error `type` is not a field before this.
    bin().u8("flag").field("payload", match("type").case(1, u32le));
    // @ts-expect-error The tag is always 1.
    bin().field("tag", literal(u8, 1)).field("body", match("tag").case(2, u8));
    // @ts-expect-error 1 already has a case.
    match("tag").case(1, u8).case(1, u16le);
    match("tag")
      .case(1, u8)
      // @ts-expect-error A case value is one literal.
      .case(1 as 1 | 2, u8);
    // @ts-expect-error A case value is a literal.
    match("tag").case(Math.random(), u8);
  });

  it("have cases that read earlier fields", () => {
    const Sized = bin()
      .u8("type")
      .u8("count")
      .field("data", match("type").case(1, bytes("count")).case(2, u8));
    expectTypeOf<Output<typeof Sized>>().toEqualTypeOf<
      | { type: 1; count: number; data: Uint8Array }
      | { type: 2; count: number; data: number }
    >();
    bin()
      .u8("type")
      // @ts-expect-error `count` is not a field before this.
      .field("data", match("type").case(1, bytes("count")));
    bin()
      .u8("type")
      .field("length", string(1))
      // @ts-expect-error `length` is a string.
      .field("data", match("type").case(1, string("length")));
    match("type").case(
      1,
      // @ts-expect-error A case defined on its own does not know the fields.
      bytes((o) => o.count * 2),
    );
    const Prefix = bin().u8("tag").u8("count");
    const Annotated = match("tag").case(
      1,
      bytes((o: Pick<Output<typeof Prefix>, "count">) => o.count * 2),
    );
    Prefix.field("data", Annotated);
    bin().u16le("tag").u16le("count").field("data", Annotated);
  });

  it("have tags computed by functions", () => {
    // @ts-expect-error A match defined on its own does not know the fields.
    match((o) => (o.x > 5 ? "a" : "b"));
    const Computed = bin()
      .u8("x")
      .field(
        "w",
        match((o: { x: number }) => (o.x > 5 ? "a" : "b"))
          .case("a", u16le)
          .case("b", string(1)),
      );
    expectTypeOf<Output<typeof Computed>>().toEqualTypeOf<{
      x: number;
      w: number | string;
    }>();
    // @ts-expect-error The function never returns "z".
    match((o: { x: number }) => (o.x > 5 ? "a" : "b")).case("z", u8);
  });

  it("need every field and function the tag may be", () => {
    const NameChoice = match(Math.random() ? "a" : "b").case(1, u8);
    expectTypeOf<Context<typeof NameChoice>>().toEqualTypeOf<{
      a: string | number | bigint | boolean;
      b: string | number | bigint | boolean;
    }>();
    const Choice = bin().u8("a").u8("b").field("value", NameChoice);
    expectTypeOf<Output<typeof Choice>>().toEqualTypeOf<
      { a: 1; b: number; value: number } | { a: number; b: 1; value: number }
    >();
    const CallbackChoice = match(
      Math.random() ? (o: { a: number }) => o.a : (o: { b: number }) => o.b,
    ).case(1, u8);
    expectTypeOf<Context<typeof CallbackChoice>>().toEqualTypeOf<
      { a: number } & { b: number }
    >();
    const MixedChoice = match(
      Math.random() ? "a" : (o: { b: number }) => o.b,
    ).case(1, u8);
    // @ts-expect-error The function reads `b`.
    bin().u8("a").field("value", MixedChoice);
    const Mixed = bin().u8("a").u8("b").field("value", MixedChoice);
    expectTypeOf<Output<typeof Mixed>>().toEqualTypeOf<{
      a: number;
      b: number;
      value: number;
    }>();
  });

  it("read tags of merged parsers and outer fields", () => {
    const MergedTag = bin()
      .merge(bin().u8("tag"))
      .field("body", match("tag").case(1, u8));
    expectTypeOf<Output<typeof MergedTag>>().toEqualTypeOf<{
      tag: 1;
      body: number;
    }>();
    const OuterTag = bin<{ tag: number }>().field(
      "body",
      match("tag").case(1, u8),
    );
    expectTypeOf<Output<typeof OuterTag>>().toEqualTypeOf<{ body: number }>();
  });

  it("of parsers add the fields of their cases when merged", () => {
    const Message = bin().u8("length").field("message", string("length"));
    const Flat = bin()
      .u8("tag")
      .merge(
        match("tag")
          .case(1, Message)
          .case(3, bin().u32le("number"))
          .otherwise(bin().u8("raw")),
      )
      .u8("end");
    type FlatT =
      | { tag: 1; length: number; message: string; end: number }
      | { tag: 3; number: number; end: number }
      | { tag: number; raw: number; end: number };
    expectTypeOf<Output<typeof Flat>>().toEqualTypeOf<FlatT>();
    expectTypeOf<Input<typeof Flat>>().toEqualTypeOf<FlatT>();
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
    expectTypeOf<Output<typeof Tlv>>().toEqualTypeOf<
      | { tag: 1; length: number; raw: Uint8Array }
      | { tag: 2; length: number; message: string; end: number }
    >();
    // @ts-expect-error `length` is not a field before this.
    bin().u8("tag").merge(match("tag").case(1, Raw));
  });

  it("split a union of earlier fields", () => {
    const Variants = Base.field(
      "body",
      match("kind").case(1, u8).case(2, bytes(1)),
    );
    expectTypeOf<Output<typeof Variants>>().toEqualTypeOf<
      | { readonly kind: 1; note?: string; a: number; body: number }
      | { readonly kind: 2; note?: string; b: number; body: Uint8Array }
    >();
    const Selected = Variants.pick("kind", "note");
    expectTypeOf<Output<typeof Selected>>().toEqualTypeOf<
      { readonly kind: 1; note?: string } | { readonly kind: 2; note?: string }
    >();
    const One = bin().field("tag", literal(u8, 1)).u8("a");
    const Two = bin().field("tag", literal(u8, 2)).u8("b");
    const OneOrTwo = match("tag").case(1, u8).case(2, string(1));
    const Either = bin()
      .merge(Math.random() ? One : Two)
      .field("body", OneOrTwo);
    expectTypeOf<Output<typeof Either>>().toEqualTypeOf<
      { tag: 1; a: number; body: number } | { tag: 2; b: number; body: string }
    >();
  });

  it("accept any case for an explicit `any` tag", () => {
    bin().field("tag", AnyTag).field("body", match("tag").case("x", u8));
  });
});
