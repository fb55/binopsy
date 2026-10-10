/**
 * Fixed-size primitives: byte size plus the `Buffer` methods used to read
 * and write them. The keys are the parser method names.
 */
export const PRIMITIVE_TYPES = {
  uint8: { size: 1, read: "readUInt8", write: "writeUInt8" },
  uint16le: { size: 2, read: "readUInt16LE", write: "writeUInt16LE" },
  uint16be: { size: 2, read: "readUInt16BE", write: "writeUInt16BE" },
  uint32le: { size: 4, read: "readUInt32LE", write: "writeUInt32LE" },
  uint32be: { size: 4, read: "readUInt32BE", write: "writeUInt32BE" },
  int8: { size: 1, read: "readInt8", write: "writeInt8" },
  int16le: { size: 2, read: "readInt16LE", write: "writeInt16LE" },
  int16be: { size: 2, read: "readInt16BE", write: "writeInt16BE" },
  int32le: { size: 4, read: "readInt32LE", write: "writeInt32LE" },
  int32be: { size: 4, read: "readInt32BE", write: "writeInt32BE" },
  floatle: { size: 4, read: "readFloatLE", write: "writeFloatLE" },
  floatbe: { size: 4, read: "readFloatBE", write: "writeFloatBE" },
  doublele: { size: 8, read: "readDoubleLE", write: "writeDoubleLE" },
  doublebe: { size: 8, read: "readDoubleBE", write: "writeDoubleBE" },
  uint64le: { size: 8, read: "readBigUInt64LE", write: "writeBigUInt64LE" },
  uint64be: { size: 8, read: "readBigUInt64BE", write: "writeBigUInt64BE" },
  int64le: { size: 8, read: "readBigInt64LE", write: "writeBigInt64LE" },
  int64be: { size: 8, read: "readBigInt64BE", write: "writeBigInt64BE" },
} as const;

/** Name of a fixed-size primitive, e.g. `"uint16le"`. */
export type PrimitiveName = keyof typeof PRIMITIVE_TYPES;

/** JavaScript type a primitive is parsed into: `bigint` for 64-bit integers. */
export type PrimitiveValue<N extends PrimitiveName> =
  N extends `${string}64${string}` ? bigint : number;

/**
 * Primitives without an endianness suffix. They resolve to the `le` or `be`
 * variant depending on the parser's current endianness.
 */
export const ENDIAN_ALIASES = {
  uint16: "uint16",
  uint32: "uint32",
  uint64: "uint64",
  int16: "int16",
  int32: "int32",
  int64: "int64",
  float: "float",
  double: "double",
} as const;

export type EndianAlias = keyof typeof ENDIAN_ALIASES;

export const PRIMITIVE_NAMES = Object.keys(PRIMITIVE_TYPES) as PrimitiveName[];

export function isPrimitiveName(name: string): name is PrimitiveName {
  return Object.prototype.hasOwnProperty.call(PRIMITIVE_TYPES, name);
}
