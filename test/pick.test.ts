import { describe, expect, it } from "vitest";

import {
  array,
  bin,
  bits,
  bytes,
  lazy,
  literal,
  match,
  Reader,
  sized,
  string,
  u16le,
  u8,
  type Input,
} from "../src/index.ts";
import {
  decodes,
  decodeError,
  decodeFails,
  hex,
  type Standalone,
} from "./helpers.ts";

describe("Picked fields", () => {
  const Str = bin().u8("len").field("text", string("len"));
  const Record = bin()
    .u8("n")
    .field("items", array(Str, "n"))
    .u8("tag")
    .field("extra", match("tag").case(0, bin()).case(1, u16le))
    .field("name", string({ terminator: 0 }))
    .u8("last");
  const input = Record.encode({
    n: 2,
    items: [
      { len: 1, text: "a" },
      { len: 0, text: "" },
    ],
    tag: 1,
    extra: 513,
    name: "xyz",
    last: 9,
  });

  it("are decoded alone, stepping over the others", () => {
    const reader = new Reader(input);
    expect(reader.read(Record.pick("name", "last"))).toStrictEqual({
      name: "xyz",
      last: 9,
    });
    expect(reader.offset).toBe(input.length);
    expect(Record.pick().decode(input)).toStrictEqual({});
  });

  it("are those of the parser's fields that are named", () => {
    const Merged = bin()
      .u8("tag")
      .merge(match("tag").case(1, bin().u8("a")).case(2, bin().u8("b")));
    expect(Merged.fields).toStrictEqual(["tag", "a", "b"]);
    const wanted = new Set(["b", "c"]);
    const Picked = Merged.pick(...Merged.fields.filter((n) => wanted.has(n)));
    expect(Picked.fields).toStrictEqual(["b"]);
    expect(Picked.decode(hex("02 07"))).toStrictEqual({ b: 7 });
  });

  it("follow values of lengths from functions", () => {
    const parser = bin()
      .u8("n")
      .field(
        "data",
        bytes((o) => o.n * 2),
      )
      .u8("after");
    expect(parser.pick("after").decode(hex("01 0506 09"))).toStrictEqual({
      after: 9,
    });
  });

  it("check the fields they step over", () => {
    const parser = bin()
      .field("header", bin().field("magic", literal(u8, 1)))
      .u8("a");
    expect(() => parser.pick("a").decode(hex("02 00"))).toThrow(
      /expected 1, got 2 in `header.magic` at offset 0/u,
    );
  });

  it.each([1, 2])(
    "keep the fields that later fields read, from merged case %i",
    async (tag) => {
      const group = bin()
        .u8("tag")
        .merge(match("tag").case(1, bin().u8("n")).case(2, bin().u8("n")))
        .pick("n");
      const parser = bin().merge(group).field("data", bytes("n"));
      const wire = Uint8Array.of(tag, 1, 7);
      await decodes(parser.pick("data"), wire, { data: Uint8Array.of(7) });
      expect(parser.pick().decode(wire)).toStrictEqual({});
      expect(parser.pick("n").decode(wire)).toStrictEqual({ n: 1 });
    },
  );

  it("keep the fields that later functions read, from nested merged cases", () => {
    const group = bin()
      .u8("outer")
      .merge(
        match("outer").case(
          1,
          bin()
            .u8("tag")
            .merge(match("tag").case(1, bin().u8("n")).case(2, bin().u8("n"))),
        ),
      )
      .pick("n");
    const parser = bin()
      .merge(group)
      .field(
        "data",
        bytes((o) => o.n),
      );
    const wire = Uint8Array.of(1, 2, 1, 7);
    expect(parser.pick().decode(wire)).toStrictEqual({});
    expect(parser.pick("data").decode(wire)).toStrictEqual({
      data: Uint8Array.of(7),
    });
  });

  // Fixed-size parts are checked at once, also when they are stepped over.
  const child = bin()
    .u8("n")
    .field("data", sized(1, bytes("n")));

  it.each<[name: string, field: Standalone, path: (string | number)[]]>([
    ["parsers", child, ["inner", "data"]],
    ["arrays", array(child, 1), ["inner", 0, "data"]],
  ])("follow regions checked in %s stepped over", async (_, field, path) => {
    const parser = bin().u8("head").field("inner", field).pick();
    expect(parser.decode(Uint8Array.of(9, 1, 0))).toStrictEqual({});
    await decodeFails(parser, "09 02 00", {
      code: "invalid",
      offset: 2,
      path,
    });
  });

  it("follow items too big for their regions, in arrays stepped over", () => {
    const parser = bin()
      .field("data", array(sized(1, bytes(2)), 1))
      .pick();
    expect(() => parser.decode(Uint8Array.of(0))).toThrow(decodeError({}));
  });
});

// Cases have literal defaults (through `sized` and `lazy`) and computed bit fields.
const groups = (bitOrder: "msb" | "lsb") => {
  const plain = bin({ bitOrder })
    .field("a", bits(3))
    .field("b", bits(9))
    .field(
      "len",
      literal(
        sized(
          1,
          lazy(() => u8),
        ),
        2,
      ),
    )
    .field("payload", bytes("len"));
  const computed = plain.computed("b", () => 31);
  const full = bin()
    .u8("n")
    .field("hidden", bytes("n"))
    .u8("tag")
    .merge(
      match("tag")
        .case(0, plain)
        .case(1, computed)
        .otherwise(
          bin()
            .u8("subtag")
            .merge(match("subtag").case(0, computed).otherwise(plain)),
        ),
    )
    .field(
      "check",
      bytes((o) => o.a + o.len),
    );
  // An outer parser with a field of the same name as one of the group.
  const outer = bin()
    .u8("n")
    .merge(full.pick("a", "b", "len"))
    .field("tail", bytes("n"))
    .field(
      "after",
      bytes((o) => o.len),
    );
  return { full, outer };
};

describe("Picked groups of nested cases", () => {
  const fields = {
    n: 2,
    hidden: Uint8Array.of(98, 99),
    a: 1,
    payload: Uint8Array.of(7, 8),
    check: Uint8Array.of(3, 4, 5),
  };

  describe.each(["msb", "lsb"] as const)(
    "with bit fields, %s first",
    (bitOrder) => {
      const { full, outer } = groups(bitOrder);

      it.each<[name: string, input: Input<typeof full>]>([
        ["a plain case", { ...fields, tag: 0, b: 31 }],
        ["a computing case", { ...fields, tag: 1 }],
        ["a nested computing case", { ...fields, tag: 2, subtag: 0 }],
        ["a nested plain case", { ...fields, tag: 2, subtag: 1, b: 31 }],
      ])("fill in defaults and keep picked fields, in %s", async (_, input) => {
        const wire = full.encode(input);
        expect(full.decode(wire)).toStrictEqual({
          ...fields,
          b: 31,
          len: 2,
          ...input,
        });
        const extended = Uint8Array.of(1, ...wire, 55, 66, 77);
        const decoded = {
          n: 1,
          a: 1,
          b: 31,
          len: 2,
          tail: Uint8Array.of(55),
          after: Uint8Array.of(66, 77),
        };
        await decodes(outer, extended, decoded);
        for (const keys of [
          [],
          ["tail"],
          ["after"],
          ["len", "after"],
        ] as const) {
          const expected = Object.fromEntries(keys.map((k) => [k, decoded[k]]));
          await decodes(outer.pick(...keys), extended, expected);
        }
      });
    },
  );
});
