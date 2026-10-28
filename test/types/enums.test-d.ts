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
declare const decoder: Codec<number, never>;
declare const dynamic: string[];
declare const numeric: Record<number, string>;
declare const named: Record<string, number>;
declare enum Bit {
  Off = 0,
  On = 1,
}
/** The names `v0` to `v${N - 1}`, in order. */
type Names<N extends number, T extends string[] = []> = T["length"] extends N
  ? T
  : Names<N, [...T, `v${T["length"]}`]>;
/** The values of five bits, 0 to 31. */
type Five = Domain<ReturnType<typeof bits<5>>>;
declare const tuple32: Readonly<Names<32>>;
declare const tuple64: Readonly<Names<64>>;
declare const tuple128: Readonly<Names<128>>;
declare const tuple256: Readonly<Names<256>>;
declare const numeric32: { readonly [N in Five]: `v${N}` };
declare const named32: { readonly [N in Five as `V${N}`]: N };

describe("Enum types", () => {
  it("infer inline literals and keep the raw codec's output unchanged", () => {
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

  it("prove complete tables in every form only through five bits", () => {
    const tuple = enumOf(bits(5), tuple32);
    const keys = enumOf(bits(5), numeric32);
    const members = enumOf(bits(1), Bit);
    const object = enumOf(bits(5), named32);
    expectTypeOf<Output<typeof tuple>>().toEqualTypeOf<
      (typeof tuple32)[number]
    >();
    expectTypeOf<Output<typeof keys>>().toEqualTypeOf<`v${Five}`>();
    expectTypeOf<Output<typeof members>>().toEqualTypeOf<Bit>();
    expectTypeOf<Output<typeof object>>().toEqualTypeOf<Five>();
    expectTypeOf<Domain<ReturnType<typeof bits<6>>>>().toEqualTypeOf<unknown>();
    expectTypeOf<Domain<typeof u8>>().toEqualTypeOf<unknown>();
    expectTypeOf<Domain<typeof i8>>().toEqualTypeOf<unknown>();
    enumOf(bits(2), { A: 0, B: 1, C: 2, D: 3 });
    enumOf(bits(2), { 0: "a", 1: "b", 2: "c", 3: "d" });
    // Aliases do not invalidate complete coverage.
    enumOf(bits(1), { No: 0, Yes: 1, AlsoYes: 1 });
    const eight = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
    enumOf(bits(3), eight);
    enumOf(bits(4), [...eight, "i", "j", "k", "l", "m", "n", "o", "p"]);
    expectTypeOf<Domain<ReturnType<typeof bits<3>>>>().toEqualTypeOf<
      0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
    >();
    expectTypeOf<Domain<ReturnType<typeof bits<4>>>>().toEqualTypeOf<
      0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15
    >();
    // @ts-expect-error Static coverage stops at 32 values, even for a full tuple.
    enumOf(bits(6), tuple64);
    // @ts-expect-error Seven-bit coverage also needs an explicit policy.
    enumOf(bits(7), tuple128);
    // @ts-expect-error Eight-bit coverage also needs an explicit policy.
    enumOf(bits(8), tuple256);
    // @ts-expect-error Complete byte tables are not statically proven.
    enumOf(u8, tuple256);
    // @ts-expect-error Signed byte tables are not statically proven.
    enumOf(i8, numeric);
    enumOf(bits(6), tuple64, enumOf.reject);
    enumOf(u8, tuple256, enumOf.keep);
  });

  it("require policies for unknown coverage", () => {
    declareWidthCases();
    // @ts-expect-error A named object is missing raw 31.
    enumOf(bits(5), {} as Omit<typeof named32, "V31">);
    // @ts-expect-error A numeric-key object is missing raw 31.
    enumOf(bits(5), {} as Omit<typeof numeric32, 31>);
    // @ts-expect-error This numeric enum does not name raw 3.
    enumOf(bits(2), Kind);
    // @ts-expect-error These members might both name zero.
    enumOf(bits(1), {} as { No: 0 | 1; Yes: 0 | 1 });
    // @ts-expect-error The object might omit raw 1.
    enumOf(bits(1), {} as { 0: "no" } | { 0: "no"; 1: "yes" });
    // @ts-expect-error The named object might omit raw 1.
    enumOf(bits(1), {} as { No: 0 } | { No: 0; Yes: 1 });
    // @ts-expect-error Widened member values do not prove coverage.
    enumOf(bits(1), {} as { No: number; Yes: number });
    // @ts-expect-error A tuple union is not covered for every possible table.
    enumOf(
      bits(2),
      [] as unknown as readonly ["a", "b"] | readonly ["a", "b", "c", "d"],
    );
    // @ts-expect-error The width could be outside the bounded domains.
    enumOf(bits(mixedWidth), ["off", "on"]);
    // @ts-expect-error Raw 3 has no name.
    enumOf(bits(2), ["low", "normal", "high"]);
    // @ts-expect-error Wider bit domains are not enumerated.
    enumOf(bits(9), ["low", "normal"]);
    // @ts-expect-error Wider numeric codecs always require a policy.
    enumOf(u16le, numeric32);
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

  it("check raw types and fallback membership without widening", () => {
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

function declareWidthCases() {
  const width = 1 as 1 | 2;
  // @ts-expect-error Two names cannot cover the possible two-bit width.
  enumOf(bits(width), ["off", "on"]);
  // @ts-expect-error The named table does not cover the possible two-bit width.
  enumOf(bits(width), { No: 0, Yes: 1 });
  // @ts-expect-error The keys do not cover the possible two-bit width.
  enumOf(bits(width), { 0: "off", 1: "on" });
}
