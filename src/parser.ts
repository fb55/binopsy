import { strictEqual } from "node:assert";
import { Transform } from "node:stream";
import { PRIMITIVE_TYPES, type PrimitiveName } from "./primitive-types.ts";
import { getType } from "./type-functions.ts";
import type {
  BitRequest,
  ConstructorFn,
  Continuation,
  FieldOptions,
  Obj,
  ReadCallback,
  ReadFunc,
  ReadRequest,
  ResolvedType,
} from "./types.ts";

const DEBUG = process.env.NODE_ENV === "test";
const checkValue: (actual: unknown, expected: unknown) => void = DEBUG
  ? strictEqual
  : () => {
      /* Checks are only enabled in tests */
    };

/** Default constructor: plain objects. */
const PlainConstructor = function PlainConstructor() {
  return {};
} as unknown as ConstructorFn;

/** A length: fixed, the name of a previously parsed field, or computed from the object. */
export type LengthOption = number | string | ((this: Obj) => number);

export interface StringParseOptions extends FieldOptions {
  encoding?: BufferEncoding;
  length?: LengthOption;
  zeroTerminated?: boolean;
  stripNull?: boolean;
}

export interface BufferParseOptions extends FieldOptions {
  length?: LengthOption;
  readUntil?: "eof";
  clone?: boolean;
}

export interface ArrayParseOptions extends FieldOptions {
  length?: LengthOption;
  readUntil?: "eof" | ((item: never) => boolean);
  key?: string;
}

export interface ChoiceParseOptions extends FieldOptions {
  tag: string | ((this: Obj, obj: Obj) => string | number);
}

export interface NestParseOptions extends FieldOptions {
  length?: LengthOption;
}

/** Result of parsing from an offset. */
export interface ParseResult<T> {
  /** The parsed value. */
  result: T;
  /** Offset of the first byte after the parsed value. */
  offset: number;
}

export class Parser {
  readFunc: ReadFunc = (read, obj, cb) => {
    cb(read, obj, false);
  };
  constructorFn: ConstructorFn = PlainConstructor;
  fixedSize = 0;

  parse(buffer: Buffer): Obj | null {
    return parse(this, buffer, 0).result;
  }

  parseFrom(buffer: Buffer, offset: number): ParseResult<Obj | null> {
    return parse(this, buffer, offset);
  }

  stream(): Transform {
    const { readFunc } = this;
    const Constructor = this.constructorFn;
    let currentRequest = Infinity;
    let currentCallback: ReadCallback | null = null;
    const chunks: Buffer[] = [];
    let chunkTotalLength = 0;
    let availableBytes = 0;
    let offset = 0;

    const stream = new Transform({
      readableObjectMode: true,
      transform(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        availableBytes += chunk.length;
        chunkTotalLength += chunk.length;

        if (currentRequest <= availableBytes && currentCallback) {
          parseBytes(currentCallback, currentRequest);
        }

        done();
      },
      flush(done) {
        if (currentCallback) {
          currentCallback(
            Buffer.concat(chunks, chunkTotalLength),
            offset,
            true,
          );
        }
        done();
      },
    });

    /*
     * Values are parsed in a loop: when a value completes synchronously while
     * the loop is running, it only flags that the next value should be read,
     * so that many small values in one chunk don't grow the stack.
     */
    let readNext = false;
    let reading = false;

    readFromStream();

    return stream;

    function readFromStream() {
      readNext = true;
      if (reading) return;
      reading = true;
      while (readNext) {
        readNext = false;
        readFunc(
          (bytes, cb) => {
            if (bytes <= availableBytes) {
              parseBytes(cb, bytes);
            } else {
              currentRequest = bytes;
              currentCallback = cb;
            }
          },
          new Constructor() as Obj,
          function cb(_read, obj) {
            stream.push(obj);
            readFromStream();
          },
        );
      }
      reading = false;
    }

    function parseBytes(cb: ReadCallback, bytes: number) {
      if (chunks[0].length - offset < bytes) {
        if (offset > 1024) {
          chunks[0] = chunks[0].subarray(offset);
          chunkTotalLength -= offset;
          offset = 0;
        }

        chunks[0] = Buffer.concat(chunks, chunkTotalLength);
        chunks.length = 1;
      }

      availableBytes -= bytes;

      const chunk = chunks[0];
      const curOffset = offset;

      if (chunk.length - offset === bytes) {
        chunks.shift();
        chunkTotalLength -= bytes;
        offset = 0;
      } else {
        offset += bytes;
      }

      cb(chunk, curOffset, false);
    }
  }

