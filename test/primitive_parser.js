const assert = require("assert");
const { Parser } = require("../");

function checkResult(parser, buffer, object, done) {
  assert.deepStrictEqual(parser.parse(buffer), object);
  assert.deepStrictEqual(
    binaryString(parser.serialize(object)),
    binaryString(buffer)
  );

  let received = false;

  const stream = parser
    .stream()
    .on("data", (parsed) => {
      // Parse only once
      if (!received) {
        assert.deepStrictEqual(parsed, object);
      }
      received = true;
    })
    .on("end", () => {
      if (received) done();
      else throw new Error("end without data");
    });

  for (let i = 1; i <= buffer.length; i++) {
    stream.write(buffer.slice(i - 1, i));
  }

  stream.end();
}

function getCb(count, done) {
  return function cb() {
    if (--count === 0) done();
  };
}

function binaryString(buf) {
  return [].map.call(buf, (n) => n.toString(2)).join(" ");
}

describe("Primitive parser", () => {
  describe("Primitive parsers", () => {
    /*
     *`it('should nothing', function(){
     *      var parser = Parser.start();
     *
     *      var buffer =  Buffer.from([0xa, 0x14, 0x1e, 0x28, 0x32]);
     *      checkResult(parser, buffer, {});
     *  });
     */
    it("should parse integer types", (done) => {
      const parser = Parser.start().uint8("a").int16le("b").uint32be("c");

      const buffer = Buffer.from([0x00, 0xd2, 0x04, 0x00, 0xbc, 0x61, 0x4e]);
      checkResult(parser, buffer, { a: 0, b: 1234, c: 12345678 }, done);
    });
    it("should use formatter to transform parsed integer", (done) => {
      const parser = Parser.start()
        .uint8("a", {
          formatter(val) {
            return val * 2;
          },
          deformatter(val) {
            return val / 2;
          },
        })
        .int16le("b", {
          formatter(val) {
            return `test${String(val)}`;
          },
          deformatter(val) {
            return Number(val.substr(4));
          },
        });

      const buffer = Buffer.from([0x01, 0xd2, 0x04]);
      checkResult(parser, buffer, { a: 2, b: "test1234" }, done);
    });
    it("should parse floating point types", () => {
      const parser = Parser.start().floatbe("a").doublele("b");

      const FLT_EPSILON = 0.00001;
      const buffer = Buffer.from([
        0x41, 0x45, 0x85, 0x1f, 0x7a, 0x36, 0xab, 0x3e, 0x57, 0x5b, 0xb1, 0xbf,
      ]);
      const result = parser.parse(buffer);

      assert(Math.abs(result.a - 12.345) < FLT_EPSILON);
      assert(Math.abs(result.b - -0.0678) < FLT_EPSILON);

      assert.deepStrictEqual(parser.serialize(result), buffer);
    });
    it("should handle endianess", (done) => {
      const parser = Parser.start().int32le("little").int32be("big");

      const buffer = Buffer.from([
        0x4e, 0x61, 0xbc, 0x00, 0x00, 0xbc, 0x61, 0x4e,
      ]);
      checkResult(parser, buffer, { little: 12345678, big: 12345678 }, done);
    });
    /*
     * `it('should skip when specified', function(){
     *      var parser =
     *      Parser.start()
     *      .uint8('a')
     *      .skip(3)
     *      .uint16le('b')
     *      .uint32be('c');
     *
     *      var buffer =  Buffer.from([0x00, 0xff, 0xff, 0xfe, 0xd2, 0x04, 0x00, 0xbc, 0x61, 0x4e]);
     *      checkResult(parser, buffer, {a: 0, b: 1234, c: 12345678});
     *  });
     */
  });

  describe("Bit field parsers", () => {
    const binaryLiteral = function (s) {
      let i;
      const bytes = [];

      s = s.replace(/\s/g, "");
      for (i = 0; i < s.length; i += 8) {
        bytes.push(parseInt(s.slice(i, i + 8), 2));
      }

      return Buffer.from(bytes);
    };

    it("binary literal helper should work", () => {
      assert.deepStrictEqual(binaryLiteral("11110000"), Buffer.from([0xf0]));
      assert.deepStrictEqual(
        binaryLiteral("11110000 10100101"),
        Buffer.from([0xf0, 0xa5])
      );
    });

    it("should parse 1-byte-length bit field sequence", (done) => {
      const cb = getCb(2, done);

      let parser = new Parser().bit1("a").bit2("b").bit4("c").bit1("d");

      const buf = binaryLiteral("1 10 1010 0");
      checkResult(
        parser,
        buf,
        {
          a: 1,
          b: 2,
          c: 10,
          d: 0,
        },
        cb
      );

      parser = new Parser()
        .endianess("little")
        .bit1("a")
        .bit2("b")
        .bit4("c")
        .bit1("d");

      checkResult(
        parser,
        buf,
        {
          a: 0,
          b: 2,
          c: 10,
          d: 1,
        },
        cb
      );
    });
    it("should parse 2-byte-length bit field sequence", (done) => {
      const cb = getCb(2, done);

      let parser = new Parser().bit3("a").bit9("b").bit4("c");

      const buf = binaryLiteral("101 111000111 0111");
      checkResult(
        parser,
        buf,
        {
          a: 5,
          b: 455,
          c: 7,
        },
        cb
      );

      parser = new Parser().endianess("little").bit3("a").bit9("b").bit4("c");
      checkResult(
        parser,
        buf,
        {
          a: 7,
          b: 398,
          c: 11,
        },
        cb
      );
    });
    it("should parse 4-byte-length bit field sequence", (done) => {
      const cb = getCb(2, done);

      let parser = new Parser()
        .bit1("a")
        .bit24("b")
        .bit4("c")
        .bit2("d")
        .bit1("e");
      const buf = binaryLiteral("1 101010101010101010101010 1111 01 1");
      checkResult(
        parser,
        buf,
        {
          a: 1,
          b: 11184810,
          c: 15,
          d: 1,
          e: 1,
        },
        cb
      );

      parser = new Parser()
        .endianess("little")
        .bit1("a")
        .bit24("b")
        .bit4("c")
        .bit2("d")
        .bit1("e");
      checkResult(
        parser,
        buf,
        {
          a: 1,
          b: 11184829,
          c: 10,
          d: 2,
          e: 1,
        },
        cb
      );
    });
    it("should parse nested bit fields", (done) => {
      const parser = new Parser().bit1("a").nest("x", {
        type: new Parser().bit2("b").bit4("c").bit1("d"),
      });

      const buf = binaryLiteral("11010100");

      checkResult(
        parser,
        buf,
        {
          a: 1,
          x: {
            b: 2,
            c: 10,
            d: 0,
          },
        },
        done
      );
    });

    it("should parse 32bit fields", (done) => {
      const parser = new Parser().endianess("big").bit32("a");

      const buf = Buffer.from([49, 204, 205, 255]);

      checkResult(
        parser,
        buf,
        {
          a: 835505663,
        },
        done
      );
    });
  });

  describe("String parser", () => {
    it("should parse ASCII encoded string", (done) => {
      const text = "hello, world";
      const buffer = Buffer.from(text, "ascii");
      const parser = Parser.start().string("msg", {
        length: buffer.length,
        encoding: "ascii",
      });

      checkResult(parser, buffer, { msg: text }, done);
    });
    it("should parse UTF8 encoded string", (done) => {
      const text = "こんにちは、せかい。";
      const buffer = Buffer.from(text, "utf8");
      const parser = Parser.start().string("msg", {
        length: buffer.length,
        encoding: "utf8",
      });

      checkResult(parser, buffer, { msg: text }, done);
    });
    it("should parse HEX encoded string", (done) => {
      const text = "cafebabe";
      const buffer = Buffer.from(text, "hex");
      const parser = Parser.start().string("msg", {
        length: buffer.length,
        encoding: "hex",
      });

      checkResult(parser, buffer, { msg: text }, done);
    });
    it("should parse variable length string", (done) => {
      const buffer = Buffer.from("0c68656c6c6f2c20776f726c64", "hex");
      const parser = Parser.start()
        .uint8("length")
        .string("msg", { length: "length", encoding: "utf8" });

      checkResult(parser, buffer, { msg: "hello, world", length: 12 }, done);
    });
    it("should parse zero terminated string", (done) => {
      const buffer = Buffer.from("68656c6c6f2c20776f726c6400", "hex");
      const parser = Parser.start().string("msg", {
        zeroTerminated: true,
        encoding: "ascii",
      });

      checkResult(parser, buffer, { msg: "hello, world" }, done);
    });
    it("should parser zero terminated fixed-length string", (done) => {
      const buffer = Buffer.from("abc\u0000defghij\u0000");
      const parser = Parser.start()
        .string("a", { length: 5, zeroTerminated: true })
        .string("b", { length: 5, zeroTerminated: true })
        .string("c", { length: 5, zeroTerminated: true });

      checkResult(
        parser,
        buffer,
        {
          a: "abc",
          b: "defgh",
          c: "ij",
        },
        done
      );
    });
    it("should strip trailing null characters", (done) => {
      const buffer = Buffer.from("746573740000", "hex");
      const parser1 = Parser.start().string("str", {
        length: 6,
        stripNull: false,
      });
      const parser2 = Parser.start().string("str", {
        length: 6,
        stripNull: true,
      });

      const cb = getCb(2, done);

      checkResult(parser1, buffer, { str: "test\u0000\u0000" }, cb);
      checkResult(parser2, buffer, { str: "test" }, cb);
    });
    it("should parse infinitely sized string", (done) => {
      const text = "hello, world";
      const buffer = Buffer.from(text, "ascii");
      const parser = Parser.start().string("msg", {
        length: Infinity,
        encoding: "ascii",
      });

      checkResult(parser, buffer, { msg: text }, done);
    });
    it("should parse nested infinitely sized string", (done) => {
      const buffer = Buffer.from([2, 65, 66, 2, 65, 66]);
      const parser = new Parser().array("data", {
        type: new Parser().uint8("len").fixedSizeNest("data", {
          length: 2,
          type: new Parser().string("str", { length: Infinity }),
        }),
        length: 2,
      });

      checkResult(
        parser,
        buffer,
        {
          data: [
            {
              len: 2,
              data: { str: "AB" },
            },
            {
              len: 2,
              data: { str: "AB" },
            },
          ],
        },
        done
      );
    });
  });

  describe("Buffer parser", () => {
    it("should parse as buffer", (done) => {
      const parser = new Parser().uint8("len").buffer("raw", {
        length: "len",
      });

      const buf = Buffer.from("deadbeefdeadbeef", "hex");
      const buffer = Buffer.concat([Buffer.from([8]), buf]);

      checkResult(parser, buffer, { len: 8, raw: buf }, done);
    });

    it("should parse empty buffers", (done) => {
      let parser = new Parser().buffer("raw", {
        readUntil: "eof",
      });

      const buf = Buffer.from([]);

      checkResult(parser, buf, { raw: buf }, () => {
        parser = new Parser().buffer("raw", {
          length: 300,
        });

        checkResult(parser, buf, { raw: buf }, done);
      });
    });

    it("should clone buffer if options.clone is true", (done) => {
      const parser = new Parser().buffer("raw", {
        length: 8,
        clone: true,
      });

      const buf = Buffer.from("deadbeefdeadbeef", "hex");
      checkResult(parser, buf, { raw: buf }, done);

      const result = parser.parse(buf);
      result.raw[0] = 0xff;
      assert.notDeepStrictEqual(result.raw, buf);
    });
  });
});
