/** Fixed-size numbers: integers of 8 to 64 bits (64-bit ones as `bigint`) and floats. */
import { Codec } from "./codec.ts";
import type { Gen } from "./compile.ts";

type Method =
  | "Int8"
  | "Uint8"
  | "Int16"
  | "Uint16"
  | "Int32"
  | "Uint32"
  | "BigInt64"
  | "BigUint64"
  | "Float32"
  | "Float64";

/** Expressions checking that `x` is a value of each type. */
const valid: Record<Method, (x: string) => string> = {
  Uint8: (x) => `(${x} & 255) === ${x}`,
  Int8: (x) => `${x} << 24 >> 24 === ${x}`,
  Uint16: (x) => `(${x} & 65535) === ${x}`,
  Int16: (x) => `${x} << 16 >> 16 === ${x}`,
  Uint32: (x) => `${x} >>> 0 === ${x}`,
  Int32: (x) => `(${x} | 0) === ${x}`,
  BigUint64: (x) =>
    `typeof ${x} === "bigint" && BigInt.asUintN(64, ${x}) === ${x}`,
  BigInt64: (x) =>
    `typeof ${x} === "bigint" && BigInt.asIntN(64, ${x}) === ${x}`,
  Float32: (x) => `typeof ${x} === "number"`,
  Float64: (x) => `typeof ${x} === "number"`,
};

/** @internal A number of a fixed size. */
export class Primitive<
  T extends number | bigint = number | bigint,
> extends Codec<T> {
  readonly name: string;
  /** Whether values are unsigned integers of up to 32 bits (so they are valid lengths). */
  readonly count: boolean;
  private readonly method: Method;
  /** The byte order argument of `DataView` methods. */
  private readonly le: string;

  constructor(name: string, size: number, method: Method, le = false) {
    super(size);
    this.name = name;
    this.count = method.startsWith("Uint");
    this.method = method;
    this.le = size > 1 ? `, ${le}` : "";
  }

  /** An expression reading a value at offset `at`. */
  expr(at: string): string {
    return this.method === "Uint8"
      ? `buf[${at}]`
      : `dv.get${this.method}(${at}${this.le})`;
  }

  emitRead(g: Gen, wanted: boolean): string {
    g.need(this.size);
    const v = wanted ? g.let(this.expr(g.at())) : "";
    g.skip(this.size);
    return v;
  }

  emitWrite(g: Gen, value: string): void {
    g.need(this.size);
    this.store(g, value, g.at());
    g.skip(this.size);
  }

  /** Emits code checking `value` and writing it at offset `at` (which has room). */
  store(g: Gen, value: string, at: string): void {
    g.check(
      `!(${this.size <= 4 && !this.method.startsWith("Float") ? `typeof ${value} === "number" && ` : ""}${valid[this.method](value)})`,
      "invalid",
      `"expected ${this.name}, got " + String(${value})`,
    );
    g.line(
      this.method === "Uint8"
        ? `buf[${at}] = ${value};`
        : `dv.set${this.method}(${at}, ${value}${this.le});`,
    );
  }
}

function primitive<T extends number | bigint>(
  name: string,
  size: number,
  method: Method,
  le?: boolean,
): Codec<T> {
  return new Primitive<T>(name, size, method, le);
}

