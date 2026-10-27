import type { Entry, Order, Piece } from "./bin.ts";
import { Codec } from "./codec.ts";
import type { Gen } from "./compile.ts";
import type { BitDomain, WithDomain } from "./domain.ts";

/** The widths of bit fields: 1 to 53 bits (integers up to 2 ** 53 - 1 are exact numbers). */
// oxfmt-ignore
export type BitWidth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | 51 | 52 | 53;

/**
 * An unsigned integer of `width` bits, for a parser field: consecutive bit
 * fields share bytes, and a run of them is padded to whole bytes (with zeros
 * when encoding). Other fields start at the next byte.
 *
 * The first field of a run takes the most significant bits of its byte,
 * unless the parser is `bin({ bitOrder: "lsb" })`. `enumOf`, `map`,
 * `literal` and `refine` of a bit field are bit fields too. See the README
 * section on bit fields.
 *
 * @param width The number of bits, 1 to 53.
 * @returns A codec for direct parser fields only: not for values on their
 *   own, array items or match cases (TypeScript rejects them; from
 *   JavaScript, they throw when first used). Its `size` is `NaN`.
 * @throws {RangeError} If `width` is not an integer from 1 to 53.
 * @example
 * const Header = bin().field("version", bits(4)).field("ihl", bits(4)).u8("ttl");
 * Header.decode(Uint8Array.of(0x45, 64)); // { version: 4, ihl: 5, ttl: 64 }
 */
export function bits<const N extends BitWidth>(
  width: N,
): WithDomain<
  Codec<number, number, unknown, true>,
  [N] extends [keyof BitDomain] ? BitDomain[N & keyof BitDomain] : unknown
> {
  if (!(Number.isInteger(width) && width >= 1 && width <= 53)) {
    throw new RangeError(`${width} bits, not 1 to 53`);
  }
  return new Bits(width) as never;
}

type Layout = { size: number; width: number; order: Order };

/**
 * A parser hands each run of bit fields to the packing of its first one
 * (`decodeRun`, `encodeRun`). @internal
 */
export class Bits extends Codec<number> {
  override readonly packing = this;
  readonly width: number;
  /** Optional conversions around the raw bits, supplied by wrappers. */
  declare readonly decodeValue?: (
    g: Gen,
    raw: string,
    wanted: boolean,
    at: string,
  ) => string;
  declare readonly encodeValue?: (g: Gen, value: string) => string;

  constructor(width: number) {
    super(Number.NaN);
    this.width = width;
  }

  /**
   * The layout of a run with this field added.
   *
   * @param previous The layout of the run before it, if any.
   * @param order The bit order of the parser.
   * @returns The layout, whose `size` is the number of bytes this field adds.
   */
  layout(previous: unknown, order: Order): Layout {
    const last = previous as Layout | undefined;
    if (last && last.order !== order) {
      throw new Error("bit fields of different orders cannot share bytes");
    }
    const before = last?.width ?? 0;
    const width = before + this.width;
    return {
      size: Math.ceil(width / 8) - Math.ceil(before / 8),
      width,
      order,
    };
  }

  emitRead(): never {
    throw new TypeError("bits must be direct parser fields");
  }

  emitWrite(): never {
    return this.emitRead();
  }

  /**
   * @param g The generator of the function.
   * @param entries The entries of the parser.
   * @param i The index of the first bit field.
   * @param want Whether a field (by name and entry index) is decoded.
   * @param parts The parts of the object, to which the fields are added.
   * @param output The names of the fields in the object.
   * @returns The index of the last entry of the run.
   */
  decodeRun(
    g: Gen,
    entries: readonly Entry[],
    i: number,
    want: (name: string, i: number) => boolean,
    parts: Piece[],
    output: ReadonlySet<string>,
  ): number {
    const fields = this.run(entries, i);
    // The bytes each field starts and ends in, for errors.
    let end = 0;
    const ends = fields.map(
      ({ name, packing: { width } }): [string, number, number] => [
        name,
        Math.floor(end / 8),
        Math.ceil((end += width) / 8),
      ],
    );
    const bytes = Math.ceil(end / 8);
    g.field = undefined;
    g.need(bytes, ends);
    let offset = 0;
    for (const [j, field] of fields.entries()) {
      g.field = field.name;
      const wanted = want(field.name, i + j);
      const { packing } = field;
      const raw =
        wanted || field.codec.checks
          ? g.let(extract(g.at(), field.order, offset, packing.width))
          : "";
      const v = packing.decodeValue
        ? packing.decodeValue(g, raw, wanted, g.at(Math.floor(offset / 8)))
        : raw;
      if (g.mode === "trace") g.trace(g.at(), v, g.at(bytes));
      if (v) {
        g.fields.set(field.name, v);
        if (output.has(field.name)) parts.push({ name: field.name, v });
      }
      offset += field.packing.width;
    }
    g.skip(bytes);
    return i + fields.length - 1;
  }

