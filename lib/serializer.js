"use strict";

module.exports = Serializer;

const PRIMITIVE_TYPES = require("./primitive_types.json");
const DEBUG = process.env.NODE_ENV === "test";

function getGetVarFunc(varName) {
  return function (obj) {
    if (!(varName in obj)) throw new Error("var `" + varName + "` not found");
    return obj[varName];
  };
}

function getGetLengthFunc(length) {
  if (typeof length === "number") {
    return function (obj) {
      return length;
    };
  }

  if (typeof length === "string") {
    return function (obj) {
      return obj[length];
    };
  }

  if (typeof length === "function") {
    return function (obj) {
      return length.call(obj);
    };
  }

  throw new Error("unrecognized length " + length);
}

function Serializer() {
  this.sizeFunc = function (obj) {
    return 0;
  };
  this.writeFunc = function (obj, buf) {
    return 0;
  };
  this.vars = new Set();
}

Serializer.prototype.serialize = function (obj, buf) {
  if (!Buffer.isBuffer(buf)) {
    const size = this.sizeFunc(obj);
    buf = new Buffer(size);

    if (DEBUG) {
      buf.fill(0);
    }
  }

  this.writeFunc(obj, buf);

  return buf;
};

Serializer.prototype.string = function (varName, options) {
  var getVar = this._getVarFunc(varName, options);

  var sizeFunc = this.sizeFunc;
  var writeFunc = this.writeFunc;

  var encoding = options.encoding || "utf8";

  var getByteLength = function (obj) {
    return Buffer.byteLength(getVar(obj), encoding);
  };

  if (options.length) {
    var getLength =
      options.length === Infinity
        ? getByteLength
        : getGetLengthFunc(options.length);

    this.sizeFunc = options.zeroTerminated
      ? function (obj) {
          return (
            Math.min(getLength(obj), getByteLength(obj) + 1) + sizeFunc(obj)
          );
        }
      : function (obj) {
          return getLength(obj) + sizeFunc(obj);
        };

    var addZeros = options.zeroTerminated
      ? function (written, len) {
          return written < len ? 1 : 0;
        }
      : options.stripNull
      ? function stripNull(written, len) {
          return len - written;
        }
      : function (val, len) {
          return 0;
        };

    this.writeFunc = function (obj, buf) {
      var offset = writeFunc(obj, buf);
      var len = getLength(obj);
      var written = buf.write(getVar(obj), offset, len, encoding);
      var toAdd = addZeros(written, len);

      for (var i = 0; i < toAdd; i++) {
        buf[offset + written + i] = 0;
      }

      return offset + written + toAdd;
    };

    return this;
  }

  if (options.zeroTerminated) {
    this.sizeFunc = function (obj) {
      return getByteLength(obj) + 1 + sizeFunc(obj);
    };

    this.writeFunc = function (obj, buf) {
      var offset = writeFunc(obj, buf);
      var val = getVar(obj);

      return offset + buf.write(val + "\0", offset, val.length + 1, encoding);
    };

    return this;
  }

  throw new Error(
    ".string() needs either a length or a zero-terminated string"
  );
};

Serializer.prototype.nest = function (varName, options) {
  const getVar = this._getVarFunc(varName, options);

  const sizeFunc = this.sizeFunc;
  const writeFunc = this.writeFunc;

  const typeSize = options.type.sizeFunc;
  const typeWrite = options.type.writeFunc;

  this.sizeFunc = function (obj) {
    return typeSize(getVar(obj)) + sizeFunc(obj);
  };

  this.writeFunc = function (obj, buf) {
    const offset = writeFunc(obj, buf);
    return offset + typeWrite(getVar(obj), buf.slice(offset));
  };
};

Serializer.prototype.fixedSizeNest = function (varName, options, type) {
  const getVar = this._getVarFunc(varName, options);

  const sizeFunc = this.sizeFunc;
  const writeFunc = this.writeFunc;

  const typeWrite = type.writeFunc;

  const getLength = getGetLengthFunc(options.length);

  this.sizeFunc = function (obj) {
    return getLength(obj) + sizeFunc(obj);
  };

  this.writeFunc = function (obj, buf) {
    const offset = writeFunc(obj, buf);
    const written = typeWrite(getVar(obj), buf.slice(offset));
    const length = getLength(obj);

    if (written > length) {
      throw new Error("Nested type wrote too much");
    }

    return offset + length;
  };
};

