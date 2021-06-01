"use strict";

const PRIMITIVE_TYPES = require("./primitive_types.json");
const DEBUG = process.env.NODE_ENV === "test";

function getGetVarFunc(varName) {
  return (obj) => {
    if (!(varName in obj)) throw new Error(`var \`${varName}\` not found`);
    return obj[varName];
  };
}

function getGetLengthFunc(length) {
  if (typeof length === "number") {
    return () => length;
  }

  if (typeof length === "string") {
    return (obj) => obj[length];
  }

  if (typeof length === "function") {
    return (obj) => length.call(obj);
  }

  throw new Error(`unrecognized length ${length}`);
}

class Serializer {
  sizeFunc = (obj) => 0;
  writeFunc = (obj, buf) => 0;
  vars = new Set();

  serialize(obj, buf) {
    if (!Buffer.isBuffer(buf)) {
      const size = this.sizeFunc(obj);
      buf = Buffer.alloc(size);

      if (DEBUG) {
        buf.fill(0);
      }
    }

    this.writeFunc(obj, buf);

    return buf;
  }

  string(varName, options) {
    const getVar = this._getVarFunc(varName, options);

    const { sizeFunc } = this;
    const { writeFunc } = this;

    const encoding = options.encoding || "utf8";

    const getByteLength = (obj) => Buffer.byteLength(getVar(obj), encoding);

    if (options.length) {
      const getLength =
        options.length === Infinity
          ? getByteLength
          : getGetLengthFunc(options.length);

      this.sizeFunc = options.zeroTerminated
        ? (obj) =>
            Math.min(getLength(obj), getByteLength(obj) + 1) + sizeFunc(obj)
        : (obj) => getLength(obj) + sizeFunc(obj);

      const addZeros = options.zeroTerminated
        ? (written, len) => (written < len ? 1 : 0)
        : options.stripNull
        ? (written, len) => len - written
        : () => 0;

      this.writeFunc = (obj, buf) => {
        const offset = writeFunc(obj, buf);
        const len = getLength(obj);
        const written = buf.write(getVar(obj), offset, len, encoding);
        const toAdd = addZeros(written, len);

        for (let i = 0; i < toAdd; i++) {
          buf[offset + written + i] = 0;
        }

        return offset + written + toAdd;
      };

      return this;
    }

    if (options.zeroTerminated) {
      this.sizeFunc = (obj) => getByteLength(obj) + 1 + sizeFunc(obj);

      this.writeFunc = (obj, buf) => {
        const offset = writeFunc(obj, buf);
        const val = getVar(obj);

        return offset + buf.write(`${val}\0`, offset, val.length + 1, encoding);
      };

      return this;
    }

    throw new Error(
      ".string() needs either a length or a zero-terminated string"
    );
  }

  nest(varName, options) {
    const getVar = this._getVarFunc(varName, options);

    const { sizeFunc } = this;
    const { writeFunc } = this;

    const typeSize = options.type.sizeFunc;
    const typeWrite = options.type.writeFunc;

    this.sizeFunc = (obj) => typeSize(getVar(obj)) + sizeFunc(obj);

    this.writeFunc = (obj, buf) => {
      const offset = writeFunc(obj, buf);
      return offset + typeWrite(getVar(obj), buf.slice(offset));
    };
  }

  fixedSizeNest(varName, options, type) {
    const getVar = this._getVarFunc(varName, options);

    const { sizeFunc } = this;
    const { writeFunc } = this;

    const typeWrite = type.writeFunc;

    const getLength = getGetLengthFunc(options.length);

    this.sizeFunc = (obj) => getLength(obj) + sizeFunc(obj);

    this.writeFunc = (obj, buf) => {
      const offset = writeFunc(obj, buf);
      const written = typeWrite(getVar(obj), buf.slice(offset));
      const length = getLength(obj);

      if (written > length) {
        throw new Error("Nested type wrote too much");
      }

      return offset + length;
    };
  }

  array(varName, options, type) {
    // TODO check if passed array has acceptable length
    let getVar = this._getVarFunc(varName, options);

    if (typeof options.key === "string") {
      const plainVar = getVar;
      getVar = (obj) => {
        const val = plainVar(obj);
        return Object.keys(val).map((key) => {
          if (val[key][options.key] !== key) throw new Error("invalid mapping");
          return val[key];
        });
      };
    }

    const { sizeFunc } = this;
    const { writeFunc } = this;

    const typeSize = type.sizeFunc;
    const typeWrite = type.writeFunc;

    this.sizeFunc = (obj) => {
      const arr = getVar(obj);
      let sum = 0;
      for (let i = 0; i < arr.length; i++) {
        sum += typeSize(arr[i]);
      }
      return sum + sizeFunc(obj);
    };

    this.writeFunc = (obj, buf) => {
      const arr = getVar(obj);
      let offset = writeFunc(obj, buf);
      for (let i = 0; i < arr.length; i++) {
        offset += typeWrite(arr[i], buf.slice(offset));
      }
      return offset;
    };
  }

