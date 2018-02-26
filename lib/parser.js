'use strict'

module.exports = Parser

const PRIMITIVE_TYPES = require('./primitive_types.json')
const getType = require('./type_functions.js')

const TransformStream = require('stream').Transform

const DEBUG = process.env.NODE_ENV === 'test'
var checkValue = DEBUG ? require('assert').equal : function () {}

// create new objects
function PlainConstructor () {}

function Parser () {
  this.readFunc = function (read, obj, cb) { cb(read, obj) }
  this.constructorFn = PlainConstructor
  this.fixedSize = 0
}

Parser.prototype.parse = function (buffer) {
  return parse(this, buffer)
}

function parse (type, buffer, parentObject) {
  var result = null
  var offset = 0

  const Constructor = type.constructorFn

  type.readFunc(
    function (bytes, cb) {
      var off = offset
      offset += bytes
      cb(buffer, off, offset > buffer.length)
    },
    parentObject ? new Constructor(parentObject) : new Constructor(),
    function cb (read, obj, done) {
      result = obj
    }
  )

  return result
}

Parser.prototype.stream = function () {
  const readFunc = this.readFunc
  const Constructor = this.constructorFn
  var currentRequest = Infinity
  var currentCallback = null
  const chunks = []
  var chunkTotalLength = 0
  var availableBytes = 0
  var offset = 0

  const stream = new TransformStream({
    readableObjectMode: true,
    transform: function (chunk, encoding, done) {
      chunks.push(chunk)
      availableBytes += chunk.length
      chunkTotalLength += chunk.length

      if (currentRequest <= availableBytes) {
        parseBytes(currentCallback, currentRequest)
      }

      done()
    },
    flush: function (done) {
      if (currentCallback) {
        currentCallback(Buffer.concat(chunks, chunkTotalLength), offset, true)
      }
      done()
    }
  })

  readFromStream()

  return stream

  function readFromStream () {
    readFunc(
      function (bytes, cb) {
        if (bytes <= availableBytes) {
          parseBytes(cb, bytes)
        } else {
          currentRequest = bytes
          currentCallback = cb
        }
      },
      new Constructor(),
      function cb (read, obj, done) {
        stream.push(obj)
        readFromStream()
      }
    )
  }

  function parseBytes (cb, bytes) {
    if (chunks[0].length - offset < bytes) {
      if (offset > 1024) {
        chunks[0] = chunks[0].slice(offset)
        chunkTotalLength -= offset
        offset = 0
      }

      chunks[0] = Buffer.concat(chunks, chunkTotalLength)
      chunks.length = 1
    }

    availableBytes -= bytes

    const chunk = chunks[0]
    const curOffset = offset

    if (chunk.length - offset === bytes) {
      chunks.shift()
      chunkTotalLength -= bytes
      offset = 0
    } else {
      offset += bytes
    }

    cb(chunk, curOffset, false)
  }
}

Parser.prototype.create = function (constructorFn) {
  this.constructorFn = constructorFn
  return this
}

Parser.prototype.choice = function (varName, options, getChoice) {
  const writeFunc = getWriteFunc(varName, options)

  this._addReadFunc(function (read, obj, cb) {
    const choice = getChoice(obj)
    const TypeConstructor = choice.constructorFn
    choice.readFunc(read, new TypeConstructor(obj), function (read, inner, done) {
      writeFunc(obj, inner)
      cb(read, obj, done)
    })
  })

  this.fixedSize = NaN
}

