import { PRIMITIVE_TYPES, type PrimitiveName } from "./primitive-types.ts";
import type { BitRequest, FieldOptions, Obj, ResolvedType } from "./types.ts";
import type {
  ArrayParseOptions,
  LengthOption,
  StringParseOptions,
} from "./parser.ts";

const DEBUG = process.env.NODE_ENV === "test";

type Getter = (obj: Obj) => unknown;

function getGetVarFunc(varName: string): Getter {
  return (obj) => {
    if (!(varName in obj)) throw new Error(`var \`${varName}\` not found`);
    return obj[varName];
  };
}

function getGetLengthFunc(length: LengthOption): (obj: Obj) => number {
  if (typeof length === "number") {
    return () => length;
  }

  if (typeof length === "string") {
    return (obj) => obj[length] as number;
  }

  if (typeof length === "function") {
    return (obj) => length.call(obj);
  }

  throw new Error(`unrecognized length ${String(length)}`);
}

export class Serializer {
  sizeFunc: (obj: Obj) => number = () => 0;
  writeFunc: (obj: Obj, buf: Buffer) => number = () => 0;
  vars = new Set<string>();

  serialize(obj: Obj, buf?: Buffer): Buffer {
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

  string(varName: string, options: StringParseOptions): this {
    const getVar = this._getVarFunc(varName, options) as (obj: Obj) => string;

    const { sizeFunc, writeFunc } = this;

    const encoding = options.encoding ?? "utf8";

    const getByteLength = (obj: Obj) =>
      Buffer.byteLength(getVar(obj), encoding);

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
        ? (written: number, len: number) => (written < len ? 1 : 0)
        : options.stripNull
          ? (written: number, len: number) => len - written
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

        return (
          offset +
          buf.write(`${val}\0`, offset, getByteLength(obj) + 1, encoding)
        );
      };

      return this;
    }

    throw new Error(
      ".string() needs either a length or a zero-terminated string",
    );
  }

  nest(varName: string, options: FieldOptions & { type: ResolvedType }): void {
    const getVar = this._getVarFunc(varName, options);

    const { sizeFunc, writeFunc } = this;

    const typeSize = options.type.sizeFunc;
    const typeWrite = options.type.writeFunc;

    this.sizeFunc = (obj) => typeSize(getVar(obj)) + sizeFunc(obj);

    this.writeFunc = (obj, buf) => {
      const offset = writeFunc(obj, buf);
      return offset + typeWrite(getVar(obj), buf.subarray(offset));
    };
  }

  fixedSizeNest(
    varName: string,
    options: FieldOptions & { length?: LengthOption },
    type: ResolvedType,
  ): void {
    const getVar = this._getVarFunc(varName, options);

    const { sizeFunc, writeFunc } = this;

    const typeWrite = type.writeFunc;

    if (options.length === undefined)
      throw new Error("fixedSizeNest needs a length");
    const getLength = getGetLengthFunc(options.length);

    this.sizeFunc = (obj) => getLength(obj) + sizeFunc(obj);

    this.writeFunc = (obj, buf) => {
      const offset = writeFunc(obj, buf);
      const written = typeWrite(getVar(obj), buf.subarray(offset));
      const length = getLength(obj);

      if (written > length) {
        throw new Error("Nested type wrote too much");
      }

      return offset + length;
    };
  }

  array(varName: string, options: ArrayParseOptions, type: ResolvedType): void {
    // TODO check if passed array has acceptable length
    let getVar = this._getVarFunc(varName, options) as (obj: Obj) => unknown[];

    if (typeof options.key === "string") {
      const plainVar = getVar as unknown as (obj: Obj) => Obj;
      const { key } = options;
      getVar = (obj) => {
        const val = plainVar(obj);
        return Object.keys(val).map((k) => {
          if ((val[k] as Obj)[key] !== k) throw new Error("invalid mapping");
          return val[k];
        });
      };
    }

    const { sizeFunc, writeFunc } = this;

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
        offset += typeWrite(arr[i], buf.subarray(offset));
      }
      return offset;
    };
  }

  choice(
    varName: string,
    options: FieldOptions,
    getChoice: (obj: Obj) => ResolvedType,
  ): void {
    const getVar = this._getVarFunc(varName, options);

    const { sizeFunc, writeFunc } = this;

    this.sizeFunc = (obj) =>
      getChoice(obj).sizeFunc(getVar(obj)) + sizeFunc(obj);

    this.writeFunc = (obj, buf) => {
      const offset = writeFunc(obj, buf);
      return (
        offset + getChoice(obj).writeFunc(getVar(obj), buf.subarray(offset))
      );
    };
  }

  buffer(varName: string, options: FieldOptions): void {
    // TODO check for length
    const getVar = this._getVarFunc(varName, options) as (obj: Obj) => Buffer;

    const { sizeFunc, writeFunc } = this;

    this.sizeFunc = (obj) => getVar(obj).length + sizeFunc(obj);

    this.writeFunc = (obj, buf) => {
      const offset = writeFunc(obj, buf);
      return offset + getVar(obj).copy(buf, offset);
    };
  }

  /** Writes a fixed-size primitive. */
  primitive(
    name: PrimitiveName,
    varName: string,
    options?: FieldOptions,
  ): void {
    const getVar = this._getVarFunc(varName, options);
    const { size, write } = PRIMITIVE_TYPES[name];
    const writeMethod = Buffer.prototype[write] as (
      this: Buffer,
      value: unknown,
      offset: number,
    ) => number;

    // Add the size of the primitive
    const { sizeFunc, writeFunc } = this;
    this.sizeFunc = (obj) => size + sizeFunc(obj);

    this.writeFunc = (obj, buf) => {
      const offset = writeFunc(obj, buf);
      return writeMethod.call(buf, getVar(obj), offset);
    };
  }

  _processBitfield(reqs: BitRequest[], length: number): void {
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
        .reduce((p, n) => (obj) => n(p(obj) as Obj)) as (obj: Obj) => number;

      return (obj: Obj, buf: Buffer) => {
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

  private _getVarFunc(
    varName: string,
    options: FieldOptions | undefined,
  ): Getter {
    // To ensure getting a value is the same while reading & serializing
    if (this.vars.has(varName)) throw new Error("duplicated var name");
    this.vars.add(varName);

    if (options?.formatter && !options.deformatter) {
      throw new Error("formats need to be reversible");
    }

    if (options?.deformatter) {
      const deformatter = options.deformatter as (
        value: unknown,
        obj: Obj,
      ) => unknown;

      if (options.flatten) {
        return deformatter as unknown as Getter;
      }

      return (obj) => deformatter(obj[varName], obj);
    }

    if (options?.flatten) {
      return (obj) => obj;
    }

    return getGetVarFunc(varName);
  }
}