  create(constructorFn: ConstructorFn): this {
    this.constructorFn = constructorFn;
    return this;
  }

  choice(
    varName: string,
    options: ChoiceParseOptions,
    getChoice: (obj: Obj) => ResolvedType,
  ): void {
    const writeFunc = getWriteFunc(varName, options);

    this._addReadFunc((read, obj, cb) => {
      const choice = getChoice(obj);
      const TypeConstructor = choice.constructorFn;
      choice.readFunc(
        read,
        new TypeConstructor(obj) as Obj,
        (read, inner, done) => {
          writeFunc(obj, inner);
          cb(read, obj, done);
        },
      );
    });

    this.fixedSize = NaN;
  }

  array(varName: string, options: ArrayParseOptions, type: ResolvedType): void {
    let writeFunc = getWriteFunc(varName, options);
    const typeRead = type.readFunc;
    const TypeConstructor = type.constructorFn;

    const length =
      options.readUntil === "eof" || typeof options.length === "undefined"
        ? () => Infinity
        : wrapOption(options.length, "length");

    const readUntil =
      typeof options.readUntil === "function"
        ? (options.readUntil as (item: unknown) => boolean)
        : null;

    if (readUntil && readUntil.length > 1) {
      throw new Error("read-ahead is not supported in readUntil functions");
    }

    this.fixedSize +=
      typeof options.length === "number"
        ? options.length * type.fixedSize
        : NaN;

    // Associative arrays
    if (typeof options.key === "string") {
      const writeVal = writeFunc;
      const keyKey = options.key;
      writeFunc = (obj, val) => {
        const vals = val as Obj[];
        const map: Obj = {};
        for (let i = 0; i < vals.length; i++) {
          map[vals[i][keyKey]] = vals[i];
        }
        writeVal(obj, map);
      };
    }

    this._addReadFunc((read, obj, cb) => {
      const len = length(obj);
      const vals: unknown[] = [];

      if (len <= 0) {
        writeFunc(obj, vals);
        cb(read, obj, false);
        return;
      }

      /*
       * Items are read in a loop rather than by recursion, so that long
       * arrays don't exhaust the stack when input is available synchronously.
       * `pending` holds the read function for the next item; `onItem` only
       * restarts the loop itself if it was called asynchronously.
       */
      let pending: ReadRequest | null = read;
      let looping = false;

      function onItem(read: ReadRequest, val: unknown, done: boolean) {
        if (!done) vals.push(val);

        if (vals.length < len && !done && !(readUntil && readUntil(val))) {
          pending = read;
          if (!looping) loop();
        } else if (done && isFinite(len)) {
          cb(read, null, true);
        } else {
          writeFunc(obj, vals);
          cb(read, obj, done);
        }
      }

      function loop() {
        looping = true;
        while (pending) {
          const next = pending;
          pending = null;
          typeRead(next, new TypeConstructor(obj) as Obj, onItem);
        }
        looping = false;
      }

      loop();
    });
  }

