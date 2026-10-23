import assert from "node:assert/strict";
import {
  array,
  bin,
  DecodeError,
  literal,
  match,
  string,
  u16le,
  u8,
} from "../src/index.ts";
import { bytewise, collect, hex } from "./helpers.ts";

describe("Matches", () => {
  it("tell numbers and strings apart, and match bigints and booleans", () => {
    const ByString = bin()
      .field("tag", string(1))
      .field("v", match("tag").case("1", u8).otherwise(u16le));
    assert.deepEqual(ByString.decode(hex("31 07")), { tag: "1", v: 7 });
    const ByBigint = bin().u64le("id").field("v", match("id").case(1n, u8));
    assert.deepEqual(ByBigint.decode(hex("0100000000000000 07")), {
      id: 1n,
      v: 7,
    });
    const ByBoolean = bin()
      .u8("n")
      .field(
        "v",
        match((o: { n: number }) => o.n > 0)
          .case(true, u8)
          .case(false, u16le),
      );
    assert.deepEqual(ByBoolean.decode(hex("01 07")), { n: 1, v: 7 });
    assert.deepEqual(ByBoolean.decode(hex("00 0800")), { n: 0, v: 8 });
  });

  it("reject invalid and repeated cases when defined", () => {
    assert.throws(
      () => match("t").case(NaN as never, u8),
      /invalid case value NaN/,
    );
    assert.throws(
      () =>
        match("t")
          .case(1, u8)
          .case(1 as never, u8),
      /1 already has a case/,
    );
    assert.throws(
      () =>
        match("t")
          .case(0, u8)
          .case(-0 as never, u8),
      /0 already has a case/,
    );
    const closed = match("t").otherwise(u8) as unknown as {
      case(value: number, codec: unknown): unknown;
    };
    assert.throws(() => closed.case(1, u8), /no cases can follow `otherwise`/);
  });

  it("add the fields of parser cases, which later fields read", async () => {
    const Record = bin()
      .u8("kind")
      .merge(
        match("kind")
          .case(1, bin().u8("length").field("text", string("length")))
          .case(2, bin().u8("length").u16le("id")),
      )
      .field("tail", string("length"));
    const values = [
      { kind: 1, length: 2, text: "hi", tail: "ab" },
      { kind: 2, length: 1, id: 0x0302, tail: "x" },
    ] as const;
    const bytes = ["01 02 6869 6162", "02 01 0203 78"];
    for (const [i, value] of values.entries()) {
      assert.deepEqual(Record.decode(hex(bytes[i])), value);
      assert.deepEqual(Record.encode(value), hex(bytes[i]));
      assert.deepEqual(await collect(Record, bytewise(hex(bytes[i]))), [value]);
    }
    assert.deepEqual(Record.pick("kind", "tail").decode(hex(bytes[1])), {
      kind: 2,
      tail: "x",
    });
  });

  it("decode parser cases ending with empty arrays (issue #6)", async () => {
    const Inner = bin()
      .field("airportCode", string(3))
      .u8("count")
      .field("subs", array(bin().u8("val"), "count"));
    const Outer = bin()
      .u8("type")
      .field("inner", match("type").case(1, Inner).case(2, Inner));
    const value = {
      type: 1,
      inner: { airportCode: "BER", count: 0, subs: [] },
    } as const;
    const bytes = hex("01 424552 00");
    assert.deepEqual(Outer.encode(value), bytes);
    assert.deepEqual(Outer.decode(bytes), value);
    assert.deepEqual(await collect(Outer, bytewise(bytes)), [value]);
  });

  it("locate errors in the fields of cases without the match", () => {
    const Flat = bin()
      .u8("kind")
      .merge(match("kind").case(1, bin().field("magic", literal(u8, 5))));
    assert.throws(
      () => Flat.decode(hex("01 06")),
      (e) =>
        e instanceof DecodeError && e.path.join() === "magic" && e.offset === 1,
    );
    const Nested = bin()
      .u8("kind")
      .field(
        "body",
        match("kind").case(1, bin().field("magic", literal(u8, 5))),
      );
    assert.throws(
      () => Nested.decode(hex("01 06")),
      (e) => e instanceof DecodeError && e.path.join() === "body,magic",
    );
    assert.throws(
      () => Flat.decode(hex("02")),
      (e) => e instanceof DecodeError && e.code === "no-match",
    );
    assert.throws(() => Flat.encode({ kind: 3 } as never), /no case for 3/);
  });
});
