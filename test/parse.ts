import assert from "node:assert/strict";
import { Bin, type ValueOf } from "../src/index.ts";
import { collect, hex, Str } from "./helpers.ts";

describe("parseFrom", () => {
  it("parses consecutive values", () => {
    const input = Buffer.from("\x03abc\x02de\x00", "latin1");
    const texts: string[] = [];
    for (let offset = 0; offset < input.length;) {
      const { result, offset: next } = Str.parseFrom(input, offset);
      texts.push(result.text);
      offset = next;
    }
    assert.deepEqual(texts, ["abc", "de", ""]);
  });

  it("rejects offsets outside the buffer", () => {
    for (const offset of [-1, 1.5, 4]) {
      assert.throws(
        () => Str.parseFrom(Buffer.from("\x00ab"), offset),
        RangeError,
      );
    }
  });

  describe("with selected fields", () => {
    const Record = Bin.start()
      .uint8("n")
      .array("items", { type: Str, length: "n" })
      .uint8("tag")
      .choice("extra", {
        tag: "tag",
        choices: { 0: Bin.start(), 1: "uint16le" },
      })
      .nest("inline", { type: Bin.start().uint8("p"), flatten: true })
      .string("name", { zeroTerminated: true })
      .uint8("last");
    const value = {
      n: 2,
      items: [
        { len: 1, text: "a" },
        { len: 0, text: "" },
      ],
      tag: 1,
      extra: 513,
      p: 7,
      name: "xyz",
      last: 9,
    };
    const input = Record.serialize(value);

    it("decodes the selected and referenced fields", () => {
      const { result, offset } = Record.parseFrom(input, 0, {
        fields: ["name", "last"],
      });
      assert.equal(offset, input.length);
      // `n` and `tag` are needed to step over `items` and `extra`.
      assert.deepEqual(result, { n: 2, tag: 1, name: "xyz", last: 9 });
      // Fields of a flattened value are selected like the others.
      assert.deepEqual(Record.parseFrom(input, 0, { fields: ["p"] }).result, {
        n: 2,
        tag: 1,
        p: 7,
      });
    });

    it("tells selections apart, also when an array changes", () => {
      const parser = Bin.start().uint8("").uint8("b");
      const input = Buffer.from([1, 2]);
      const fields: ("" | "b")[] = [];
      assert.deepEqual(parser.parseFrom(input, 0, { fields }).result, {});
      fields.push("");
      assert.deepEqual(parser.parseFrom(input, 0, { fields }).result, {
        "": 1,
      });
      fields[0] = "b";
      assert.deepEqual(parser.parseFrom(input, 0, { fields }).result, { b: 2 });
    });

    it("skips values with no fields", () => {
      const twice = Buffer.concat([input, input]);
      assert.equal(
        Record.parseFrom(twice, 0, { fields: [] }).offset,
        input.length,
      );
      assert.equal(
        Record.parseFrom(twice, input.length, { fields: [] }).offset,
        twice.length,
      );
    });

    it("decodes levels whose layout or asserts may depend on any field completely", () => {
      const lengths = Bin.start()
        .uint8("n")
        .buffer("data", { length: (obj) => obj.n * 2 })
        .uint8("after");
      const { result } = lengths.parseFrom(Buffer.from([1, 5, 6, 9]), 0, {
        fields: ["after"],
      });
      assert.deepEqual(result, { n: 1, data: Buffer.from([5, 6]), after: 9 });

      const asserts = Bin.start()
        .uint8("a")
        .uint8("b", {
          formatter(b) {
            return b + this.a;
          },
          deformatter: (b, obj) => b - obj.a,
          assert: 3,
        });
      const input = Buffer.from([1, 2]);
      assert.equal(asserts.parseFrom(input, 0, { fields: [] }).offset, 2);
      assert.deepEqual(asserts.parseFrom(input, 0, { fields: ["b"] }).result, {
        a: 1,
        b: 3,
      });
    });

    it("still checks asserts", () => {
      const parser = Bin.start()
        .nest("header", { type: Bin.start().uint8("magic", { assert: 1 }) })
        .uint8("a");
      assert.throws(
        () => parser.parseFrom(Buffer.from([2, 0]), 0, { fields: ["a"] }),
        /Assert error: `magic` is `2`/,
      );
    });
  });
});