  choice(varName, options, getChoice) {
    const getVar = this._getVarFunc(varName, options);

    const { sizeFunc } = this;
    const { writeFunc } = this;

    this.sizeFunc = (obj) =>
      getChoice(obj).sizeFunc(getVar(obj)) + sizeFunc(obj);

    this.writeFunc = (obj, buf) => {
      const offset = writeFunc(obj, buf);
      return offset + getChoice(obj).writeFunc(getVar(obj), buf.slice(offset));
    };
  }

  buffer(varName, options) {
    // TODO check for length
    const getVar = this._getVarFunc(varName, options);

    const { sizeFunc } = this;
    const { writeFunc } = this;

    this.sizeFunc = (obj) => getVar(obj).length + sizeFunc(obj);

    this.writeFunc = (obj, buf) => {
      const offset = writeFunc(obj, buf);
      return offset + getVar(obj).copy(buf, offset);
    };
  }

  _processBitfield(reqs, length) {
    const beforePrepareFunc = this.writeFunc;
    this.writeFunc = function prepare(obj, buf) {
      const offset = beforePrepareFunc(obj, buf);
      buf[offset] = 0;
      return offset;
    };

    let sum = 0;

    // Write sum as a side effect
    this.writeFunc = reqs.reduce((writeFunc, req) => {
      const { i } = req;

      const innerByteOffset = sum % 8;
      sum += i; // SIDEEFFECT

      const getVar = req.vars
        .map(getGetVarFunc)
        .reduce((p, n) => (obj) => n(p(obj)));

      return (obj, buf) => {
        let offset = writeFunc(obj, buf);
        let val = getVar(obj);
        let bitsWrittenInByte = innerByteOffset;
        let remainingBitsToWrite = i;

        while (remainingBitsToWrite > 0) {
          /*
           * Only consider first `shiftAmount` writable bits
           * if `shiftAmount` is negative, there are bits left over
           */
          const shiftAmount = bitsWrittenInByte + remainingBitsToWrite - 8;
          buf[offset] |=
            shiftAmount < 0 ? val << -shiftAmount : val >> shiftAmount;

          remainingBitsToWrite -= 8 - bitsWrittenInByte;

          if (remainingBitsToWrite >= 0) {
            val &= (1 << remainingBitsToWrite) - 1;
            offset += 1;
            buf[offset] = 0;
            bitsWrittenInByte = 0;
          }
        }

        return offset;
      };
    }, this.writeFunc);

    if (length % 8) {
      // If there is an incomplete byte, ensure we continue at next byte
      const beforeCompleteFunc = this.writeFunc;
      this.writeFunc = function complete(obj, buf) {
        return 1 + beforeCompleteFunc(obj, buf);
      };
    }

    const { sizeFunc } = this;
    const bytes = Math.ceil(length / 8);

    this.sizeFunc = (obj) => bytes + sizeFunc(obj);
  }

  _getVarFunc(varName, options) {
    // To ensure getting a value is the same while reading & serializing
    if (this.vars.has(varName)) throw new Error("duplicated var name");
    this.vars.add(varName);

    if (options && options.formatter && !options.deformatter) {
      throw new Error("formats need to be reversible");
    }

    if (options && options.deformatter) {
      const { deformatter } = options;

      if (options.flatten) {
        return deformatter;
      }

      return (obj) => deformatter(obj[varName], obj);
    }

    if (options && options.flatten) {
      return (obj) => obj;
    }

    return getGetVarFunc(varName);
  }
}

Object.keys(PRIMITIVE_TYPES).forEach((primitiveName) => {
  const writeKey = `write${primitiveName}`;
  const primitiveSize = PRIMITIVE_TYPES[primitiveName];

  Serializer.prototype[primitiveName.toLowerCase()] = function (
    varName,
    options
  ) {
    const getVar = this._getVarFunc(varName, options);

    // Add the size of the primitive
    const { sizeFunc } = this;
    this.sizeFunc = (obj) => primitiveSize + sizeFunc(obj);

    const { writeFunc } = this;
    this.writeFunc = (obj, buf) => {
      const offset = writeFunc(obj, buf);
      return buf[writeKey](getVar(obj), offset);
    };
  };
});

module.exports = Serializer;