  string(varName: string, options: StringParseOptions): void {
    const encoding = options.encoding ?? "utf8";
    let writeFunc = getWriteFunc(varName, options);

    if (options.stripNull) {
      const nextFunc = writeFunc;
      writeFunc = function stripNull(obj, val) {
        nextFunc(obj, (val as string).replace(/\0+$/, ""));
      };
    }

    const length = wrapOption(options.length || Infinity, "length");

    this.fixedSize += typeof options.length === "number" ? options.length : NaN;

    if (options.zeroTerminated) {
      this._addReadFunc(function zeroTerminatedStr(read, obj, cb) {
        const len = length(obj);
        const parts: Buffer[] = [];
        let lastBuf: Buffer | null = null;
        let bufStartOffset = 0;
        let curLen = 0;

        // Bytes are requested in a loop rather than recursively (see `array`).
        let more = true;
        let looping = false;

        function loop() {
          looping = true;
          while (more) {
            more = false;
            read(1, checkByte);
          }
          looping = false;
        }

        loop();

        function checkByte(buf: Buffer, offset: number, done: boolean) {
          if (!done && buf !== lastBuf && buf[offset] !== 0) {
            if (lastBuf !== null) {
              parts.push(lastBuf.subarray(bufStartOffset));
            }

            lastBuf = buf;
            bufStartOffset = offset;
          }

          if (done || buf[offset] === 0 || ++curLen === len) {
            if (parts.length > 0 && lastBuf !== null) {
              parts.push(lastBuf.subarray(bufStartOffset));
              lastBuf = Buffer.concat(parts, curLen);
              bufStartOffset = 0;
            }

            if (done && lastBuf === null) {
              cb(read, null, done);
              return;
            }

            writeFunc(
              obj,
              lastBuf === null
                ? ""
                : lastBuf.toString(
                    encoding,
                    bufStartOffset,
                    bufStartOffset + curLen,
                  ),
            );
            cb(read, obj, done);
          } else {
            more = true;
            if (!looping) loop();
          }
        }
      });
    } else if (options.length) {
      this._addReadLength(
        writeFunc,
        length,
        (buf, offset, len) => buf.toString(encoding, offset, offset + len),
        true,
      );
    } else {
      throw new Error("either a length or zeroTerminated must be defined");
    }
  }

  buffer(varName: string, options: BufferParseOptions): void {
    let writeFunc = getWriteFunc(varName, options);

    if (options.clone) {
      const nextFunc = writeFunc;
      writeFunc = function copyBuf(obj, val) {
        const buf = Buffer.alloc((val as Buffer).length);
        (val as Buffer).copy(buf);
        nextFunc(obj, buf);
      };
    }

    const length =
      options.readUntil === "eof"
        ? Infinity
        : wrapOption(options.length, "length");

    this.fixedSize += typeof options.length === "number" ? options.length : NaN;

    this._addReadLength(
      writeFunc,
      length,
      (buf, offset, len) => buf.subarray(offset, offset + len),
      true,
    );
  }

  nest(varName: string, options: FieldOptions & { type: ResolvedType }): void {
    const writeFunc = getWriteFunc(varName, options);
    const type = getType(options.type);
    const typeRead = type.readFunc;
    const TypeConstructor = type.constructorFn;

    this._addReadFunc((read, obj, cb) => {
      typeRead(read, new TypeConstructor(obj) as Obj, (read, val, done) => {
        writeFunc(obj, val);
        cb(read, val && obj, done);
      });
    });

    this.fixedSize += isFinite(type.fixedSize) ? type.fixedSize : NaN;
  }

  fixedSizeNest(
    varName: string,
    options: NestParseOptions,
    typeOption: ResolvedType,
  ): void {
    const writeFunc = getWriteFunc(varName, options);
    const type = getType(typeOption);
    const typeRead = type.readFunc;
    const TypeConstructor = type.constructorFn;

    this.fixedSize += typeof options.length === "number" ? options.length : NaN;

    const length = wrapLength(wrapOption(options.length, "length"));

    this._addReadFunc(function fixedSizeNest(read, obj, cb) {
      checkValue(!obj, false);

      let len = length(obj);
      let realEnd = true;

      const readFixed: ReadRequest = (reqLength, cb) => {
        if (len < reqLength) {
          read(len, (buffer, offset, done) => {
            realEnd = done;

            if (buffer.length > len + offset) {
              buffer = buffer.subarray(0, offset + len);
            }

            cb(buffer, offset, true);
          });
          return;
        }

        len -= reqLength;
        read(reqLength, cb);
      };

      typeRead(
        readFixed,
        new TypeConstructor(obj) as Obj,
        (_read, val, done) => {
          writeFunc(obj, val);

          if (realEnd && len > 0) {
            read(len, (_buffer, _offset, done) => {
              cb(read, obj, done);
            });
          } else {
            cb(read, obj, realEnd && done);
          }
        },
      );
    });
  }

