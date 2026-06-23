"use strict";

const Parser = require("./lib/parser.js");
const Serializer = require("./lib/serializer.js");

const getType = require("./lib/type_functions.js");

const PRIMITIVE_TYPES = require("./lib/primitive_types.json");
const PRIMITIVES = Object.keys(PRIMITIVE_TYPES).map((key) => key.toLowerCase());

// Array with ints 1..24
const BIT_VALS = Array.apply(null, Array(32)).map((_, i) => i + 1);

class Bin {
  parser = new Parser();
  serializer = new Serializer();
  endian = "be";
  bitRequests = [];

  static start = () => new Bin();

  static Parser = Bin; // Work as drop-in replacement for binary-parser

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

    const {choices} = options;
    const mappedChoices = {};

    for (const key in choices) {
      mappedChoices[key] = getType(choices[key]);
    }

    const defaultChoice =
      options.defaultChoice && getType(options.defaultChoice);

    const {tag} = options;
    const getTag =
      typeof tag === "function"
        ? tag
        : (obj) => {
            if (!(tag in obj))
              {throw new Error(`tag \`${tag}\` not found in object`);}
            return obj[tag];
          };

    const getChoice = defaultChoice
      ? (obj) => {
          const key = getTag(obj);
          return key in mappedChoices ? mappedChoices[key] : defaultChoice;
        }
      : (obj) => {
          const choice = mappedChoices[getTag(obj)];
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
    /* Do nothing */
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
    const type = getType(options.type, true);
    const opts = { __proto__: options, type };

    if (type.bitRequests.length) {
      this.bitRequests = this.bitRequests.concat(
        type.bitRequests.map((req) => ({
            i: req.i,
            vars: [varName].concat(req.vars),
            options: req.options,
            // TODO support constructors
          }), this)
      );
    }

    this.parser.nest(varName, opts);
    this.serializer.nest(varName, opts);
    return this;
  }

  _flushBitfield() {
    let reqs = this.bitRequests;

    if (!reqs.length) return;
    if (this.endian === "le") reqs = reqs.reverse();

    const length = reqs.reduce((sum, req) => sum + req.i, 0);

    this.serializer._processBitfield(reqs, length);
    this.parser.processBitfield(reqs, length);

    this.bitRequests = [];
  }

  // Copied from binary_parser.js
  endianess(endianess) {
    switch (endianess.toLowerCase()) {
      case "little":
        this.endian = "le";
        break;
      case "big":
        this.endian = "be";
        break;
      default:
        throw new Error(`Invalid endianess: ${  endianess}`);
    }

    return this;
  }

  // Alias properties
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

["string", "buffer", "array", "fixedSizeNest", ...PRIMITIVES].forEach(
  (name) => {
    Bin.prototype[name] = function (varName, options) {
      this._flushBitfield();

      const type = options && options.type && getType(options.type);

      this.parser[name](varName, options, type);
      this.serializer[name](varName, options, type);
      return this;
    };
  }
);

BIT_VALS.forEach((i) => {
  Bin.prototype[`bit${  i}`] = function (varName, options) {
    // TODO support constructors
    this.bitRequests.push({ i, vars: [varName], options });
    return this;
  };
});

Object.keys(PRIMITIVE_TYPES)
  .filter((p) => p.endsWith("BE"))
  .map((p) => p.toLowerCase())
  .forEach((primitiveName) => {
    const name = primitiveName.slice(0, -2).toLowerCase();

    Bin.prototype[name] = function (varName, options) {
      return this[name + this.endian](varName, options);
    };
  });

module.exports = Bin;
