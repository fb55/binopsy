import { describe, expect, it } from "vitest";

import {
  array,
  bin,
  i32le,
  literal,
  match,
  string,
  u16be,
  u16le,
  u8,
  type Codec,
} from "../src/index.ts";
import {
  decodeFails,
  encodeFails,
  hex,
  roundtrip,
  type Failure,
  type Standalone,
} from "./helpers.ts";

const Pair = bin().u8("key").i16le("value");

/** A parser with the fields of the case of `kind`, which a later field reads. */
const Record = bin()
  .u8("kind")
  .merge(
    match("kind")
      .case(1, bin().u8("length").field("text", string("length")))
      .case(2, bin().u8("length").u16le("id")),
  )
  .field("tail", string("length"));

/** A merged match of a parser, of which a field fails. */
const Flat = bin()
  .u8("kind")
  .merge(match("kind").case(1, bin().field("magic", literal(u8, 5))));

describe("Matches", () => {
  it.each<[name: string, codec: Standalone, bytes: string, value: unknown]>([
    [
      "pick a case by a number tag",
      bin()
        .u8("tag")
        .field(
          "value",
          match("tag").case(0, i32le).case(1, Pair).case(2, bin()),
        )
        .u8("after"),
      "01 05 0600 07",
      { tag: 1, value: { key: 5, value: 6 }, after: 7 },
    ],
    [
      "pick a case by a string tag",
      bin()
        .field("tag", string(1))
        .field("value", match("tag").case("a", u8).case("1", u16be)),
      "31 0102",
      { tag: "1", value: 0x0102 },
    ],
    [
      "pick a case by a bigint tag",
      bin().u64le("id").field("v", match("id").case(1n, u8)),
      "0100000000000000 07",
      { id: 1n, v: 7 },
    ],
    [
      "pick a case by a boolean tag",
      bin()
        .u8("n")
        .field(
          "v",
          match((o: { n: number }) => o.n > 0)
            .case(true, u8)
            .case(false, u16le),
        ),
      "00 0800",
      { n: 0, v: 8 },
    ],
    [
      "pick a default case, and cases by computed tags",
      bin()
        .u8("tag")
        .field("v", match("tag").case(1, u8).otherwise(u16le))
        .u8("x")
        .field(
          "w",
          match((o: { x: number }) => (o.x > 5 ? "big" : "small"))
            .case("big", u16le)
            .case("small", u8),
        ),
      "02 0300 09 0400",
      { tag: 2, v: 3, x: 9, w: 4 },
    ],
    // `1` and `"1"` are different.
    [
      "tell number tags from string cases",
      bin()
        .u8("n")
        .field(
          "v",
          match((o: { n: number }) => o.n)
            .case("1" as never, u8)
            .otherwise(u16le),
        ),
      "01 0701",
      { n: 1, v: 0x0107 },
    ],
    [
      "tell string tags from number cases",
      bin()
        .field("tag", string(1))
        .field(
          "v",
          match("tag")
            .case(1 as never, u8)
            .otherwise(u16le),
        ),
      "31 0701",
      { tag: "1", v: 0x0107 },
    ],
    [
      "merge the fields of a parser case, which later fields read",
      Record,
      "01 02 6869 6162",
      { kind: 1, length: 2, text: "hi", tail: "ab" },
    ],
    [
      "merge the fields of another parser case, which later fields read",
      Record,
      "02 01 0203 78",
      { kind: 2, length: 1, id: 0x0302, tail: "x" },
    ],
  ])("%s", (_, codec, bytes, value) => roundtrip(codec, bytes, value));

  it("are stepped over to pick the fields after them", () => {
    expect(
      Record.pick("kind", "tail").decode(hex("02 01 0203 78")),
    ).toStrictEqual({ kind: 2, tail: "x" });
  });

  it.each<[name: string, codec: Standalone, bytes: string, failure: Failure]>([
    [
      "locate errors in merged cases without the match",
      Flat,
      "01 06",
      { path: ["magic"], offset: 1 },
    ],
    [
      "locate errors in nested cases",
      bin()
        .u8("kind")
        .field(
          "body",
          match("kind").case(1, bin().field("magic", literal(u8, 5))),
        ),
      "01 06",
      { path: ["body", "magic"], offset: 1 },
    ],
    [
      "fail for tags without a case",
      bin().u8("t").field("v", match("t").case(0, u8)),
      "02 00",
      { code: "no-match", path: ["v"], message: /no case for 2 in `v`/u },
    ],
    [
      "fail for tags without a merged case",
      Flat,
      "02",
      { code: "no-match", offset: 1 },
    ],
  ])("%s", (_, codec, bytes, failure) => decodeFails(codec, bytes, failure));

  it.each<[name: string, codec: Standalone, value: unknown, message: RegExp]>([
    [
      "fail for tags without a case when encoding",
      bin().u8("t").field("v", match("t").case(0, u8)),
      { t: 1, v: 0 },
      /no case for 1 in `v`/u,
    ],
    [
      "fail for tags without a merged case when encoding",
      Flat,
      { kind: 3 },
      /no case for 3/u,
    ],
  ])("%s", (_, codec, value, message) => encodeFails(codec, value, message));

  it.each<[name: string, tag: unknown]>([
    ["NaN", Number.NaN],
    ["a bigint", 4n],
  ])("fall back for computed tags of %s", (_, tag) => {
    const parser = match(() => tag as number).otherwise(u8);
    expect(parser.decode(Uint8Array.of(7))).toBe(7);
    expect(parser.encode(7)).toStrictEqual(Uint8Array.of(7));
  });

  it.each<[name: string, tag: unknown]>([
    ["undefined", undefined],
    ["an object", {}],
  ])("reject computed tags of %s, even with a default", async (_, tag) => {
    const parser = bin()
      .u8("head")
      .field("value", match(() => tag as number).otherwise(u8));
    await decodeFails(parser, "00 07", {
      code: "invalid",
      path: ["value"],
      offset: 1,
    });
    expect(() => parser.encode({ head: 0, value: 7 })).toThrow(
      expect.objectContaining({ name: "EncodeError", path: ["value"] }),
    );
  });

  // Errors of the computed tag of a merged match are located at the record that contains it.
  describe.each([
    ["after a byte", false],
    ["after bit fields", true],
  ] as const)("merged %s", (_, bits) => {
    const cause = new Error("selector failed");
    describe.each([
      ["is invalid", false],
      ["throws", true],
    ] as const)("with a computed tag that %s", (_how, throws) => {
      const parser = (bits ? bin().bits("head", 3) : bin().u8("head")).merge(
        match((): number => {
          if (throws) throw cause;
          return {} as never;
        }).otherwise(bin().u8("value")),
      );

      it.each([
        ["", false],
        [", in an array", true],
      ] as const)(
        "locate its errors at the record%s",
        async (_where, nested) => {
          const codec: Codec<unknown, never> = nested
            ? bin().field("rows", array(parser, 1))
            : parser;
          const path = nested ? ["rows", 0] : [];
          await decodeFails(codec, "00 07", {
            code: throws ? "error" : "invalid",
            offset: 1,
            path,
            ...(throws && { cause }),
          });
          const value = { head: 0, value: 7 };
          expect(() =>
            (codec as Codec<unknown, unknown>).encode(
              nested ? { rows: [value] } : value,
            ),
          ).toThrow(
            expect.objectContaining({
              name: "EncodeError",
              path,
              ...(throws && { cause }),
            }),
          );
        },
      );
    });
  });

  // Cases are picked as by `===`, for which -0 is 0.
  it("have one case for 0 and -0", () => {
    expect(() =>
      match("t")
        .case(0, u8)
        .case(-0 as never, u8),
    ).toThrow(/0 already has a case/u);
  });

  it("may repeat field names in their cases, but not across matches", () => {
    const one = bin()
      .u8("tag")
      .merge(match("tag").case(1, bin().u8("x")).case(2, bin().u16le("x")));
    expect(one.decode(Uint8Array.of(2, 7, 0))).toStrictEqual({ tag: 2, x: 7 });
    const first = bin()
      .u8("tag")
      .merge(match("tag").case(1, bin().u8("x")).case(2, bin().u8("y")));
    expect(() =>
      first.merge(match("tag").case(1, bin().u8("z")).case(2, bin().u8("x"))),
    ).toThrow(/duplicate field `x`/u);
  });
});