  processBitfield(bitfield: BitRequest[], length: number): void {
    let sum = length;

    type BitStep = (
      read: ReadRequest,
      obj: Obj,
      remainder: number,
      cb: Continuation,
    ) => void;

    // TODO use larger groupings
    const readBitfield = bitfield.reduceRight<BitStep>(
      (nextFunc, req) => {
        const bits = req.i;
        const writeFunc =
          req.vars.length === 1
            ? getWriteFunc(req.vars[0], req.options)
            : (obj: Obj, val: unknown) => {
                let i = 0;
                for (; i < req.vars.length - 1; i++) {
                  if (!(req.vars[i] in obj)) obj[req.vars[i]] = {}; // TODO constructor
                  obj = obj[req.vars[i]] as Obj;
                }
                obj[req.vars[i]] = val;
              };

        const remainingBitsInLastByte = (8 - (sum % 8)) % 8;
        sum -= bits;
        const remainingBitsInFirstByte = (8 - (sum % 8)) % 8;
        const bitMask = (1 << remainingBitsInLastByte) - 1;

        let processFunc: BitStep = (read, obj, remainder, cb) => {
          writeFunc(obj, remainder >> remainingBitsInLastByte);
          nextFunc(read, obj, remainder & bitMask, cb);
        };

        const requiredBytes = Math.ceil((bits - remainingBitsInFirstByte) / 8);

        for (let requested = 0; requested < requiredBytes; requested++) {
          const remaining = requiredBytes - requested;
          const curRequest = remaining >= 4 ? 4 : remaining >= 2 ? 2 : 1;
          processFunc = addByteRequest(processFunc, curRequest, requested <= 4);

          requested += curRequest - 1;
        }

        return processFunc;
      },
      (read, obj, _remainder, cb) => {
        cb(read, obj, false);
      },
    );

    this._addReadFunc((read, obj, cb) => {
      readBitfield(read, obj, 0, cb);
    });

    this.fixedSize += Math.ceil(length / 8);
  }

  /** Reads a fixed-size primitive. */
  primitive(
    name: PrimitiveName,
    varName: string,
    options?: FieldOptions,
  ): void {
    const { size, read: readKey } = PRIMITIVE_TYPES[name];
    const readMethod = Buffer.prototype[readKey] as (
      this: Buffer,
      offset: number,
    ) => unknown;

    this._addReadLength(getWriteFunc(varName, options), size, (buf, offset) =>
      readMethod.call(buf, offset),
    );

    this.fixedSize += size;
  }

  private _addReadLength(
    writeFunc: (obj: Obj, val: unknown) => void,
    lengthOption: number | ((obj: Obj) => number),
    readVal: (buf: Buffer, offset: number, len: number, obj: Obj) => unknown,
    allowLess = false,
  ): void {
    const length = wrapLength(lengthOption);

    this._addReadFunc(function readLength(read, obj, cb) {
      const len = length(obj);

      read(len, function processReadLength(buf, offset, done) {
        if (!allowLess && done) {
          cb(read, null, done);
        } else {
          writeFunc(obj, readVal(buf, offset, len, obj));
          cb(read, obj, done);
        }
      });
    });
  }

  private _addReadFunc(nextFunc: ReadFunc): void {
    const { readFunc } = this;

    checkValue(readFunc.length, 3);

    this.readFunc = function callPrev(read, obj, cb) {
      readFunc(read, obj, function executedPrev(read, obj, done) {
        if (done) cb(read, null, true);
        else nextFunc(read, obj as Obj, cb);
      });
    };
  }
}

function parse(
  type: { readFunc: ReadFunc; constructorFn: ConstructorFn },
  buffer: Buffer,
  startOffset: number,
): ParseResult<Obj | null> {
  let result: Obj | null = null;
  let offset = startOffset;

  const Constructor = type.constructorFn;

  type.readFunc(
    (bytes, cb) => {
      const off = offset;
      offset += bytes;
      cb(buffer, off, offset > buffer.length);
    },
    new Constructor() as Obj,
    function cb(_read, obj) {
      result = obj as Obj | null;
    },
  );

  return { result, offset };
}

