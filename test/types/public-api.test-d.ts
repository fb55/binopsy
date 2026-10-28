import { describe, expectTypeOf, it } from "vitest";

import {
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
    expectTypeOf(Record.encode).parameter(0).toEqualTypeOf<Encoded>();
    expectTypeOf(Record.encodeInto).parameter(0).toEqualTypeOf<Encoded>();
    expectTypeOf(Record.sizeOf).parameter(0).toEqualTypeOf<Encoded>();
    expectTypeOf(
      new Reader(new Uint8Array()).read(Record),
    ).toEqualTypeOf<Decoded>();
    for await (const value of decodeStream(Record, [])) {
      expectTypeOf(value).toEqualTypeOf<Decoded>();
    }
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