Parser.prototype.array = function (varName, options, type) {
  var writeFunc = getWriteFunc(varName, options)
  const typeRead = type.readFunc
  const TypeConstructor = type.constructorFn

  const length = options.readUntil === 'eof' || typeof options.length === 'undefined'
                  ? function (obj) { return Infinity }
                  : wrapOption(options.length, 'length')

  const readUntil = typeof options.readUntil === 'function' && options.readUntil

  if (readUntil.length > 1) {
    throw new Error('read-ahead is not supported in readUntil functions')
  }

  this.fixedSize += typeof options.length === 'number' ? options.length * type.fixedSize : NaN

  // associative arrays
  if (typeof options.key === 'string') {
    const writeVal = writeFunc
    const keyKey = options.key
    writeFunc = function (obj, val) {
      const map = {}
      for (var i = 0; i < val.length; i++) {
        map[val[i][keyKey]] = val[i]
      }
      writeVal(obj, map)
    }
  }

  this._addReadFunc(function (read, obj, cb) {
    checkValue(cb.length, 3)
    const len = length(obj)
    const vals = []

    readNext()

    function readNext () {
      typeRead(read, new TypeConstructor(obj), function (read, val, done) {
        if (!done) vals.push(val)

        if (vals.length < len && !done && !(readUntil && readUntil(val))) {
          readNext()
        } else if (done && isFinite(len)) {
          cb(read, null, true)
        } else {
          writeFunc(obj, vals)
          cb(read, obj, done)
        }
      })
    }
  })
}

Parser.prototype.string = function (varName, options) {
  const encoding = options.encoding || 'utf8'
  var writeFunc = getWriteFunc(varName, options)

  if (options.stripNull) {
    const nextFunc = writeFunc
    writeFunc = function stripNull (obj, val) {
      nextFunc(obj, val.replace(/\0+$/, ''))
    }
  }

  const length = wrapOption(options.length || Infinity, 'length')

  this.fixedSize += typeof options.length === 'number' ? options.length : NaN

  if (options.zeroTerminated) {
    this._addReadFunc(function zeroTerminatedStr (read, obj, cb) {
      checkValue(cb.length, 3)
      const len = length(obj)
      const parts = []
      var lastBuf = null
      var bufStartOffset = 0
      var curLen = 0

      read(1, function checkByte (buf, offset, done) {
        if (!done && buf !== lastBuf && buf[offset] !== 0) {
          if (lastBuf !== null) {
            parts.push(lastBuf.slice(bufStartOffset))
          }

          lastBuf = buf
          bufStartOffset = offset
        }

        if (done || buf[offset] === 0 || ++curLen === len) {
          if (parts.length > 0) {
            parts.push(lastBuf.slice(bufStartOffset))
            lastBuf = Buffer.concat(parts, curLen)
            bufStartOffset = 0
          }

          if (done && lastBuf === null) {
            cb(read, null, done)
            return
          }

          writeFunc(obj, lastBuf.toString(encoding, bufStartOffset, bufStartOffset + curLen))
          cb(read, obj, done)
        } else {
          read(1, checkByte)
        }
      })
    })
  } else if (options.length) {
    this._addReadLength(writeFunc, length, function (buf, offset, len) {
      return buf.toString(encoding, offset, offset + len)
    }, true)
  } else {
    throw new Error('either a length or zeroTerminated must be defined')
  }
}

Parser.prototype.buffer = function (varName, options) {
  var writeFunc = getWriteFunc(varName, options)

  if (options && options.clone) {
    const nextFunc = writeFunc
    writeFunc = function copyBuf (obj, val) {
      var buf = new Buffer(val.length)
      val.copy(buf)
      nextFunc(obj, buf)
    }
  }

  const length = options.readUntil === 'eof'
                  ? Infinity
                  : wrapOption(options.length, 'length')

  this.fixedSize += typeof options.length === 'number' ? options.length : NaN

  this._addReadLength(writeFunc, length, function (buf, offset, len) {
    return buf.slice(offset, offset + len)
  }, true)
}

Parser.prototype.nest = function (varName, options) {
  const writeFunc = getWriteFunc(varName, options)
  const type = getType(options.type)
  const typeRead = type.readFunc
  const TypeConstructor = type.constructorFn

  this._addReadFunc(function (read, obj, cb) {
    checkValue(cb.length, 3)
    typeRead(read, new TypeConstructor(obj), function (read, val, done) {
      writeFunc(obj, val)
      cb(read, val && obj, done)
    })
  })

  this.fixedSize += isFinite(type.fixedSize) ? type.fixedSize : NaN
}

