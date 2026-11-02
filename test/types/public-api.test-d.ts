import { describe, expectTypeOf, it } from "vitest";

import {
  array,
  bin,
  bytes,
  decodeStream,
  lazy,
  match,
  Reader,
  string,
  u8,
  type AnyBin,
  type Context,
  type Decoder,
  type Input,
  type Output,
} from "../../src/index.ts";

describe("AnyBin", () => {
  it("accepts every kind of parser", () => {
    expectTypeOf(bin().u8("a")).toExtend<AnyBin>();
    expectTypeOf(
      bin().u8("t").field("v", match("t").case(0, u8)),
    ).toExtend<AnyBin>();
    expectTypeOf(
      bin()
        .u8("n")
        .field("s", string("n"))
        .computed("n", (v) => v.s.length),
    ).toExtend<AnyBin>();
    expectTypeOf(bin().u8("n").pick("n")).toExtend<AnyBin>();
    expectTypeOf(
      bin<{ length: number }>().field("s", string("length")),
    ).toExtend<AnyBin>();
  });
});

describe("Parser methods", () => {
  it("take and return the values of the parser", async () => {
    const Record = bin()
      .u8("n")
      .field("items", bytes("n"))
      .field("tail", bin().u32le("a"));
    type Decoded = Output<typeof Record>;
    type Encoded = Input<typeof Record>;
    expectTypeOf(Record.decode).returns.toEqualTypeOf<Decoded>();
    expectTypeOf(Record.decodeExact).returns.toEqualTypeOf<Decoded>();
    expectTypeOf(Record.encode).parameter(0).toEqualTypeOf<Encoded>();
    expectTypeOf(Record.encodeInto).parameter(0).toEqualTypeOf<Encoded>();
    expectTypeOf(Record.sizeOf).parameter(0).toEqualTypeOf<Encoded>();
    expectTypeOf(
      new Reader(new Uint8Array()).read(Record),
    ).toEqualTypeOf<Decoded>();
    for await (const value of decodeStream(Record, [])) {
      expectTypeOf(value).toEqualTypeOf<Decoded>();
    }
    expectTypeOf(Record.fields).toEqualTypeOf<
      readonly ("n" | "items" | "tail")[]
    >();
  });
});

describe("Decoder", () => {
  it("takes every codec of its values, which then only decode", () => {
    const parsers: Record<number, Decoder<object>> = {
      1: bin().u8("a"),
      2: bin().u32le("b").field("c", string(u8)),
    };
    expectTypeOf(
      new Reader(new Uint8Array()).read(parsers[1]),
    ).toEqualTypeOf<object>();
    const A = bin().u8("a");
    const B = bin().u8("a").u8("b");
    const choice: Decoder<Output<typeof A> | Output<typeof B>> =
      Math.random() > 0.5 ? A : B;
    const pair = array(choice, 2);
    expectTypeOf<Output<typeof pair>>().toEqualTypeOf<
      ({ a: number } | { a: number; b: number })[]
    >();
    // @ts-expect-error A decoder does not encode.
    choice.encode({ a: 1, b: 2 });
  });
});

describe("Decoding on its own", () => {
  it("takes codecs that read no outer fields", () => {
    bytes(4).decode(new Uint8Array());
    string(4).decode(new Uint8Array());
    const Terminated = string({ terminator: 0 });
    expectTypeOf<Context<typeof Terminated>>().toEqualTypeOf<unknown>();
  });

  it("rejects codecs that read outer fields", () => {
    // @ts-expect-error `count` is an outer field.
    bytes("count").decode(new Uint8Array());
    // @ts-expect-error `count` is an outer field.
    bytes("count").decodeExact(new Uint8Array());
    const Dependent = bin<{ count: number }>().field("value", bytes("count"));
    // @ts-expect-error `count` is an outer field.
    Dependent.pick("value").decode(new Uint8Array());
    // @ts-expect-error `count` is an outer field.
    new Reader(new Uint8Array()).read(Dependent);
    // @ts-expect-error `count` is an outer field.
    decodeStream(Dependent, []);
    const Annotated = bytes((o: { count?: number }) => o.count ?? 0);
    // @ts-expect-error The function reads `count`, even if it is optional.
    Annotated.decode(new Uint8Array());
    // @ts-expect-error `lazy` takes codecs that read no outer fields.
    lazy(() => bytes("size"));
  });
});
