import { describe, expect, it, vi } from "vitest";

import {
  array,
  bin,
  bits,
  custom,
  enumOf,
  i8,
  literal,
  map,
  match,
  refine,
  string,
  trace,
  u8,
  u16le,
  u64le,
  type AnyCodec,
  type Codec,
} from "../src/index.ts";
import { decodeFails, encodeFails, hex, roundtrip } from "./helpers.ts";

// The JavaScript shape emitted by TypeScript for numeric enums, including aliases.
const Kind = {
  0: "Unknown",
  1: "Data",
  2: "Ack",
  Unknown: 0,
  Data: 1,
  Ack: 2,
} as const;
const Alias = { 1: "B", A: 1, B: 1 } as const;
// Definition errors must also protect JavaScript callers.
const define = enumOf as unknown as (
  codec: AnyCodec,
  table: unknown,
  policy?: unknown,
) => Codec;

describe("Enums", () => {
  it("keep policy sentinels distinct from ordinary fallback names", () => {
    expect(enumOf.reject).toBeTypeOf("symbol");
    expect(enumOf.keep).toBeTypeOf("symbol");
    expect(enumOf.reject).not.toBe(enumOf.keep);
    const codec = enumOf(u8, ["reject", "keep"], "keep");
    expect(codec.decode(hex("ff"))).toBe("keep");
    expect(() => define(u8, ["reject", "keep"], Symbol("enumOf.keep"))).toThrow(
      /fallback/u,
    );
  });

  it("keep wrapper packing across merges and variable-size enum conventions", async () => {
    const packed = bin()
      .field("head", bits(3))
      .merge(
        bin().field("kind", enumOf(bits(2), ["data", "ack"], enumOf.reject)),
      )
      .field("tail", bits(3));
    await roundtrip(packed, "2a", { head: 1, kind: "ack", tail: 2 });
    expect(packed.size).toBe(1);
    const tag = enumOf(string(u8), { A: "a", Longer: "long" }, enumOf.reject);
    await roundtrip(tag, "04 6c 6f 6e 67", "long");
    const fixed = define(u8, ["data", "ack"], enumOf.reject);
    expect(fixed.sizeOf("unknown")).toBe(1);
  });

  it("keep packed checks when an enclosing fixed-size array is not picked", async () => {
    const item = bin()
      .field("kind", enumOf(bits(2), ["data", "ack"], enumOf.reject))
      .field("rest", bits(6));
    const outer = bin()
      .field("items", array(item, 2))
      .u8("after")
      .pick("after");
    await decodeFails(outer, "00 c0 09", {
      code: "invalid",
      path: ["items", 1, "kind"],
      offset: 1,
    });
  });

  it("round-trip dense, sparse, signed, boolean and identity mappings", async () => {
    await roundtrip(
      enumOf(u8, ["low", "normal", "high"], enumOf.reject),
      "01",
      "normal",
    );
    await roundtrip(
      enumOf(u8, { 1: "data", 2: "ack", 63: "error" }, enumOf.reject),
      "3f",
      "error",
    );
    await roundtrip(
      enumOf(i8, { [-1]: "negative", 0: "zero" }, enumOf.reject),
      "ff",
      "negative",
    );
    await roundtrip(enumOf(u8, [false, true], enumOf.reject), "00", false);
    await roundtrip(enumOf(u8, Kind, enumOf.reject), "01", Kind.Data);
    await roundtrip(enumOf(u8, Alias, enumOf.reject), "01", Alias.A);
    await roundtrip(
      enumOf(string(4), { Data: "DATA", Ack: "ACK!" }, enumOf.reject),
      "44 41 54 41",
      "DATA",
    );
    await roundtrip(
      enumOf(u64le, { A: 1n, B: 2n }, enumOf.reject),
      "02 00 00 00 00 00 00 00",
      2n,
    );
  });

  it("keep unknown raw values and use the inner encoder's checks", async () => {
    const open = enumOf(u8, { 1: "data", 2: "ack" }, enumOf.keep);
    await roundtrip(open, "1f", 31);
    expect(open.decode(open.encode(1))).toBe("data");
    encodeFails(open, "other", /unknown value other/u);
    encodeFails(open, 256, /expected u8/u);
    encodeFails(open, -1, /expected u8/u);
    const tag = enumOf(string(4), { Data: "DATA" }, enumOf.keep);
    await roundtrip(tag, "41 43 4b 21", "ACK!");
    encodeFails(tag, "short", /length/u);
    await roundtrip(
      enumOf(u64le, { A: 1n }, enumOf.keep),
      "02 00 00 00 00 00 00 00",
      2n,
    );
  });

  it("fallback to a declared value and re-encode its canonical raw value", async () => {
    const kind = enumOf(u8, Kind, Kind.Unknown);
    expect(kind.decode(hex("ff"))).toBe(Kind.Unknown);
    expect([...kind.encode(kind.decode(hex("ff")))]).toStrictEqual([0]);
    encodeFails(kind, 255, /unknown value 255/u);
    const flag = enumOf(u8, [false, true], false);
    expect(flag.decode(hex("ff"))).toBe(false);
    const name = enumOf(u8, { 7: "unknown", 8: "data" }, "unknown");
    expect([...name.encode(name.decode(hex("ff")))]).toStrictEqual([7]);
    await roundtrip(name, "08", "data");
  });

  it("locate validation at the start of the field, even under pick and in streams", async () => {
    const kind = enumOf(u16le, ["data", "ack"], enumOf.reject);
    const record = bin().u8("prefix").field("kind", kind).u8("after");
    for (const codec of [record, record.pick("after")]) {
      await decodeFails(codec, "00 03 00 07", {
        code: "invalid",
        path: ["kind"],
        offset: 1,
        message: /unknown value 3/u,
      });
    }
    await decodeFails(array(record, 2), "00 01 00 07 00 03 00 07", {
      code: "invalid",
      path: [1, "kind"],
      offset: 5,
    });
    encodeFails(
      record,
      { prefix: 0, kind: "typo", after: 7 },
      /unknown value typo in `kind`/u,
    );
    expect(record.sizeOf({ prefix: 0, kind: "data", after: 7 })).toBe(4);
  });

  it.each(["msb", "lsb"] as const)(
    "pack wrapped and bare bits in one %s run",
    async (bitOrder) => {
      const record = bin({ bitOrder })
        .field("head", bits(7))
        .field(
          "kind",
          enumOf(bits(2), ["low", "normal", "high"], enumOf.reject),
        )
        .field("tail", bits(7))
        .u8("after");
      const value = { head: 0, kind: "high" as const, tail: 0, after: 9 };
      const wire = bitOrder === "msb" ? "01 00 09" : "00 01 09";
      await roundtrip(record, wire, value);
      expect(record.size).toBe(3);
      expect(record.pick("kind", "after").decode(hex(wire))).toStrictEqual({
        kind: "high",
        after: 9,
      });
      expect(trace(record, hex(wire))).toStrictEqual([
        { path: ["head"], start: 0, end: 2, value: 0 },
        { path: ["kind"], start: 0, end: 2, value: "high" },
        { path: ["tail"], start: 0, end: 2, value: 0 },
        { path: ["after"], start: 2, end: 3, value: 9 },
      ]);
    },
  );

  it("report the byte of a packed field's start and keep checks under pick", async () => {
    const record = bin()
      .u8("prefix")
      .field("head", bits(9))
      .field("kind", enumOf(bits(2), ["low", "normal", "high"], enumOf.reject))
      .field("tail", bits(5))
      .u8("after");
    for (const codec of [record, record.pick("after")]) {
      await decodeFails(codec, "00 00 60 09", {
        code: "invalid",
        path: ["kind"],
        offset: 2,
        message: /unknown value 3/u,
      });
    }
    await decodeFails(record, "00 00", {
      code: "end-of-input",
      path: ["head"],
      offset: 1,
    });
    encodeFails(
      record,
      { prefix: 0, head: 0, kind: "typo", tail: 0, after: 9 },
      /in `kind`/u,
    );
  });

  it("supply literal inputs and expose decoded names to computed and later fields", async () => {
    const kind = enumOf(bits(2), ["data", "ack"], enumOf.reject);
    const record = bin()
      .field("kind", literal(kind, "data"))
      .field("flags", bits(6))
      .field("body", match("kind").case("data", string(1)));
    await roundtrip(
      record,
      "01 41",
      { kind: "data", flags: 1, body: "A" },
      { flags: 1, body: "A" },
    );
    const computed = bin()
      .field("kind", kind)
      .field("flags", bits(6))
      .field(
        "body",
        string((o) => (o.kind === "data" ? 1 : 2)),
      )
      .computed("kind", (o) => (o.body.length === 1 ? "data" : "ack"));
    await roundtrip(
      computed,
      "42 41 42",
      { kind: "ack", flags: 2, body: "AB" },
      { flags: 2, body: "AB" },
    );
  });

  it("pack nested map, literal and refine wrappers without losing checks or defaults", async () => {
    const mapped = map(bits(2), {
      decode: (v) => v + 1,
      encode: (v: number) => v - 1,
    });
    const record = bin()
      .field("one", literal(mapped, 2))
      .field(
        "positive",
        refine(bits(2), (v) => v > 0, "positive"),
      )
      .field("rest", bits(4));
    await roundtrip(
      record,
      "63",
      { one: 2, positive: 2, rest: 3 },
      { positive: 2, rest: 3 },
    );
    await decodeFails(record.pick("rest"), "43", {
      code: "invalid",
      path: ["positive"],
      offset: 0,
    });
    const conversion = vi.fn<(v: number) => number>((v: number) => v + 1);
    const picked = bin()
      .field("skip", map(bits(4), { decode: conversion }))
      .field("want", bits(4))
      .pick("want");
    expect(picked.decode(hex("12"))).toStrictEqual({ want: 2 });
    expect(conversion).not.toHaveBeenCalled();
  });

  it("take their tables when defined, with any names", async () => {
    const source = { Data: 2 };
    const record = enumOf(u8, source, enumOf.reject);
    source.Data = 3;
    await roundtrip(record, "02", 2);
    await roundtrip(
      enumOf(u8, { 1: "__proto__", 2: "constructor" }, enumOf.reject),
      "01",
      "__proto__",
    );
    // Keys that are not how a number is written are names.
    await roundtrip(
      enumOf(string(1), { "01": "a", "0x1": "b" }, enumOf.reject),
      "61",
      "a",
    );
  });

  it("reject tables that are not one-to-one", () => {
    expect(() => define(u8, { 1: "missing", Data: 2 }, enumOf.reject)).toThrow(
      "enumOf: 1 is not the value of a member",
    );
    expect(() => enumOf(u8, { 1: "data", 2: "data" }, enumOf.reject)).toThrow(
      'enumOf: duplicate name "data" for raw values 1 and 2',
    );
    const holes: string[] = ["a"];
    holes.length = 3;
    expect(() => enumOf(u8, holes, enumOf.reject)).toThrow(/array hole at 1/u);
    expect(() => define(u8, [], enumOf.reject)).toThrow("enumOf: no values");
    expect(() => define(u8, { 1: "data" }, "other")).toThrow(
      'enumOf: fallback "other" is not one of the values',
    );
  });

  it("need a policy unless every raw value has a name, and fit the codec", () => {
    expect(() => define(bits(2), ["low", "normal", "high"])).toThrow(
      "enumOf: a policy is needed: bits(2) value 3 has no name (enumOf.reject, enumOf.keep or a fallback value)",
    );
    expect(() => define(u16le, ["a", "b"])).toThrow(/a policy is needed/u);
    const complete = Array.from({ length: 256 }, (_, i) => `v${i}`);
    expect(define(u8, complete).decode(hex("ff"))).toBe("v255");
    const signed = Object.fromEntries(
      complete.map((name, i) => [i - 128, name]),
    );
    expect(define(i8, signed).decode(hex("80"))).toBe("v0");
    expect(() => define(bits(2), { 5: "bad" }, enumOf.reject)).toThrow(
      "enumOf: raw value 5 is outside bits(2), which holds 0..3",
    );
    expect(() => define(u16le, { 65_536: "bad" }, enumOf.keep)).toThrow(
      RangeError,
    );
  });

  it.each<[codec: AnyCodec, table: unknown]>([
    [bits(1), ["a", "b", "c"]],
    [bits(1), { A: 2 }],
    [u8, { Bad: 256 }],
    [u8, { 256: "bad" }],
    [i8, { 128: "bad" }],
  ])(
    "check bounds at definition time with every policy (%#)",
    (codec, table) => {
      for (const policy of [undefined, enumOf.reject, enumOf.keep, "bad"]) {
        expect(() => define(codec, table, policy)).toThrow(RangeError);
      }
    },
  );

  it.each([
    ["numeric", { 0: 1 }, /names must be strings or booleans/u],
    ["named", { Yes: true }, /members must be numbers, strings or bigints/u],
  ])("reject invalid %s table values", (_, table, message) => {
    expect(() => define(u8, table, enumOf.reject)).toThrow(message);
  });

  it.each(["tuple", "numeric", "named"])(
    "recognize complete 32-value %s tables at runtime",
    async (form) => {
      const names = Array.from({ length: 32 }, (_, i) => `v${i}`);
      const table = (values: readonly string[]) =>
        form === "tuple"
          ? values
          : Object.fromEntries<string | number>(
              values.map((name, i) =>
                form === "numeric" ? [i, name] : [name, i],
              ),
            );
      const codec = bin().field("value", define(bits(5), table(names)));
      await roundtrip(codec, "f8", { value: form === "named" ? 31 : "v31" });
      expect(() => define(bits(5), table(names.slice(0, -1)))).toThrow(
        /value 31 has no name/u,
      );
    },
  );

  it("preserve decode-only and contextual inner codecs", async () => {
    const read = custom({
      size: 1,
      decode: (b) => ({ value: b[0], bytesRead: 1 }),
    });
    const codec = enumOf(read, ["data", "ack"], enumOf.reject);
    expect(codec.decode(hex("01"))).toBe("ack");
    encodeFails(codec, "data", /only be decoded/u);
    const contextual = bin()
      .u8("length")
      .field(
        "kind",
        enumOf(string("length"), { A: "AA", B: "BBB" }, enumOf.reject),
      );
    await roundtrip(contextual, "03 42 42 42", { length: 3, kind: "BBB" });
    encodeFails(contextual, { length: 2, kind: "BBB" }, /in `kind`/u);
  });
});