function wrapLength (length) {
  if (typeof length === 'number') {
    // TODO use specialized function
    return function wrappedLength (obj) { return length }
  }

  checkValue(typeof length, 'function')

  return length
}

Parser.prototype.fixedSizeNest = function (varName, options) {
  const writeFunc = getWriteFunc(varName, options)
  const type = getType(options.type)
  const typeRead = type.readFunc
  const TypeConstructor = type.constructorFn

  let length = wrapOption(options.length, 'length')
  this.fixedSize += typeof options.length === 'number' ? options.length : NaN

  length = wrapLength(length)

  this._addReadFunc(function fixedSizeNest (read, obj, cb) {
    checkValue(!obj, false)
    checkValue(cb.length, 3)

    let len = length(obj)
    let realEnd = true

    function readFixed (reqLength, cb) {
      if (len < reqLength) {
        return read(len, function (buffer, offset, done) {
          realEnd = done

          if (buffer.length > len + offset) {
            buffer = buffer.slice(0, offset + len)
          }

          cb(buffer, offset, true)
        })
      }

      len -= reqLength
      read(reqLength, cb)
    }

    typeRead(readFixed, new TypeConstructor(obj), function (_read, val, done) {
      writeFunc(obj, val)

      if (realEnd && len > 0) {
        read(len, function (_buffer, _offset, done) {
          cb(read, obj, done)
        })
      } else {
        cb(read, obj, realEnd && done)
      }
    })
  })
}

Object.keys(PRIMITIVE_TYPES).forEach(function (key) {
  const readKey = 'read' + key

  Parser.prototype[key.toLowerCase()] = function (varName, options) {
    this._addReadLength(
      getWriteFunc(varName, options),
      PRIMITIVE_TYPES[key],
      function (buf, offset, len) {
        return buf[readKey](offset)
      }
    )

    this.fixedSize += PRIMITIVE_TYPES[key]
  }
})

Parser.prototype.processBitfield = function (bitfield, length) {
  var sum = length

  // TODO use larger groupings
  const readBitfield = bitfield.reduceRight(function (nextFunc, req) {
    const bits = req.i
    const writeFunc = req.vars.length === 1
                        ? getWriteFunc(req.vars[0], req.options)
                        : function (obj, val) {
                          for (var i = 0; i < req.vars.length - 1; i++) {
                            if (!(req.vars[i] in obj)) obj[req.vars[i]] = {} // TODO constructor
                            obj = obj[req.vars[i]]
                          }
                          obj[req.vars[i]] = val
                        }

    const remainingBitsInLastByte = (8 - sum % 8) % 8
    sum -= bits
    const remainingBitsInFirstByte = (8 - sum % 8) % 8
    const bitMask = (1 << remainingBitsInLastByte) - 1

    var processFunc = function (read, obj, remainder, cb) {
      writeFunc(obj, remainder >> remainingBitsInLastByte)
      nextFunc(read, obj, remainder & bitMask, cb)
    }

    const requiredBytes = Math.ceil((bits - remainingBitsInFirstByte) / 8)

    for (var requested = 0; requested < requiredBytes; requested++) {
      const remaining = requiredBytes - requested
      const curRequest = remaining >= 4 ? 4 : remaining >= 2 ? 2 : 1
      processFunc = addByteRequest(processFunc, curRequest, requested <= 4)

      requested += curRequest - 1
    }

    return processFunc
  }, function (read, obj, remainder, cb) {
    cb(read, obj, false)
  })

  this._addReadFunc(function (read, obj, cb) {
    readBitfield(read, obj, 0, cb)
  })

  this.fixedSize += Math.ceil(length / 8)
}