Serializer.prototype.array = function (varName, options, type) {
  // TODO check if passed array has acceptable length
  var getVar = this._getVarFunc(varName, options);

  if (typeof options.key === "string") {
    const plainVar = getVar;
    getVar = function (obj) {
      var val = plainVar(obj);
      return Object.keys(val).map(function (key) {
        if (val[key][options.key] !== key) throw new Error("invalid mapping");
        return val[key];
      });
    };
  }

  const sizeFunc = this.sizeFunc;
  const writeFunc = this.writeFunc;

  const typeSize = type.sizeFunc;
  const typeWrite = type.writeFunc;

  this.sizeFunc = function (obj) {
    const arr = getVar(obj);
    var sum = 0;
    for (var i = 0; i < arr.length; i++) {
      sum += typeSize(arr[i]);
    }
    return sum + sizeFunc(obj);
  };

  this.writeFunc = function (obj, buf) {
    const arr = getVar(obj);
    var offset = writeFunc(obj, buf);
    for (var i = 0; i < arr.length; i++) {
      offset += typeWrite(arr[i], buf.slice(offset));
    }
    return offset;
  };
};

Serializer.prototype.choice = function (varName, options, getChoice) {
  const getVar = this._getVarFunc(varName, options);

  const sizeFunc = this.sizeFunc;
  const writeFunc = this.writeFunc;

  this.sizeFunc = function (obj) {
    return getChoice(obj).sizeFunc(getVar(obj)) + sizeFunc(obj);
  };

  this.writeFunc = function (obj, buf) {
    var offset = writeFunc(obj, buf);
    return offset + getChoice(obj).writeFunc(getVar(obj), buf.slice(offset));
  };
};

Serializer.prototype.buffer = function (varName, options) {
  // TODO check for length
  var getVar = this._getVarFunc(varName, options);

  var sizeFunc = this.sizeFunc;
  var writeFunc = this.writeFunc;

  this.sizeFunc = function (obj) {
    return getVar(obj).length + sizeFunc(obj);
  };

  this.writeFunc = function (obj, buf) {
    var offset = writeFunc(obj, buf);
    return offset + getVar(obj).copy(buf, offset);
  };
};

Object.keys(PRIMITIVE_TYPES).forEach(function (primitiveName) {
  const writeKey = "write" + primitiveName;
  const primitiveSize = PRIMITIVE_TYPES[primitiveName];

  Serializer.prototype[primitiveName.toLowerCase()] = function (
    varName,
    options
  ) {
    const getVar = this._getVarFunc(varName, options);

    // add the size of the primitive
    const sizeFunc = this.sizeFunc;
    this.sizeFunc = function (obj) {
      return primitiveSize + sizeFunc(obj);
    };

    const writeFunc = this.writeFunc;
    this.writeFunc = function (obj, buf) {
      const offset = writeFunc(obj, buf);
      return buf[writeKey](getVar(obj), offset);
    };
  };
});

Serializer.prototype._processBitfield = function (reqs, length) {
  const beforePrepareFunc = this.writeFunc;
  this.writeFunc = function prepare(obj, buf) {
    const offset = beforePrepareFunc(obj, buf);
    buf[offset] = 0;
    return offset;
  };

  var sum = 0;

  // write sum as a side effect
  this.writeFunc = reqs.reduce(function (writeFunc, req) {
    const i = req.i;

    const innerByteOffset = sum % 8;
    sum += i; // SIDEEFFECT

    const getVar = req.vars.map(getGetVarFunc).reduce(function (p, n) {
      return function (obj) {
        return n(p(obj));
      };
    });

    return function (obj, buf) {
      var offset = writeFunc(obj, buf);
      var val = getVar(obj);
      var bitsWrittenInByte = innerByteOffset;
      var remainingBitsToWrite = i;

      while (remainingBitsToWrite > 0) {
        // only consider first `shiftAmount` writable bits
        // if `shiftAmount` is negative, there are bits left over
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
    // if there is an incomplete byte, ensure we continue at next byte
    const beforeCompleteFunc = this.writeFunc;
    this.writeFunc = function complete(obj, buf) {
      return 1 + beforeCompleteFunc(obj, buf);
    };
  }

  const sizeFunc = this.sizeFunc;
  const bytes = Math.ceil(length / 8);

  this.sizeFunc = function (obj) {
    return bytes + sizeFunc(obj);
  };
};

Serializer.prototype._getVarFunc = function (varName, options) {
  // to ensure getting a value is the same while reading & serializing
  if (this.vars.has(varName)) throw new Error("duplicated var name");
  this.vars.add(varName);

  if (options && options.formatter && !options.deformatter) {
    throw new Error("formats need to be reversible");
  }

  if (options && options.deformatter) {
    var deformatter = options.deformatter;

    if (options.flatten) {
      return deformatter;
    }

    return function (obj) {
      return deformatter(obj[varName], obj);
    };
  }

  if (options && options.flatten) {
    return function (obj) {
      return obj;
    };
  }

  return getGetVarFunc(varName);
};
