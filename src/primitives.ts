import { Codec } from "./codec.ts";
import type { Gen } from "./compile.ts";

type Method =
  | "Int8"
  | "Uint8"
  | "Int16"
  | "Uint16"
  | "Int24"
  | "Uint24"
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
  Uint24: (x) => `(${x} & 16777215) === ${x}`,
  Int24: (x) => `${x} << 8 >> 8 === ${x}`,
  Uint32: (x) => `${x} >>> 0 === ${x}`,
  Int32: (x) => `(${x} | 0) === ${x}`,
  BigUint64: (x) =>
    `typeof ${x} === "bigint" && BigInt.asUintN(64, ${x}) === ${x}`,
  BigInt64: (x) =>
    `typeof ${x} === "bigint" && BigInt.asIntN(64, ${x}) === ${x}`,
  Float32: (x) => `typeof ${x} === "number"`,
  Float64: (x) => `typeof ${x} === "number"`,
};

/** @internal */
export class Primitive<
  T extends number | bigint = number | bigint,
> extends Codec<T> {
  readonly name: string;
  /** Whether values are unsigned integers of up to 32 bits (so they are valid lengths). */
  readonly count: boolean;
  /** Whether reading uses a DataView instead of indexing the bytes. */
  readonly usesView: boolean;
  private readonly method: Method;
  private readonly le: boolean;

  constructor(name: string, size: number, method: Method, le = false) {
    super(size);
    this.name = name;
    this.count = method.startsWith("Uint");
    this.usesView = size !== 3 && method !== "Uint8";
    this.method = method;
    this.le = le;
  }

  /** @returns The byte order argument of `DataView` methods, after a comma. */
  private get order(): string {
    return this.size > 1 ? `, ${this.le}` : "";
  }

  /**
   * @param at An expression of the offset of a 24-bit integer.
   * @returns Its bytes in `buf`, most significant first.
   */
  private bytes(at: string): string[] {
    return (this.le ? [2, 1, 0] : [0, 1, 2]).map((i) =>
      i === 0 ? `buf[${at}]` : `buf[${at} + ${i}]`,
    );
  }

  /**
   * @param at An expression of the offset.
   * @param viewAt The corresponding position in the DataView.
   * @returns An index into `buf` (for bytes), its bytes combined (for 24
   *   bits), or a call of a `DataView` method.
   */
  expr(at: string, viewAt = at): string {
    if (this.size === 3) {
      const [high, middle, low] = this.bytes(at);
      const unsigned = `(${high} << 16 | ${middle} << 8 | ${low})`;
      return this.method === "Int24" ? `(${unsigned} << 8 >> 8)` : unsigned;
    }
    return this.method === "Uint8"
      ? `buf[${at}]`
      : `dv.get${this.method}(${viewAt}${this.order})`;
  }

  emitRead(g: Gen, wanted: boolean): string {
    g.usesView ||= wanted && this.usesView;
    g.need(this.size);
    const v = wanted ? g.let(this.expr(g.at(), g.viewAt())) : "";
    g.skip(this.size);
    return v;
  }

  emitWrite(g: Gen, value: string): void {
    g.need(this.size);
    this.store(g, value, g.at());
    g.skip(this.size);
  }

  /**
   * @param g The generator of the function.
   * @param value The variable of the value, which is checked.
   * @param at An expression of the offset, where there is room.
   */
  store(g: Gen, value: string, at: string): void {
    // `typeof` first: bitwise operators call `valueOf` of objects, and throw
    // on bigints and symbols.
    g.check(
      `!(${this.size <= 4 && !this.method.startsWith("Float") ? `typeof ${value} === "number" && ` : ""}${valid[this.method](value)})`,
      "invalid",
      `"expected ${this.name}, got " + String(${value})`,
    );
    if (this.size === 3) {
      const [high, middle, low] = this.bytes(at);
      g.write(
        `${high} = ${value} >> 16; ${middle} = ${value} >> 8; ${low} = ${value};`,
      );
    } else {
      g.write(
        this.method === "Uint8"
          ? `buf[${at}] = ${value};`
          : `dv.set${this.method}(${at}, ${value}${this.order});`,
      );
    }
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

/** Unsigned 8-bit integers: 0 to 255. */
export const u8 = primitive<number>("u8", 1, "Uint8");
/** Signed 8-bit integers: -128 to 127. */
export const i8 = primitive<number>("i8", 1, "Int8");
/** Unsigned 16-bit integers, little endian: 0 to 65535. */
export const u16le = primitive<number>("u16le", 2, "Uint16", true);
/** Unsigned 16-bit integers, big endian: 0 to 65535. */
export const u16be = primitive<number>("u16be", 2, "Uint16");
/** Signed 16-bit integers, little endian: -32768 to 32767. */
export const i16le = primitive<number>("i16le", 2, "Int16", true);
/** Signed 16-bit integers, big endian: -32768 to 32767. */
export const i16be = primitive<number>("i16be", 2, "Int16");
/** Unsigned 24-bit integers, little endian: 0 to 16777215. */
export const u24le = primitive<number>("u24le", 3, "Uint24", true);
/** Unsigned 24-bit integers, big endian: 0 to 16777215. */
export const u24be = primitive<number>("u24be", 3, "Uint24");
/** Signed 24-bit integers, little endian: -8388608 to 8388607. */
export const i24le = primitive<number>("i24le", 3, "Int24", true);
/** Signed 24-bit integers, big endian: -8388608 to 8388607. */
export const i24be = primitive<number>("i24be", 3, "Int24");
/** Unsigned 32-bit integers, little endian: 0 to 4294967295. */
export const u32le = primitive<number>("u32le", 4, "Uint32", true);
/** Unsigned 32-bit integers, big endian: 0 to 4294967295. */
export const u32be = primitive<number>("u32be", 4, "Uint32");
/** Signed 32-bit integers, little endian: -2147483648 to 2147483647. */
export const i32le = primitive<number>("i32le", 4, "Int32", true);
/** Signed 32-bit integers, big endian: -2147483648 to 2147483647. */
export const i32be = primitive<number>("i32be", 4, "Int32");
/** Unsigned 64-bit integers, little endian, as `bigint`s. */
export const u64le = primitive<bigint>("u64le", 8, "BigUint64", true);
/** Unsigned 64-bit integers, big endian, as `bigint`s. */
export const u64be = primitive<bigint>("u64be", 8, "BigUint64");
/** Signed 64-bit integers, little endian, as `bigint`s. */
export const i64le = primitive<bigint>("i64le", 8, "BigInt64", true);
/** Signed 64-bit integers, big endian, as `bigint`s. */
export const i64be = primitive<bigint>("i64be", 8, "BigInt64");
/** 32-bit floats, little endian: encoding rounds numbers to them. */
export const f32le = primitive<number>("f32le", 4, "Float32", true);
/** 32-bit floats, big endian: encoding rounds numbers to them. */
export const f32be = primitive<number>("f32be", 4, "Float32");
/** 64-bit floats (JavaScript numbers), little endian. */
export const f64le = primitive<number>("f64le", 8, "Float64", true);
/** 64-bit floats (JavaScript numbers), big endian. */
export const f64be = primitive<number>("f64be", 8, "Float64");

/** The number codecs by name: parsers have a method adding a field of each (starting at a byte). */
export type Numbers = typeof primitives;

export const primitives = {
  u8,
  i8,
  u16le,
  u16be,
  i16le,
  i16be,
  u24le,
  u24be,
  i24le,
  i24be,
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
