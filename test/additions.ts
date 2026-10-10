import assert from "node:assert";
import { Bin, Parser } from "../src/index.ts";

describe("64-bit integers", () => {
  it("should parse and serialize uint64 and int64 as bigints", () => {
    const parser = Parser.start()
      .uint64le("a")
      .int64le("b")
      .uint64be("c")
      .int64be("d");
    const buffer = Buffer.from(
      "ffffffffffffffff" +
        "feffffffffffffff" +
        "0102030405060708" +
        "8000000000000000",
      "hex",
    );
    const expected = {
      a: 0xffffffffffffffffn,
      b: -2n,
      c: 0x0102030405060708n,
      d: -0x8000000000000000n,
    };
    assert.deepStrictEqual(parser.parse(buffer), expected);
    assert.deepStrictEqual(parser.serialize(expected), buffer);
    assert.strictEqual(parser.sizeOf(), 32);
  });

  it("should follow the parser's endianness for uint64 and int64", () => {
    const parser = Parser.start().endianess("little").uint64("a").int64("b");
    const buffer = Buffer.from("0100000000000000ffffffffffffffff", "hex");
    assert.deepStrictEqual(parser.parse(buffer), { a: 1n, b: -1n });
  });
});

describe("parseFrom", () => {
  const record = Parser.start()
    .uint8("length")
    .string("name", { length: "length" });

  it("should parse consecutive values and return the end offset", () => {
    const buffer = Buffer.from("\x03abc\x02de\x00", "latin1");
    const names: string[] = [];
    let offset = 0;
    while (offset < buffer.length) {
      const { result, offset: next } = record.parseFrom(buffer, offset);
      names.push(result.name);
      offset = next;
    }
    assert.deepStrictEqual(names, ["abc", "de", ""]);
    assert.strictEqual(offset, buffer.length);
  });

  it("should throw when the value extends beyond the buffer", () => {
    assert.throws(
      () => record.parseFrom(Buffer.from("\x05ab", "latin1")),
      RangeError,
    );
  });
});

describe("Regressions", () => {
  it("should parse zero-length arrays without reading an item", () => {
    const parser = Parser.start()
      .uint8("count")
      .array("items", { type: "uint16le", length: "count" })
      .uint8("trailing");
    assert.deepStrictEqual(parser.parse(Buffer.from([0, 7])), {
      count: 0,
      items: [],
      trailing: 7,
    });
  });

  it("should parse long arrays without exhausting the stack", () => {
    const count = 200_000;
    const item = Parser.start().uint16le("a").uint8("b");
    const parser = Parser.start()
      .uint32le("count")
      .array("items", { type: item, length: "count" });
    const buffer = Buffer.alloc(4 + 3 * count);
    buffer.writeUInt32LE(count, 0);
    for (let i = 0; i < count; i++) buffer.writeUInt16LE(i & 0xffff, 4 + 3 * i);
    const { items } = parser.parse(buffer);
    assert.strictEqual(items.length, count);
    assert.deepStrictEqual(items[count - 1], { a: (count - 1) & 0xffff, b: 0 });
  });

  it("should stream many values from a single chunk", (done) => {
    const count = 50_000;
    const parser = Parser.start().uint16le("a");
    let received = 0;
    parser
      .stream()
      .on("data", () => received++)
      .on("end", () => {
        // The last value may be emitted twice when flushing (see composite tests).
        assert.ok(received >= count);
        done();
      })
      .end(Buffer.alloc(2 * count));
  });

  it("should parse empty zero-terminated strings", () => {
    const parser = Parser.start()
      .string("a", { zeroTerminated: true })
      .uint8("b");
    assert.deepStrictEqual(parser.parse(Buffer.from([0, 9])), { a: "", b: 9 });
  });

  it("should parse long zero-terminated strings", () => {
    const text = "x".repeat(100_000);
    const parser = Parser.start().string("a", { zeroTerminated: true });
    assert.strictEqual(parser.parse(Buffer.from(`${text}\0`)).a, text);
  });

  it("should serialize zero-terminated strings with multi-byte characters", () => {
    const parser = Parser.start()
      .string("a", { zeroTerminated: true })
      .uint8("b");
    const value = { a: "Müller", b: 1 };
    const buffer = parser.serialize(value);
    assert.deepStrictEqual(buffer, Buffer.from("Müller\0\x01", "utf8"));
    assert.deepStrictEqual(parser.parse(buffer), value);
  });
});

describe("Types", () => {
  it("should infer parsed types", () => {
    const parser = Parser.start()
      .uint8("count")
      .array("items", { type: "int16le", length: "count" })
      .uint64le("big")
      .string("name", { length: 2 })
      .nest("inner", { type: Parser.start().floatle("x") })
      .uint8("flag", {
        formatter: (v) => v !== 0,
        deformatter: (v) => (v ? 1 : 0),
      });
    const value = parser.parse(
      Buffer.from("0101000200000000000000616200000000ff", "hex"),
    );
    // These assignments only compile if the inferred types are right.
    const count: number = value.count;
    const items: number[] = value.items;
    const big: bigint = value.big;
    const name: string = value.name;
    const x: number = value.inner.x;
    const flag: boolean = value.flag;
    assert.deepStrictEqual(
      { count, items, big, name, x, flag },
      { count: 1, items: [1], big: 2n, name: "ab", x: 0, flag: true },
    );
  });
});

describe("Bin.lazy", () => {
  interface Tree {
    value: number;
    count: number;
    children: Tree[];
  }

  const Tree: Bin<Tree> = Parser.start()
    .uint8("value")
    .uint8("count")
    .array("children", { type: Bin.lazy(() => Tree), length: "count" });

  it("should parse and serialize recursive types", () => {
    const buffer = Buffer.from([1, 2, 2, 0, 3, 1, 4, 0]);
    const expected: Tree = {
      value: 1,
      count: 2,
      children: [
        { value: 2, count: 0, children: [] },
        {
          value: 3,
          count: 1,
          children: [{ value: 4, count: 0, children: [] }],
        },
      ],
    };
    assert.deepStrictEqual(Tree.parse(buffer), expected);
    assert.deepStrictEqual(Tree.serialize(expected), buffer);
    assert.strictEqual(Tree.sizeOf(expected), buffer.length);
  });

  it("should report variable size", () => {
    assert.ok(Number.isNaN(Bin.lazy(() => Tree).sizeOf()));
  });
});
