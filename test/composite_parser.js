const assert = require("assert");
const { Parser } = require("../");

function checkResult(parser, buffer, object, done) {
  assert.deepEqual(parser.parse(buffer), object);
  assert.deepEqual(parser.serialize(object).toString(), buffer.toString());

  let received = false;

  const stream = parser
    .stream()
    .on("data", (parsed) => {
      if (received) return; // Might be triggered a second time, ignored here
      assert.deepEqual(parsed, object);
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

describe("Composite parser", () => {
  describe("Array parser", () => {
    it("should parse array of primitive types", (done) => {
      const parser = Parser.start().uint8("length").array("message", {
        length: "length",
        type: "uint8",
      });

      const buffer = Buffer.from([12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      checkResult(
        parser,
        buffer,
        {
          length: 12,
          message: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        },
        done
      );
    });
    it("should parse array of user defined types", (done) => {
      const elementParser = new Parser().uint8("key").int16le("value");

      const parser = Parser.start().uint16le("length").array("message", {
        length: "length",
        type: elementParser,
      });

      const buffer = Buffer.from([
        0x02, 0x00, 0xca, 0xd2, 0x04, 0xbe, 0xd3, 0x04,
      ]);
      checkResult(
        parser,
        buffer,
        {
          length: 0x02,
          message: [
            { key: 0xca, value: 1234 },
            { key: 0xbe, value: 1235 },
          ],
        },
        done
      );
    });
    it("should parse array of arrays", (done) => {
      const rowParser = Parser.start().uint8("length").array("cols", {
        length: "length",
        type: "int32le",
      });

      const parser = Parser.start().uint8("length").array("rows", {
        length: "length",
        type: rowParser,
      });

      const buffer = Buffer.alloc(1 + 10 * (1 + 5 * 4));
      let i;
      let j;

      let iterator = 0;
      buffer.writeUInt8(10, iterator);
      iterator += 1;
      for (i = 0; i < 10; i++) {
        buffer.writeUInt8(5, iterator);
        iterator += 1;
        for (j = 0; j < 5; j++) {
          buffer.writeInt32LE(i * j, iterator);
          iterator += 4;
        }
      }

      checkResult(
        parser,
        buffer,
        {
          length: 10,
          rows: [
            { length: 5, cols: [0, 0, 0, 0, 0] },
            { length: 5, cols: [0, 1, 2, 3, 4] },
            { length: 5, cols: [0, 2, 4, 6, 8] },
            { length: 5, cols: [0, 3, 6, 9, 12] },
            { length: 5, cols: [0, 4, 8, 12, 16] },
            { length: 5, cols: [0, 5, 10, 15, 20] },
            { length: 5, cols: [0, 6, 12, 18, 24] },
            { length: 5, cols: [0, 7, 14, 21, 28] },
            { length: 5, cols: [0, 8, 16, 24, 32] },
            { length: 5, cols: [0, 9, 18, 27, 36] },
          ],
        },
        done
      );
    });
    it("should parse until eof when readUntil is specified", (done) => {
      const parser = Parser.start().array("data", {
        readUntil: "eof",
        type: "uint8",
      });

      const buffer = Buffer.from([
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      ]);
      checkResult(
        parser,
        buffer,
        {
          data: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        },
        done
      );
    });
    it("should parse until function returns true when readUntil is function", (done) => {
      const parser = Parser.start().array("data", {
        readUntil(item) {
          return item === 0;
        },
        type: "uint8",
      });

      const buffer = Buffer.from([0xff, 0xff, 0xff, 0x01, 0x00]);
      checkResult(
        parser,
        buffer,
        {
          data: [0xff, 0xff, 0xff, 0x01, 0x00],
        },
        done
      );
    }); /*
        `it('should parse until function returns true when readUntil is function (using read-ahead)', function(done){
            var parser =
                Parser.start()
                .array('data', {
                    readUntil: (item, buf) => buf.length > 0 && buf.readUInt8(0) === 0,
                    type: 'uint8'
                });

            var buffer = Buffer.from([0xff, 0xff, 0xff, 0x01, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff]);
            checkResult(parser, buffer, {
                data: [0xff, 0xff, 0xff, 0x01]
            }, done);
        });*/
    it("should parse associative arrays", (done) => {
      const parser = Parser.start()
        .int8("numlumps")
        .array("lumps", {
          type: Parser.start()
            .int32le("filepos")
            .int32le("size")
            .string("name", { length: 8, encoding: "ascii" }),
          length: "numlumps",
          key: "name",
        });

      const buffer = Buffer.from([
        0x02, 0xd2, 0x04, 0x00, 0x00, 0x2e, 0x16, 0x00, 0x00, 0x41, 0x41, 0x41,
        0x41, 0x41, 0x41, 0x41, 0x41, 0x2e, 0x16, 0x00, 0x00, 0xd2, 0x04, 0x00,
        0x00, 0x62, 0x62, 0x62, 0x62, 0x62, 0x62, 0x62, 0x62,
      ]);
      checkResult(
        parser,
        buffer,
        {
          numlumps: 2,
          lumps: {
            AAAAAAAA: {
              filepos: 1234,
              size: 5678,
              name: "AAAAAAAA",
            },
            bbbbbbbb: {
              filepos: 5678,
              size: 1234,
              name: "bbbbbbbb",
            },
          },
        },
        done
      );
    });
    it("should use formatter to transform parsed array", (done) => {
      const parser = Parser.start().array("data", {
        type: "uint8",
        length: 4,
        formatter(arr) {
          return arr.join(".");
        },
        deformatter(str) {
          return str.split(".").map(parseFloat);
        },
      });

      const buffer = Buffer.from([0x0a, 0x0a, 0x01, 0x6e]);
      checkResult(
        parser,
        buffer,
        {
          data: "10.10.1.110",
        },
        done
      );
    });
  });

  describe("Choice parser", () => {
    it("should parse choices of primitive types", (done) => {
      const parser = Parser.start()
        .uint8("tag1")
        .choice("data1", {
          tag: "tag1",
          choices: {
            0: "int32le",
            1: "int16le",
          },
        })
        .uint8("tag2")
        .choice("data2", {
          tag: "tag2",
          choices: {
            0: "int32le",
            1: "int16le",
          },
        });

      const buffer = Buffer.from([
        0x0, 0x4e, 0x61, 0xbc, 0x00, 0x01, 0xd2, 0x04,
      ]);
      checkResult(
        parser,
        buffer,
        {
          tag1: 0,
          data1: 12345678,
          tag2: 1,
          data2: 1234,
        },
        done
      );
    });
    it("should parse default choice", (done) => {
      const parser = Parser.start()
        .uint8("tag")
        .choice("data", {
          tag: "tag",
          choices: {
            0: "int32le",
            1: "int16le",
          },
          defaultChoice: "uint8",
        })
        .int32le("test");

      const buffer = Buffer.from([0x03, 0xff, 0x2f, 0xcb, 0x04, 0x0]);
      checkResult(
        parser,
        buffer,
        {
          tag: 3,
          data: 0xff,
          test: 314159,
        },
        done
      );
    });
    it("should parse choices of user defied types", (done) => {
      const parser = Parser.start()
        .uint8("tag")
        .choice("data", {
          tag: "tag",
          choices: {
            1: Parser.start()
              .uint8("length")
              .string("message", { length: "length" }),
            3: Parser.start().int32le("number"),
          },
        });

      const cb = getCb(2, done);

      let buffer = Buffer.from([
        0x1, 0xc, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x2c, 0x20, 0x77, 0x6f, 0x72,
        0x6c, 0x64,
      ]);
      checkResult(
        parser,
        buffer,
        {
          tag: 1,
          data: {
            length: 12,
            message: "hello, world",
          },
        },
        cb
      );
      buffer = Buffer.from([0x03, 0x4e, 0x61, 0xbc, 0x00]);
      checkResult(
        parser,
        buffer,
        {
          tag: 3,
          data: {
            number: 12345678,
          },
        },
        cb
      );
    });
    it("should accept a function as a tag", (done) => {
      const parser = Parser.start()
        .uint8("tag")
        .choice("data", {
          tag(obj) {
            return obj.tag;
          },
          choices: {
            0: "int32le",
            1: "int16le",
          },
          defaultChoice: "uint8",
        })
        .int32le("test");

      const buffer = Buffer.from([0x03, 0xff, 0x2f, 0xcb, 0x04, 0x0]);
      checkResult(
        parser,
        buffer,
        {
          tag: 3,
          data: 0xff,
          test: 314159,
        },
        done
      );
    });
    it("should flatten user defined types with option", (done) => {
      const parser = Parser.start()
        .uint8("tag")
        .choice("data", {
          tag: "tag",
          choices: {
            1: Parser.start()
              .uint8("length")
              .string("message", { length: "length" }),
            3: Parser.start().int32le("number"),
          },
          flatten: true,
        });

      const cb = getCb(2, done);

      let buffer = Buffer.from([
        0x1, 0xc, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x2c, 0x20, 0x77, 0x6f, 0x72,
        0x6c, 0x64,
      ]);
      checkResult(
        parser,
        buffer,
        {
          tag: 1,
          length: 12,
          message: "hello, world",
        },
        cb
      );
      buffer = Buffer.from([0x03, 0x4e, 0x61, 0xbc, 0x00]);
      checkResult(
        parser,
        buffer,
        {
          tag: 3,
          number: 12345678,
        },
        cb
      );
    });
  });

  describe("Nest parser", () => {
    it("should parse nested parsers", (done) => {
      const nameParser = new Parser()
        .string("firstName", {
          zeroTerminated: true,
        })
        .string("lastName", {
          zeroTerminated: true,
        });
      const infoParser = new Parser().uint8("age");
      const personParser = new Parser()
        .nest("name", {
          type: nameParser,
        })
        .nest("info", {
          type: infoParser,
        });

      const buffer = Buffer.concat([
        Buffer.from("John\0Doe\0"),
        Buffer.from([0x20]),
      ]);
      checkResult(
        personParser,
        buffer,
        {
          name: {
            firstName: "John",
            lastName: "Doe",
          },
          info: {
            age: 0x20,
          },
        },
        done
      );
    });

    it("should format parsed nested parser", (done) => {
      const nameParser = new Parser()
        .string("firstName", {
          zeroTerminated: true,
        })
        .string("lastName", {
          zeroTerminated: true,
        });
      const personParser = new Parser().nest("name", {
        type: nameParser,
        formatter(name) {
          return name && `${name.firstName} ${name.lastName}`;
        },
        deformatter(name) {
          const parts = name ? name.split(" ") : ["", ""];
          return { firstName: parts[0], lastName: parts[1] };
        },
      });

      const buffer = Buffer.from("John\0Doe\0");
      checkResult(
        personParser,
        buffer,
        {
          name: "John Doe",
        },
        done
      );
    });
  });

  describe("Constructors", () => {
    it("should create a custom object type", () => {
      class Person {
        constructor() {
          this.name = "";
        }
        toString() {
          return "[object Person]";
        }
      }

      const parser = Parser.start().create(Person).string("name", {
        zeroTerminated: true,
      });

      const buffer = Buffer.from("John Doe\0");
      const person = parser.parse(buffer);
      assert.ok(person instanceof Person);
      assert.equal(person.name, "John Doe");
    });
  });

  describe("Utilities", () => {
    it("should count size for fixed size structs", () => {
      const parser = Parser.start()
        .int8("a")
        .int32le("b")
        .string("msg", { length: 10 })
        // .skip(2)
        .array("data", {
          length: 3,
          type: "int8",
        });

      assert.equal(parser.sizeOf(), 1 + 4 + 10 + /* 2 +*/ 3);
      assert.equal(
        parser.sizeOf({ a: 0, b: 0, msg: "", data: [1, 2, 3] }),
        1 + 4 + 10 + /* 2 +*/ 3
      );
    });
    it("should assert parsed values", () => {
      let parser = Parser.start().string("msg", {
        encoding: "ascii",
        zeroTerminated: true,
        assert: "hello, world",
      });
      let buffer = Buffer.from("68656c6c6f2c20776f726c6400", "hex");
      assert.doesNotThrow(() => {
        parser.parse(buffer);
      });

      buffer = Buffer.from("68656c6c6f2c206a7300", "hex");
      assert.throws(() => {
        parser.parse(buffer);
      });

      parser = new Parser()
        .int16le("a")
        .int16le("b")
        .int16le("c", {
          assert(x) {
            return this.a + this.b === x;
          },
        });

      buffer = Buffer.from("d2042e16001b", "hex");
      assert.doesNotThrow(() => {
        parser.parse(buffer);
      });
      buffer = Buffer.from("2e16001bd204", "hex");
      assert.throws(() => {
        parser.parse(buffer);
      });
    });
  });

  describe("Parse other fields after bit", () => {
    it("Parse uint8", (done) => {
      const buffer = Buffer.from([0, 1, 0, 4]);

      const cb = getCb(8, done);

      for (let i = 17; i <= 24; i++) {
        const parser = Parser.start()[`bit${i}`]("a").uint8("b");

        checkResult(
          parser,
          buffer,
          {
            a: 1 << (i - 16),
            b: 4,
          },
          cb
        );
      }
    });
  });

  describe("Fixed size nest", () => {
    it("Nested primitive", (done) => {
      const parser = Parser.start()
        .fixedSizeNest("fixed_nest", {
          length: 2,
          type: "int8",
        })
        .int8("trailing");

      const buffer = Buffer.from([1, 0, 3]);

      checkResult(
        parser,
        buffer,
        {
          fixed_nest: 1,
          trailing: 3,
        },
        done
      );
    });
  });

  it("Nested infinitely sized string", (done) => {
    const text = "hello, world0";
    const buffer = Buffer.from(text);
    const parser = Parser.start()
      .fixedSizeNest("fixed_nest", {
        length: 12,
        type: Parser.start().string("msg", { length: Infinity }),
      })
      .int8("trailing");

    checkResult(
      parser,
      buffer,
      { fixed_nest: { msg: text.slice(0, -1) }, trailing: 48 },
      done
    );
  });
});
