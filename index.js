"use strict";

const Parser = require("./lib/parser.js");
const Serializer = require("./lib/serializer.js");

const getType = require("./lib/type_functions.js");

const PRIMITIVE_TYPES = require("./lib/primitive_types.json");
const PRIMITIVES = Object.keys(PRIMITIVE_TYPES).map(function (key) {
  return key.toLowerCase();
});

// array with ints 1..24
const BIT_VALS = Array.apply(null, Array(32)).map(function (_, i) {
  return i + 1;
});

class Bin {
  constructor() {
    this.parser = new Parser();
    this.serializer = new Serializer();

    this.endian = "be";
    this.bitRequests = [];
  }

  static start = function () {
    return new Bin();
  };

  static Parser = Bin; // work as drop-in replacement for binary-parser

  serialize(obj, buf) {
    this._flushBitfield();
    return this.serializer.serialize(obj, buf);
  }

  sizeOf(obj) {
    if (obj == null) return this.parser.fixedSize;
    return this.serializer.sizeFunc(obj);
  }

  choice(varName, options) {
    this._flushBitfield();

    const choices = options.choices;
    const mappedChoices = {};

    for (var key in choices) {
      mappedChoices[key] = getType(choices[key]);
    }

    const defaultChoice =
      options.defaultChoice && getType(options.defaultChoice);

    const tag = options.tag;
    const getTag =
      typeof tag === "function"
        ? tag
        : function getTag(obj) {
            if (!(tag in obj))
              throw new Error("tag `" + tag + "` not found in object");
            return obj[tag];
          };

    var getChoice = defaultChoice
      ? function (obj) {
          var key = getTag(obj);
          return key in mappedChoices ? mappedChoices[key] : defaultChoice;
        }
      : function (obj) {
          var choice = mappedChoices[getTag(obj)];
          if (!choice) throw new Error("invalid choice");
          return choice;
        };

    this.parser.choice(varName, options, getChoice);
    this.serializer.choice(varName, options, getChoice);
    return this;
  }

  create(constructorFn) {
    this.parser.create(constructorFn);
    return this;
  }

  compile() {
    /* do nothing */
  }

  getCode() {
    throw new Error("not implemented");
  }

  parse(buffer, callback) {
    this._flushBitfield();
    return this.parser.parse(buffer, callback) || {};
  }

  stream() {
    return this.parser.stream();
  }

  nest(varName, options) {
    var type = getType(options.type, true);
    var opts = { __proto__: options, type: type };

    if (type.bitRequests.length) {
      this.bitRequests = this.bitRequests.concat(
        type.bitRequests.map(function (req) {
          return {
            i: req.i,
            vars: [varName].concat(req.vars),
            options: req.options,
            // TODO support constructors
          };
        }, this)
      );
    }

    this.parser.nest(varName, opts);
    this.serializer.nest(varName, opts);
    return this;
  }

  _flushBitfield() {
    var reqs = this.bitRequests;

    if (!reqs.length) return;
    if (this.endian === "le") reqs = reqs.reverse();

    const length = reqs.reduce(function (sum, req) {
      return sum + req.i;
    }, 0);

    this.serializer._processBitfield(reqs, length);
    this.parser.processBitfield(reqs, length);

    this.bitRequests = [];
  }

  // copied from binary_parser.js
  endianess(endianess) {
    switch (endianess.toLowerCase()) {
      case "little":
        this.endian = "le";
        break;
      case "big":
        this.endian = "be";
        break;
      default:
        throw new Error("Invalid endianess: " + endianess);
    }

    return this;
  }

  // alias properties
  get writeFunc() {
    return this.serializer.writeFunc;
  }

  get sizeFunc() {
    return this.serializer.sizeFunc;
  }

  get readFunc() {
    return this.parser.readFunc;
  }

  get constructorFn() {
    return this.parser.constructorFn;
  }

  get fixedSize() {
    return this.parser.fixedSize;
  }
}

["string", "buffer", "array", "fixedSizeNest", ...PRIMITIVES].forEach(function (
  name
) {
  Bin.prototype[name] = function (varName, options) {
    this._flushBitfield();

    const type = options && options.type && getType(options.type);

    this.parser[name](varName, options, type);
    this.serializer[name](varName, options, type);
    return this;
  };
});

BIT_VALS.forEach(function (i) {
  Bin.prototype["bit" + i] = function (varName, options) {
    // TODO support constructors
    this.bitRequests.push({ i: i, vars: [varName], options: options });
    return this;
  };
});

Object.keys(PRIMITIVE_TYPES)
  .filter((p) => p.endsWith("BE"))
  .map((p) => p.toLowerCase())
  .forEach(function (primitiveName) {
    var name = primitiveName.slice(0, -2).toLowerCase();

    Bin.prototype[name] = function (varName, options) {
      return this[name + this.endian](varName, options);
    };
  });

module.exports = Bin;