  /**
   * @param g The generator of the function.
   * @param entries The entries of the parser.
   * @param i The index of the first bit field.
   * @param object The variable holding the object.
   * @param computed The variables of computed fields, by name.
   * @returns The index of the last entry of the run.
   */
  encodeRun(
    g: Gen,
    entries: readonly Entry[],
    i: number,
    object: string,
    computed: ReadonlyMap<string, string>,
  ): number {
    const fields = this.run(entries, i);
    const total = fields.reduce((n, f) => n + f.packing.width, 0);
    const bytes: string[][] = Array.from(
      { length: Math.ceil(total / 8) },
      () => [],
    );
    let offset = 0;
    for (const { name, packing, order } of fields) {
      g.field = name;
      const { width } = packing;
      const value = g.let(
        computed.get(name) ?? `${object}[${JSON.stringify(name)}]`,
        "let",
      );
      const v = packing.encodeValue ? packing.encodeValue(g, value) : value;
      g.fields.set(name, value);
      g.check(
        width > 32
          ? `!(Number.isInteger(${v}) && ${v} >= 0 && ${v} <= ${2 ** width - 1})`
          : width === 32
            ? `typeof ${v} !== "number" || ${v} >>> 0 !== ${v}`
            : `typeof ${v} !== "number" || (${v} & ${2 ** width - 1}) !== ${v}`,
        "invalid",
        `"expected an unsigned integer of ${width} bits, got " + String(${v})`,
      );
      // Wider values in two parts: the bits above the low 32, and the low 32.
      const pieces =
        width > 32
          ? [
              { v: g.let(`Math.floor(${v} / ${2 ** 32})`), width: width - 32 },
              { v: g.let(`${v} >>> 0`), width: 32 },
            ]
          : [{ v, width }];
      if (order === "lsb") pieces.reverse();
      for (const piece of pieces) {
        // The parts of the piece in each byte it is in.
        const end = offset + piece.width;
        for (let j = offset >> 3; j <= (end - 1) >> 3; j++) {
          const shift = order === "msb" ? 8 * j + 8 - end : offset - 8 * j;
          const part =
            shift >= 0 ? `${piece.v} << ${shift}` : `${piece.v} >>> ${-shift}`;
          bytes[j].push(`(${part}) & 255`);
        }
        offset = end;
      }
    }
    g.field = undefined;
    g.need(bytes.length);
    for (const [j, parts] of bytes.entries()) {
      g.write(`buf[${g.at(j)}] = ${parts.join(" | ")};`);
    }
    g.skip(bytes.length);
    return i + fields.length - 1;
  }

  /**
   * @param entries The entries of the parser.
   * @param i The index of the first bit field.
   * @returns The bit fields from `i` on that share bytes (`layout` checked
   *   their orders).
   */
  private run(
    entries: readonly Entry[],
    i: number,
  ): (Extract<Entry, { kind: "field" }> & { packing: Bits })[] {
    const first = entries[i] as Extract<Entry, { kind: "field" }>;
    const fields = [{ ...first, packing: this as Bits }];
    for (let j = i + 1; j < entries.length; j++) {
      const entry = entries[j];
      if (entry.kind !== "field" || !(entry.codec.packing instanceof Bits)) {
        break;
      }
      fields.push({ ...entry, packing: entry.codec.packing });
    }
    return fields;
  }
}

/**
 * @param at An expression of the offset of the bytes.
 * @param order The order of the bits in a byte.
 * @param offset The number of bits before the field.
 * @param width The number of bits of the field.
 * @returns An expression of the unsigned integer the bits hold.
 */
function extract(
  at: string,
  order: Order,
  offset: number,
  width: number,
): string {
  if (width > 32) {
    // The bits above the low 32 (first in msb order), times 2 ** 32.
    const high = order === "msb" ? offset : offset + 32;
    const low = order === "msb" ? offset + width - 32 : offset;
    return `(${extract(at, order, high, width - 32)}) * ${2 ** 32} + (${extract(at, order, low, 32)})`;
  }
  const first = offset >> 3;
  const span = ((offset + width - 1) >> 3) - first + 1;
  const byte = (k: number): string => `buf[${at} + ${first + k}]`;
  // The bits from `first` on, big (msb) or little (lsb) endian.
  const shift = order === "msb" ? 8 * span - (offset % 8) - width : offset % 8;
  if (span <= 4) {
    const bytes = Array.from({ length: span }, (_, k) =>
      order === "msb"
        ? `${byte(k)} << ${8 * (span - 1 - k)}`
        : `${byte(k)} << ${8 * k}`,
    );
    const value = `(${bytes.join(" | ")}) >>> ${shift}`;
    return width === 32 ? value : `(${value}) & ${2 ** width - 1}`;
  }
  // Five bytes: more bits than bitwise operators take.
  const bytes = Array.from({ length: span }, (_, k) =>
    order === "msb" ? byte(k) : byte(span - 1 - k),
  );
  const value = bytes.reduce((acc, b) => `(${acc}) * 256 + ${b}`);
  return `Math.floor((${value}) / ${2 ** shift}) % ${2 ** width}`;
}
