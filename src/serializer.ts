/**
 * Serializes values: `sizeOf` measures a value, `write` writes it. Lengths
 * given by fields or functions must match the value (strings are padded with
 * zero bytes up to their length).
 */
import {
  lengthOf,
  pick,
  resolve,
  tagOf,
  writeBits,
  type Field,
  type Obj,
  type Type,
} from "./fields.ts";
import { PRIMITIVE_TYPES, writePrimitive } from "./primitive-types.ts";

/** Serializes `value`, into `buffer` if given; returns the bytes written. */
export function serialize(type: Type, value: unknown, buffer?: Buffer): Buffer {
  const size = sizeOf(type, value);
  if (buffer && buffer.length < size) {
    throw new RangeError(
      `the value needs ${size} bytes, but the buffer has ${buffer.length}`,
    );
  }
  const out = buffer ? buffer.subarray(0, size) : Buffer.alloc(size);
  write(type, value, out, 0);
  return out;
}

/** Byte size of `value` when serialized as `type`. */
export function sizeOf(type: Type, value: unknown): number {
  const resolved = resolve(type);
  if (typeof resolved === "string") return PRIMITIVE_TYPES[resolved].size;
  let size = 0;
  for (const field of resolved.fields) size += fieldSize(field, value as Obj);
  return size;
}

function fieldSize(field: Field, obj: Obj): number {
  switch (field.kind) {
    case "primitive":
      return PRIMITIVE_TYPES[field.type].size;
    case "bits":
      return field.bytes;
    case "string":
      return encodeString(field, obj).size;
    case "buffer":
      return checkedBuffer(field, obj).length;
    case "array": {
      let size = 0;
      for (const item of checkedItems(field, obj))
        size += sizeOf(field.type, item);
      return size;
    }
    case "nest": {
      const size = sizeOf(field.type, field.load(obj));
      if (field.length === undefined) return size;
      const length = lengthOf(field.length, obj, field.name);
      if (size > length) {
        throw new Error(
          `\`${field.name}\` needs ${size} bytes, more than its size ${length}`,
        );
      }
      return length;
    }
    case "choice":
      return sizeOf(pick(field, tagOf(field.tag, obj)), field.load(obj));
  }
}

/** Writes `value` as `type` at `buf[offset]`; returns the offset after it. */
export function write(
  type: Type,
  value: unknown,
  buf: Buffer,
  offset: number,
): number {
  const resolved = resolve(type);
  if (typeof resolved === "string") {
    return writePrimitive(resolved, buf, value, offset);
  }
  let o = offset;
  for (const field of resolved.fields)
    o = writeField(field, value as Obj, buf, o);
  return o;
}

function writeField(field: Field, obj: Obj, buf: Buffer, o: number): number {
  switch (field.kind) {
    case "primitive":
      return writePrimitive(field.type, buf, field.load(obj), o);
    case "bits":
      buf.fill(0, o, o + field.bytes);
      for (const bit of field.bits) {
        writeBits(buf, o, bit.pos, bit.width, bit.load(obj) as number);
      }
      return o + field.bytes;
    case "string": {
      const { bytes, size } = encodeString(field, obj);
      bytes.copy(buf, o);
      buf.fill(0, o + bytes.length, o + size);
      return o + size;
    }
    case "buffer":
      return o + checkedBuffer(field, obj).copy(buf, o);
    case "array": {
      for (const item of checkedItems(field, obj)) {
        o = write(field.type, item, buf, o);
      }
      return o;
    }
    case "nest": {
      // The size is checked by `sizeOf`; a fixed size is padded with zeros.
      const end = write(field.type, field.load(obj), buf, o);
      if (field.length === undefined) return end;
      const length = lengthOf(field.length, obj, field.name);
      buf.fill(0, end, o + length);
      return o + length;
    }
    case "choice":
      return write(pick(field, tagOf(field.tag, obj)), field.load(obj), buf, o);
  }
}

function mismatch(
  field: { name: string },
  actual: string,
  length: number,
): Error {
  return new Error(
    `\`${field.name}\` has ${actual}, but its length is ${length}`,
  );
}

/** The bytes of a string, and the size it takes (with padding or the terminating zero). */
function encodeString(
  field: Extract<Field, { kind: "string" }>,
  obj: Obj,
): { bytes: Buffer; size: number } {
  const bytes = Buffer.from(field.load(obj) as string, field.encoding);
  if (field.zeroTerminated) {
    const max = lengthOf(field.length, obj, field.name);
    if (bytes.includes(0)) {
      throw new Error(`\`${field.name}\` contains a zero byte`);
    }
    if (bytes.length > max) throw mismatch(field, `${bytes.length} bytes`, max);
    return { bytes, size: bytes.length < max ? bytes.length + 1 : max };
  }
  if (field.length === Infinity) return { bytes, size: bytes.length };
  const length = lengthOf(field.length, obj, field.name);
  if (bytes.length > length) {
    throw mismatch(field, `${bytes.length} bytes`, length);
  }
  return { bytes, size: length };
}

function checkedBuffer(
  field: Extract<Field, { kind: "buffer" }>,
  obj: Obj,
): Buffer {
  const value = field.load(obj) as Buffer;
  const length = lengthOf(field.length, obj, field.name);
  if (length !== Infinity && value.length !== length) {
    throw mismatch(field, `${value.length} bytes`, length);
  }
  return value;
}

function checkedItems(
  field: Extract<Field, { kind: "array" }>,
  obj: Obj,
): unknown[] {
  const items = field.load(obj) as unknown[];
  const { until } = field;
  if (until === "eof") return items;
  const length = lengthOf(field.length, obj, field.name);
  if (until === undefined) {
    if (items.length !== length) {
      throw mismatch(field, `${items.length} items`, length);
    }
    return items;
  }
  // Parsing stops at the first item passing `readUntil`, or after `length` items.
  const last = items.findIndex((item) => until(item as never));
  const count = Math.min(last < 0 ? Infinity : last + 1, length);
  if (items.length !== count) {
    throw new Error(
      count === Infinity
        ? `\`${field.name}\` has no item passing readUntil`
        : `\`${field.name}\` has ${items.length} items, but parsing stops after ${count}`,
    );
  }
  return items;
}