describe("Errors", () => {
  it("rejects incomplete definitions", () => {
    const definitions: [() => unknown, RegExp][] = [
      [() => Bin.start().string("a", {} as never), /`a` needs a length/],
      [() => Bin.start().buffer("a", {} as never), /`a` needs a length/],
      [
        () => Bin.start().array("a", { type: "uint8" } as never),
        /`a` needs a length/,
      ],
      [
        () =>
          Bin.start().fixedSizeNest("a", { type: "uint8", length: Infinity }),
        /`a` needs a finite length/,
      ],
      [
        () => Bin.start().string("a", { length: -1 }),
        /invalid length `-1` for `a`/,
      ],
      [
        () => Bin.start().bit4("a", { formatter: String } as never),
        /`a` has a formatter but no deformatter/,
      ],
      [() => Bin.start().uint8("a").bit2("a"), /duplicate field `a`/],
      [() => Bin.start().nest("a", { type: "uint7" as never }), /invalid type/],
      [
        () =>
          Bin.start().array("a", {
            type: "uint8",
            readUntil: ((_item: number, _buf: Buffer) => true) as never,
          }),
        /read-ahead/,
      ],
      [() => Bin.start().endianness("middle" as never), /invalid endianness/],
      [() => Bin.lazy(() => Str).uint8("x"), /lazy parser/],
      [() => Bin.lazy(() => Str).create(class {}), /lazy parser/],
      [
        () =>
          Bin.start().nest("", {
            type: Bin.start().create(class {}),
            flatten: true,
          }),
        /``: objects of a class cannot be flattened/,
      ],
      [
        () =>
          Bin.start()
            .nest("a", {
              type: Bin.lazy(() => Bin.start().create(class {})),
              flatten: true,
            })
            .parse(Buffer.alloc(0)),
        /`a`: objects of a class cannot be flattened/,
      ],
      [() => Bin.start().uint8("__proto__"), /invalid field name/],
      [
        () => Bin.start().nest("a", { type: "uint8", flatten: true } as never),
        /`a`: only parsers can be flattened/,
      ],
    ];
    for (const [define, message] of definitions) assert.throws(define, message);
  });

  it("reports parse errors, also from streams", async () => {
    const Tagged = Bin.start()
      .uint8("tag", { assert: (tag) => tag < 3 })
      .choice("value", { tag: "tag", choices: { 0: "uint8", 1: Str } });
    const failures: [Bin, string, RegExp][] = [
      [Tagged, "00", /unexpected end of input/],
      [Tagged, "01 05 61", /unexpected end of input/],
      [Tagged, "02 00", /invalid choice `2` for `value`/],
      [
        Bin.start().choice("a", { tag: () => "constructor", choices: {} }),
        "00",
        /invalid choice `constructor`/,
      ],
      [Tagged, "03", /Assert error: `tag` is `3`/],
      [
        Bin.start().string("a", { zeroTerminated: true }),
        "6162",
        /unexpected end of input/,
      ],
      [
        // The nested value may not read past its fixed size.
        Bin.start()
          .fixedSizeNest("a", { type: "uint16le", length: 1 })
          .uint8("b"),
        "00 00",
        /unexpected end of input/,
      ],
      [
        Bin.start().array("a", { type: "uint8", readUntil: (v) => v === 0 }),
        "01 02",
        /unexpected end of input/,
      ],
      [
        Bin.start().buffer("a", { length: "n" as never }),
        "00",
        /length `n` not found in object/,
      ],
      [
        Bin.start().int8("n").buffer("a", { length: "n" }),
        "ff 00",
        /invalid length `-1` for `a`/,
      ],
      [
        Bin.start().array("a", { type: Bin.start(), readUntil: "eof" }),
        "00",
        /an item of `a` read no input/,
      ],
      [
        Bin.start().array("a", { type: Bin.start(), readUntil: () => false }),
        "00",
        /an item of `a` read no input/,
      ],
      [
        Bin.start().array("a", { type: Str, length: 2, key: "text" }),
        "01 61 01 61",
        /`a`: two items have text `a`/,
      ],
      [
        Bin.start().nest("a", {
          type: Str,
          flatten: true,
          formatter: (s) => Object.fromEntries([["__proto__", s.text]]),
          deformatter: () => ({ len: 0, text: "" }),
        }),
        "01 61",
        /without a `__proto__` field can be flattened/,
      ],
    ];
    for (const [parser, bytes, message] of failures) {
      const input = hex(bytes);
      assert.throws(() => parser.parse(input), message, bytes);
      await assert.rejects(collect(parser, [input]), message, bytes);
    }
  });

  it("reports values that cannot be serialized", () => {
    const failures: [Bin<object>, object, RegExp][] = [
      [
        Bin.start().uint8("n").array("a", { type: "uint8", length: "n" }),
        { n: 2, a: [1] },
        /`a` has 1 items, but its length is 2/,
      ],
      [
        Bin.start().buffer("a", { length: 2 }),
        { a: Buffer.alloc(3) },
        /`a` has 3 bytes, but its length is 2/,
      ],
      [
        Bin.start().string("a", { length: 2 }),
        { a: "abc" },
        /`a` has 3 bytes, but its length is 2/,
      ],
      [
        Bin.start().string("a", { zeroTerminated: true }),
        { a: "a\0b" },
        /`a` contains a zero byte/,
      ],
      [
        Bin.start().fixedSizeNest("a", { type: Str, length: 2 }),
        { a: { len: 2, text: "ab" } },
        /`a` needs 3 bytes, more than its size 2/,
      ],
      [Bin.start().bit3("a"), { a: 8 }, /8 does not fit in 3 bits/],
      [Bin.start().uint8("a").uint8("b"), { a: 1 }, /field `b` not found/],
      [
        Bin.start().array("a", { type: Str, length: 1, key: "text" }),
        { a: { x: { len: 1, text: "y" } } },
        /item `x` has text `y`/,
      ],
      [
        Bin.start().array("a", { type: "uint8", readUntil: (v) => v === 0 }),
        { a: [0, 1] },
        /`a` has 2 items, but parsing stops after 1/,
      ],
      [
        Bin.start().array("a", { type: "uint8", readUntil: (v) => v === 0 }),
        { a: [1] },
        /`a` has no item passing readUntil/,
      ],
    ];
    for (const [parser, value, message] of failures) {
      assert.throws(() => parser.serialize(value), message);
    }
    assert.throws(
      () => Str.serialize({ len: 1, text: "a" }, Buffer.alloc(1)),
      /needs 2 bytes, but the buffer has 1/,
    );
  });
});

describe("serialize", () => {
  it("writes into a given buffer, padding, and returns the bytes written", () => {
    const parser = Bin.start()
      .fixedSizeNest("a", { type: Str, length: 4 })
      .string("b", { length: 3 });
    const buffer = Buffer.alloc(9, 0xff);
    const out = parser.serialize({ a: { len: 1, text: "x" }, b: "y" }, buffer);
    assert.equal(out.buffer, buffer.buffer);
    assert.deepEqual(out, Buffer.from("\x01x\0\0y\0\0"));
  });

  it("computes values with a deformatter alone", () => {
    const parser = Bin.start()
      .uint8("a")
      .uint8("sum", { deformatter: (_sum, obj) => obj.a * 2 });
    // The computed field may be omitted (TypeScript still asks for it).
    const value = { a: 3 } as ValueOf<typeof parser>;
    assert.deepEqual(parser.serialize(value), Buffer.from([3, 6]));
  });
});
