import { describe, expectTypeOf, it } from "vitest";

import {
  array,
  bin,
  bits,
  custom,
  fail,
  lazy,
  literal,
  map,
  optional,
  refine,
  u32le,
  u8,
  when,
  type Codec,
  type Context,
  type Input,
  type Output,
} from "../../src/index.ts";

const Ref = bin().u32le("row").u32le("uid");
const FmDate = map(bin().u16le("day").u16le("year"), {
  decode: (d) => (d.year === 1900 ? null : `${d.year}-${d.day}`),
  encode: (iso: string | null) => ({
    day: 1,
    year: iso === null ? 1900 : Number(iso.slice(0, 4)),
  }),
});

describe("Output and Input", () => {
  it("follow fields, nested parsers and conversions", () => {
    const Player = bin()
      .u8("version")
      .field("x08", optional(u8, fail("unsupported")))
      .field("pairs", array(bin().u8("a").u8("b"), u32le))
      .field("magic", literal(u32le, 0x46))
      .field("born", FmDate)
      .field("club", Ref);
    expectTypeOf<Output<typeof Player>>().toEqualTypeOf<{
      version: number;
      x08: null;
      pairs: { a: number; b: number }[];
      magic: 0x46;
      born: string | null;
      club: { row: number; uid: number };
    }>();
  });

  it("are unions for parts that depend on a condition", () => {
    const full = Math.random() > 0.5;
    const Person = bin()
      .u32le("id")
      .merge(full ? bin().u32le("serverId") : bin())
      .u8("tail");
    expectTypeOf<Output<typeof Person>>().toEqualTypeOf<
      | { id: number; serverId: number; tail: number }
      | { id: number; tail: number }
    >();
    const Either = (full ? bin().u8("a") : bin().u8("b")).field("c", u8);
    expectTypeOf<Output<typeof Either>>().toEqualTypeOf<
      { a: number; c: number } | { b: number; c: number }
    >();
    const Versioned = bin()
      .u8("version")
      .field(
        "ext",
        when((o) => o.version >= 2, bin().u8("x")),
      );
    expectTypeOf<Output<typeof Versioned>>().toEqualTypeOf<{
      version: number;
      ext: { x: number } | null;
    }>();
    const Flagged = bin().u8("hasExt").field("ext", when("hasExt", u8));
    expectTypeOf<Output<typeof Flagged>>().toEqualTypeOf<{
      hasExt: number;
      ext: number | null;
    }>();
  });

  it("have no Input for values decoded without an encoder", () => {
    const People = array(
      bin()
        .u8("id")
        .field("born", map(Ref, { decode: (r) => r.row })),
      u32le,
    );
    expectTypeOf<Output<typeof People>>().toEqualTypeOf<
      { id: number; born: number }[]
    >();
    // @ts-expect-error `born` has no encoder.
    People.encode([{ id: 1, born: 1 }]);
    const DecodeOnly = literal(map(u8, { decode: (n) => n }), 1);
    // @ts-expect-error A literal does not add an encoder.
    DecodeOnly.encode(1);
    const Decoder = custom({
      decode: (b) => ({ value: b.length, bytesRead: b.length }),
    });
    // @ts-expect-error The codec has no encoder.
    Decoder.encode(1);
  });

  it("of custom codecs come from their functions", () => {
    const Byte = custom({
      size: 1,
      decode: (b) => (b.length > 0 ? { value: b[0], bytesRead: 1 } : undefined),
      encode: (n: number) => Uint8Array.of(n),
    });
    expectTypeOf<Output<typeof Byte>>().toEqualTypeOf<number>();
    expectTypeOf<Input<typeof Byte>>().toEqualTypeOf<number>();
  });

  it("of refinements are narrowed by a type guard", () => {
    const Status = refine(u8, (n): n is 1 | 2 => n === 1 || n === 2);
    expectTypeOf<Output<typeof Status>>().toEqualTypeOf<1 | 2>();
    expectTypeOf<Input<typeof Status>>().toEqualTypeOf<1 | 2>();
  });

  it("of refined codecs must be the same", () => {
    refine(FmDate, (d) => d !== null);
    refine(
      // @ts-expect-error The codec encodes strings that it never decodes.
      map(u8, {
        decode: (n) => (n ? "y" : "n"),
        encode: (s: string) => s.length,
      }),
      (s) => s === "y",
    );
  });

  it("of recursive codecs need no outer fields", () => {
    interface Tree {
      children: Tree[];
    }
    interface TreeInput {
      children: readonly TreeInput[];
    }
    const Tree: Codec<Tree, TreeInput> = bin().field(
      "children",
      array(
        lazy(() => Tree),
        u8,
      ),
    );
    expectTypeOf<Context<typeof Tree>>().toEqualTypeOf<unknown>();
    expectTypeOf<Input<typeof Tree>>().toEqualTypeOf<TreeInput>();
  });
});

describe("Bit codecs", () => {
  it("infer number inputs and outputs and retain width constraints", () => {
    const field = bits(53);
    expectTypeOf<Output<typeof field>>().toEqualTypeOf<number>();
    expectTypeOf<Input<typeof field>>().toEqualTypeOf<number>();
    const record = bin().field("a", bits(1)).field("b", field);
    expectTypeOf<Output<typeof record>>().toEqualTypeOf<{
      a: number;
      b: number;
    }>();
    expectTypeOf<Input<typeof record>>().toEqualTypeOf<{
      a: number;
      b: number;
    }>();
    // @ts-expect-error Zero bits is not a field.
    bits(0);
    // @ts-expect-error Numbers have at most 53 bits.
    bits(54);
    // @ts-expect-error Widths are integers.
    bits(1.5);
    // @ts-expect-error Unconstrained numbers need a width check.
    bits(Number("3"));
    // @ts-expect-error Bit fields encode numbers.
    record.encode({ a: "1", b: 2 });
    // @ts-expect-error Bit fields remain required.
    record.encode({ a: 1 });
    // @ts-expect-error Bit fields use field(name, bits(width)).
    bin().bits("a", 3);
  });
});