function wrapLength(
  length: number | ((obj: Obj) => number),
): (obj: Obj) => number {
  if (typeof length === "number") {
    // TODO use specialized function
    return () => length;
  }

  checkValue(typeof length, "function");

  return length;
}

function addByteRequest(
  nextFunc: (
    read: ReadRequest,
    obj: Obj,
    remainder: number,
    cb: Continuation,
  ) => void,
  bytes: number,
  useBinOps: boolean,
): (read: ReadRequest, obj: Obj, remainder: number, cb: Continuation) => void {
  const readFunc = getReadFunc(bytes);
  const sham = bytes << 3;

  if (useBinOps) {
    return function readBit(read, obj, remainder, cb) {
      read(bytes, (buffer, offset, done) => {
        if (done) cb(read, null, true);
        else {
          nextFunc(
            read,
            obj,
            (remainder << sham) | readFunc(buffer, offset),
            cb,
          );
        }
      });
    };
  }

  /*
   * May loose accuracy after 25 bits,
   * can't use binary ops anymore
   */

  const multiplier = 1 << sham;

  return function readBitNonBinary(read, obj, remainder, cb) {
    read(bytes, (buffer, offset, done) => {
      if (done) cb(read, null, true);
      else {
        nextFunc(
          read,
          obj,
          remainder * multiplier + readFunc(buffer, offset),
          cb,
        );
      }
    });
  };
}

function getReadFunc(
  bytes: number,
): (buffer: Buffer, offset: number) => number {
  // Use specialized functions for 1, 2 & 4 bytes
  switch (bytes) {
    case 1:
      return function read8(buffer, offset) {
        return buffer[offset];
      };
    case 2:
      return function read16(buffer, offset) {
        return buffer.readInt16BE(offset);
      };
    case 4:
      return function read32(buffer, offset) {
        return buffer.readInt32BE(offset);
      };
    default:
      throw new Error("unsupported request");
  }
}

function wrapOption(
  opt: LengthOption | undefined,
  name: string,
): (obj: Obj) => number {
  if (typeof opt === "number") {
    return () => opt;
  }

  if (typeof opt === "string") {
    return (obj) => {
      if (!(opt in obj)) throw new Error(`${opt} not present in object`);
      return obj[opt] as number;
    };
  }

  if (typeof opt === "function") {
    return (obj) => opt.call(obj);
  }

  throw new Error(`can't handle option ${name}`);
}

function getWriteFunc(
  varName: string,
  options: FieldOptions | undefined,
): (obj: Obj, val: unknown) => void {
  let writeFunc = (obj: Obj, val: unknown) => {
    obj[varName] = val;
  };

  if (options?.flatten) {
    writeFunc = (obj, val) => {
      if (obj === val) return;
      if (val === null) return;

      if (typeof val !== "object") {
        throw new Error("flatten option on primitive parser");
      }

      for (const key in val) {
        if (Object.prototype.hasOwnProperty.call(val, key)) {
          obj[key] = (val as Obj)[key];
        }
      }
    };
  }

  if (options?.assert !== undefined) {
    writeFunc = getAssertFunc(varName, options.assert, writeFunc);
  }

  if (options?.formatter) {
    const formatter = options.formatter as (
      this: Obj,
      value: unknown,
    ) => unknown;
    const inner = writeFunc;
    return (obj, val) => {
      inner(obj, formatter.call(obj, val));
    };
  }

  return writeFunc;
}

function getAssertFunc(
  varName: string,
  assert: NonNullable<FieldOptions["assert"]>,
  writeFunc: (obj: Obj, val: unknown) => void,
): (obj: Obj, val: unknown) => void {
  function errFunc(val: unknown): never {
    throw new Error(`Assert error: \`${varName}\` is \`${String(val)}\``);
  }

  if (typeof assert === "function") {
    const check = assert as (this: Obj, value: unknown) => boolean;
    return function assertFn(obj, val) {
      if (!check.call(obj, val)) errFunc(val);
      else writeFunc(obj, val);
    };
  }

  if (typeof assert === "string" || typeof assert === "number") {
    return function assertEq(obj, val) {
      if (val !== assert) errFunc(val);
      else writeFunc(obj, val);
    };
  }

  throw new Error("assert option only supports functions, strings and numbers");
}
