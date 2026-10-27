/** Unsigned bit fields, packed into whole-byte runs by their parser. */
import type { Entry, Order, Piece } from "./bin.ts";
import { Codec } from "./codec.ts";
import type { Gen } from "./compile.ts";

// oxfmt-ignore
export type BitWidth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | 51 | 52 | 53;

/**
 * A number of 1 to 53 bits. Use directly in `.field(name, bits(width))`;
 * consecutive fields share bytes in the parser's bit order.
 *
 * @param width The number of bits.
 * @returns A codec for a direct parser field, not a standalone value.
 */
export function bits(width: BitWidth): Codec<number> {
  if (!(Number.isInteger(width) && width >= 1 && width <= 53)) {
    throw new RangeError(`${width} bits, not 1 to 53`);
  }
  return new Bits(width);
}

type Layout = { size: number; width: number; order: Order };

/** Runtime packing and code generation of bit fields. @internal */
export class Bits extends Codec<number> {
  override readonly packing = this;
  readonly width: number;

  constructor(width: number) {
    super(Number.NaN);
    this.width = width;
  }

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
   * Emits code decoding the bit fields from entry `i` on; returns the index of
   * the last.
   *
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
      ({ name, codec: { width } }): [string, number, number] => [
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
      const v = want(field.name, i + j)
        ? g.let(extract(g.at(), field.order, offset, field.codec.width))
        : "";
      if (g.mode === "trace") g.trace(g.at(), v, g.at(bytes));
      if (v) {
        g.fields.set(field.name, v);
        if (output.has(field.name)) parts.push({ name: field.name, v });
      }
      offset += field.codec.width;
    }
    g.skip(bytes);
    return i + fields.length - 1;
  }

  /**
   * Emits code encoding the bit fields from entry `i` on; returns the index of
   * the last.
   *
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
    const total = fields.reduce((n, f) => n + f.codec.width, 0);
    const bytes: string[][] = Array.from(
      { length: Math.ceil(total / 8) },
      () => [],
    );
    let offset = 0;
    for (const {
      name,
      codec: { width },
      order,
    } of fields) {
      g.field = name;
      const v = g.let(
        computed.get(name) ?? `${object}[${JSON.stringify(name)}]`,
        "let",
      );
      g.fields.set(name, v);
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
   * The bit fields from entry `i` on that share bytes.
   *
   * @param entries The entries of the parser.
   * @param i The index of the first bit field.
   * @returns Consecutive bit fields; layout has already checked their orders.
   */
  private run(
    entries: readonly Entry[],
    i: number,
  ): (Extract<Entry, { kind: "field" }> & { codec: Bits })[] {
    const first = entries[i] as Extract<Entry, { kind: "field" }>;
    const fields = [{ ...first, codec: this as Bits }];
    for (let j = i + 1; j < entries.length; j++) {
      const entry = entries[j];
      if (entry.kind !== "field" || !(entry.codec instanceof Bits)) {
        break;
      }
      fields.push(entry as Extract<Entry, { kind: "field" }> & { codec: Bits });
    }
    return fields;
  }
}

/**
 * The expression of the `width` bits `offset` bits into the bytes at `at`.
 *
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