/** Unsigned 8-bit integers. */
export const u8 = primitive<number>("u8", 1, "Uint8");
/** Signed 8-bit integers. */
export const i8 = primitive<number>("i8", 1, "Int8");
/** Unsigned 16-bit integers, little endian. */
export const u16le = primitive<number>("u16le", 2, "Uint16", true);
/** Unsigned 16-bit integers, big endian. */
export const u16be = primitive<number>("u16be", 2, "Uint16");
/** Signed 16-bit integers, little endian. */
export const i16le = primitive<number>("i16le", 2, "Int16", true);
/** Signed 16-bit integers, big endian. */
export const i16be = primitive<number>("i16be", 2, "Int16");
/** Unsigned 32-bit integers, little endian. */
export const u32le = primitive<number>("u32le", 4, "Uint32", true);
/** Unsigned 32-bit integers, big endian. */
export const u32be = primitive<number>("u32be", 4, "Uint32");
/** Signed 32-bit integers, little endian. */
export const i32le = primitive<number>("i32le", 4, "Int32", true);
/** Signed 32-bit integers, big endian. */
export const i32be = primitive<number>("i32be", 4, "Int32");
/** Unsigned 64-bit integers (as `bigint`), little endian. */
export const u64le = primitive<bigint>("u64le", 8, "BigUint64", true);
/** Unsigned 64-bit integers (as `bigint`), big endian. */
export const u64be = primitive<bigint>("u64be", 8, "BigUint64");
/** Signed 64-bit integers (as `bigint`), little endian. */
export const i64le = primitive<bigint>("i64le", 8, "BigInt64", true);
/** Signed 64-bit integers (as `bigint`), big endian. */
export const i64be = primitive<bigint>("i64be", 8, "BigInt64");
/** 32-bit floats, little endian (numbers are rounded to them). */
export const f32le = primitive<number>("f32le", 4, "Float32", true);
/** 32-bit floats, big endian (numbers are rounded to them). */
export const f32be = primitive<number>("f32be", 4, "Float32");
/** 64-bit floats (JavaScript numbers), little endian. */
export const f64le = primitive<number>("f64le", 8, "Float64", true);
/** 64-bit floats (JavaScript numbers), big endian. */
export const f64be = primitive<number>("f64be", 8, "Float64");

/** The number codecs by name: parsers have a method adding a field of each (starting at a byte). */
export interface Numbers {
  /** Adds a field of an unsigned 8-bit integer. */
  u8: typeof u8;
  /** Adds a field of a signed 8-bit integer. */
  i8: typeof i8;
  /** Adds a field of an unsigned 16-bit integer, little endian. */
  u16le: typeof u16le;
  /** Adds a field of an unsigned 16-bit integer, big endian. */
  u16be: typeof u16be;
  /** Adds a field of a signed 16-bit integer, little endian. */
  i16le: typeof i16le;
  /** Adds a field of a signed 16-bit integer, big endian. */
  i16be: typeof i16be;
  /** Adds a field of an unsigned 32-bit integer, little endian. */
  u32le: typeof u32le;
  /** Adds a field of an unsigned 32-bit integer, big endian. */
  u32be: typeof u32be;
  /** Adds a field of a signed 32-bit integer, little endian. */
  i32le: typeof i32le;
  /** Adds a field of a signed 32-bit integer, big endian. */
  i32be: typeof i32be;
  /** Adds a field of an unsigned 64-bit integer (a `bigint`), little endian. */
  u64le: typeof u64le;
  /** Adds a field of an unsigned 64-bit integer (a `bigint`), big endian. */
  u64be: typeof u64be;
  /** Adds a field of a signed 64-bit integer (a `bigint`), little endian. */
  i64le: typeof i64le;
  /** Adds a field of a signed 64-bit integer (a `bigint`), big endian. */
  i64be: typeof i64be;
  /** Adds a field of a 32-bit float, little endian (numbers are rounded to it). */
  f32le: typeof f32le;
  /** Adds a field of a 32-bit float, big endian (numbers are rounded to it). */
  f32be: typeof f32be;
  /** Adds a field of a 64-bit float (a JavaScript number), little endian. */
  f64le: typeof f64le;
  /** Adds a field of a 64-bit float (a JavaScript number), big endian. */
  f64be: typeof f64be;
}

/** The number codecs by name. */
export const primitives: Numbers = {
  u8,
  i8,
  u16le,
  u16be,
  i16le,
  i16be,
  u32le,
  u32be,
  i32le,
  i32be,
  u64le,
  u64be,
  i64le,
  i64be,
  f32le,
  f32be,
  f64le,
  f64be,
};
