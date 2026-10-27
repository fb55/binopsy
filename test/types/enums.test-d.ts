import { describe, expectTypeOf, it } from "vitest";

import type { Domain } from "../../src/domain.ts";
import {
  array,
  bin,
  bits,
  enumOf,
  i8,
  literal,
  map,
  match,
  refine,
  string,
  u8,
  u16le,
  u64le,
  type Codec,
  type Context,
  type Input,
  type Output,
} from "../../src/index.ts";

declare const allBytes: { readonly [N in Domain<typeof u8>]: `byte${N}` };
declare const allSignedBytes: { readonly [N in Domain<typeof i8>]: `byte${N}` };
declare const mixedWidth: 1 | 16;
declare const asymmetric: Codec<number, string>;

declare enum Kind {
  Unknown = 0,
  Data = 1,
  Ack = 2,
}
declare enum Tag {
  Data = "DATA",
  Ack = "ACK!",
}
declare const Mixed: { readonly Data: 1; readonly Ack: "ack" };
declare enum OutsideByte {
  Bad = 256,
}
declare const decoder: Codec<number, never>;
declare const dynamic: string[];
declare const numeric: Record<number, string>;
declare const named: Record<string, number>;

describe("Enum types", () => {
  it("infer inline literals and keep the raw codec's output unchanged", () => {
    enumOf(u8, allBytes);
    enumOf(i8, allSignedBytes);
    const priority = enumOf(bits(2), ["low", "normal", "high", "reserved"]);
    const flag = enumOf(bits(1), [false, true]);
    const sparse = enumOf(
      u8,
      { 1: "data", 2: "ack", 63: "error" },
      enumOf.keep,
    );
    const kind = enumOf(u8, Kind, enumOf.reject);
    const tag = enumOf(string(4), Tag, enumOf.keep);
    expectTypeOf<Output<typeof priority>>().toEqualTypeOf<
      "low" | "normal" | "high" | "reserved"
    >();
    expectTypeOf<Output<typeof flag>>().toEqualTypeOf<boolean>();
    expectTypeOf<Output<typeof sparse>>().toEqualTypeOf<
      "data" | "ack" | "error" | number
    >();
    expectTypeOf<Output<typeof kind>>().toEqualTypeOf<Kind>();
    expectTypeOf<Output<typeof tag>>().toEqualTypeOf<
      Tag | NonNullable<string>
    >();
    expectTypeOf<Output<ReturnType<typeof bits<2>>>>().toEqualTypeOf<number>();
    expectTypeOf<Output<typeof u8>>().toEqualTypeOf<number>();
    expectTypeOf<Output<typeof i8>>().toEqualTypeOf<number>();
    enumOf(bits(1), { No: 0, Yes: 1 });
    enumOf(bits(1), { 0: "off", 1: "on" });
    enumOf(bits(1), ["off", "on"], enumOf.reject);
    enumOf(i8, { [-128]: "low", 127: "high" }, enumOf.reject);
    enumOf(u64le, { A: 1n, B: 2n }, enumOf.reject);
  });

  it("require policies for unknown coverage", () => {
    // @ts-expect-error The width could be outside the bounded domains.
    enumOf(bits(mixedWidth), ["off", "on"]);
    // @ts-expect-error Raw 3 has no name.
    enumOf(bits(2), ["low", "normal", "high"]);
    // @ts-expect-error Wider bit domains are not enumerated.
    enumOf(bits(9), ["low", "normal"]);
    // @ts-expect-error Most bytes are unnamed.
    enumOf(u8, Kind);
    // @ts-expect-error Strings have no finite domain.
    enumOf(string(4), Tag);
    // @ts-expect-error Dynamic arrays cannot prove coverage.
    enumOf(bits(1), dynamic);
    // @ts-expect-error Numeric index signatures cannot prove coverage.
    enumOf(bits(1), numeric);
    // @ts-expect-error Named index signatures cannot prove coverage.
    enumOf(bits(1), named);
    enumOf(bits(1), dynamic, enumOf.keep);
    enumOf(bits(1), numeric, enumOf.reject);
    enumOf(bits(1), named, enumOf.reject);
    // @ts-expect-error Empty tables are not enums.
    enumOf(u8, [], enumOf.reject);
  });

  it("check raw domains and fallback membership without widening", () => {
    // @ts-expect-error Raw 5 cannot fit two bits.
    enumOf(bits(2), { 5: "bad" }, enumOf.reject);
    // @ts-expect-error Tuple index 2 cannot fit one bit.
    enumOf(bits(1), ["a", "b", "c"], enumOf.reject);
    // @ts-expect-error Named values must also fit the raw domain.
    enumOf(bits(1), { A: 2 }, enumOf.keep);
    // @ts-expect-error Numeric enum members must also fit the bounded domain.
    enumOf(u8, OutsideByte, enumOf.reject);
    // @ts-expect-error Bytes do not hold 256.
    enumOf(u8, { 256: "bad" }, enumOf.keep);
    // @ts-expect-error Signed bytes do not hold 128.
    enumOf(i8, { 128: "bad" }, enumOf.keep);
    // @ts-expect-error String members need string codecs.
    enumOf(u8, Tag, enumOf.reject);
    // @ts-expect-error Heterogeneous enum members cannot share a raw type.
    enumOf(u8, Mixed, enumOf.reject);
    // @ts-expect-error Numeric mapping names must be strings or booleans.
    enumOf(u8, { 1: 2 }, enumOf.reject);
    // @ts-expect-error Fallback cannot introduce a new decoded name.
    enumOf(u8, { 1: "data", 2: "ack" }, "other");
    // @ts-expect-error Fallback is a decoded name, not a raw value.
    enumOf(u8, ["data", "ack"], 0);
    const fallback = enumOf(u8, Kind, Kind.Unknown);
    expectTypeOf<Output<typeof fallback>>().toEqualTypeOf<Kind>();
  });

  it("preserve context, decode-only codecs and packing requirements", () => {
    const contextual = enumOf(string("length"), Tag, enumOf.reject);
    expectTypeOf<Context<typeof contextual>>().toEqualTypeOf<{
      length: number;
    }>();
    // @ts-expect-error Context is still needed.
    contextual.decode(new Uint8Array());
    // @ts-expect-error Raw values must be valid inputs to the inner codec.
    enumOf(asymmetric, ["data", "ack"], enumOf.reject);
    const read = enumOf(decoder, ["a", "b"], enumOf.reject);
    expectTypeOf<Input<typeof read>>().toEqualTypeOf<never>();
    // @ts-expect-error A decoder cannot encode its names.
    read.encode("a");
    // @ts-expect-error Bare bit fields cannot decode alone.
    bits(4).decode(new Uint8Array());
    // @ts-expect-error Bare bit fields cannot be array items.
    array(bits(4), 2);
    const flag = enumOf(bits(1), [false, true]);
    // @ts-expect-error Wrapping a bit field preserves its packing requirement.
    flag.encode(true);
    // @ts-expect-error Arrays do not establish a bit run.
    array(flag, 2);
    // @ts-expect-error Other wrappers preserve the packing requirement too.
    literal(bits(2), 1).decode(new Uint8Array());
    // @ts-expect-error Refinement does not make a bit field standalone.
    refine(bits(2), (v) => v > 0).encode(1);
    // @ts-expect-error Mapping does not make a bit field standalone.
    map(bits(2), { decode: String }).decode(new Uint8Array());
    const record = bin().field("flag", literal(flag, true));
    expectTypeOf<Input<typeof record>>().toEqualTypeOf<{
      flag?: true | undefined;
    }>();
  });

  it("narrow names and enum members while retaining open numeric arms", () => {
    const names = bin()
      .field("kind", enumOf(u8, ["data", "ack"], enumOf.reject))
      .field("body", match("kind").case("data", string(1)).otherwise(u8));
    expectTypeOf<Output<typeof names>>().toEqualTypeOf<
      { kind: "data"; body: string } | { kind: "ack"; body: number }
    >();
    const closed = bin()
      .field("kind", enumOf(u8, Kind, enumOf.reject))
      .field("body", match("kind").case(Kind.Data, string(1)).otherwise(u8));
    expectTypeOf<Output<typeof closed>>().toEqualTypeOf<
      | { kind: Kind.Data; body: string }
      | { kind: Kind.Unknown | Kind.Ack; body: number }
    >();
    const scalarCase = bin()
      .field("kind", enumOf(u8, Kind, enumOf.reject))
      .merge(
        match("kind")
          .case(1, bin().field("text", string(1)))
          .otherwise(bin().u8("byte")),
      );
    expectTypeOf<Output<typeof scalarCase>>().toEqualTypeOf<
      | { kind: Kind.Data; text: string }
      | { kind: Kind.Unknown | Kind.Ack; byte: number }
    >();
    const open = bin()
      .field("kind", enumOf(u8, Kind, enumOf.keep))
      .field("body", match("kind").case(Kind.Data, string(1)).otherwise(u8));
    const closedValue = closed.decode(new Uint8Array());
    if (closedValue.kind === Kind.Data) {
      expectTypeOf(closedValue.body).toEqualTypeOf<string>();
    }
    expectTypeOf<Output<typeof open>>().toEqualTypeOf<
      | { kind: Kind.Data; body: string }
      | { kind: Kind.Unknown | Kind.Ack | NonNullable<number>; body: number }
    >();
    const remainder: Output<typeof open> = { kind: 99, body: 7 };
    expectTypeOf(remainder.body).toEqualTypeOf<number>();
    const openNames = bin()
      .field("kind", enumOf(u8, { 1: "data", 2: "ack" }, enumOf.keep))
      .field("body", match("kind").case("data", string(1)).otherwise(u8));
    expectTypeOf<Output<typeof openNames>>().toEqualTypeOf<
      { kind: "data"; body: string } | { kind: "ack" | number; body: number }
    >();
    // @ts-expect-error Enum members and their scalar value are the same case.
    match("kind").case(Kind.Data, u8).case(1, u16le);
    // @ts-expect-error The reverse order is also a duplicate.
    match("kind").case(1, u8).case(Kind.Data, u16le);
  });
});