function addByteRequest (nextFunc, bytes, useBinOps) {
  const readFunc = getReadFunc(bytes)
  const sham = bytes << 3

  if (useBinOps) {
    return function readBit (read, obj, remainder, cb) {
      read(bytes, function (buffer, offset, done) {
        if (done) cb(read, null, true)
        else nextFunc(read, obj, remainder << sham | readFunc(buffer, offset), cb)
      })
    }
  }

  // may loose accuracy after 25 bits,
  // can't use binary ops anymore

  const multiplier = 1 << sham

  return function readBitNonBinary (read, obj, remainder, cb) {
    read(bytes, function (buffer, offset, done) {
      if (done) cb(read, null, true)
      else nextFunc(read, obj, (remainder * multiplier) + readFunc(buffer, offset), cb)
    })
  }
}

function getReadFunc (bytes) {
  // use specialized functions for 1, 2 & 4 bytes
  switch (bytes) {
    case 1:
      return function read8 (buffer, offset) {
        return buffer[offset]
      }
    case 2:
      return function read16 (buffer, offset) {
        return buffer.readInt16BE(offset)
      }
    case 4:
      return function read32 (buffer, offset) {
        return buffer.readInt32BE(offset)
      }
    default: throw new Error('unsupported request')
  }
}

Parser.prototype._addReadLength = function (writeFunc, length, readVal, allowLess) {
  length = wrapLength(length)

  this._addReadFunc(function readLength (read, obj, cb) {
    checkValue(cb.length, 3)
    const len = length(obj)

    read(len, function processReadLength (buf, offset, done) {
      if (!allowLess && done) {
        cb(read, null, done)
      } else {
        writeFunc(obj, readVal(buf, offset, len, obj))
        cb(read, obj, done)
      }
    })
  })
}

Parser.prototype._addReadFunc = function (nextFunc) {
  const readFunc = this.readFunc

  checkValue(nextFunc.length, 3)
  checkValue(readFunc.length, 3)

  this.readFunc = function callPrev (read, obj, cb) {
    readFunc(read, obj, function executedPrev (read, obj, done) {
      if (done) cb(read, null, true)
      else nextFunc(read, obj, cb)
    })
  }

  /*
  this.readFunc.next = nextFunc
  this.readFunc.prev = readFunc
  */
}

/*
function printFunctionTree (func) {
  while (func) {
    console.log(func.next)
    func = func.prev
  }
}
*/

function wrapOption (opt, name) {
  if (typeof opt === 'number') {
    return function (obj) { return opt }
  }

  if (typeof opt === 'string') {
    return function (obj) {
      if (!(opt in obj)) throw new Error(opt + ' not present in object')
      return obj[opt]
    }
  }

  if (typeof opt === 'function') {
    return function (obj) { return opt.call(obj) }
  }

  throw new Error('can\'t handle option ' + name)
}

function getWriteFunc (varName, options) {
  var writeFunc = function (obj, val) {
    obj[varName] = val
  }

  if (options && options.flatten) {
    writeFunc = function (obj, val) {
      if (obj === val) return
      if (val === null) return

      if (typeof val !== 'object') {
        throw new Error('flatten option on primitive parser')
      }

      for (var key in val) {
        if (Object.prototype.hasOwnProperty.call(val, key)) {
          obj[key] = val[key]
        }
      }
    }
  }

  if (options && options.assert) {
    writeFunc = getAssertFunc(varName, options, writeFunc)
  }

  if (options && options.formatter) {
    const formatter = options.formatter
    return function (obj, val) {
      writeFunc(obj, formatter.call(obj, val))
    }
  }

  return writeFunc
}

function getAssertFunc (varName, options, writeFunc) {
  const assert = options.assert

  function errFunc (val) {
    throw new Error('Assert error: `' + varName + '` is `' + val + '`')
  }

  if (typeof assert === 'function') {
    return function assertFn (obj, val) {
      if (!assert.call(obj, val)) errFunc(val)
      else writeFunc(obj, val)
    }
  }

  if (typeof assert === 'string' || typeof assert === 'number') {
    return function assertEq (obj, val) {
      if (val !== assert) errFunc(val)
      else writeFunc(obj, val)
    }
  }

  throw new Error('assert option only supports functions, strings and numbers')
}
