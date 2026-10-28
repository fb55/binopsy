/** Native schema APIs. Input/output shape adaptations are outside throughput timing. */

import { Parser as Pretendo } from "@pretendonetwork/binary-parser";
import {
  bits as layout_bits,
  cstr as layout_cstr,
  f32 as layout_f32,
  offset as layout_offset,
  seq as layout_seq,
  struct as layout_struct,
  u16 as layout_u16,
  u16be as layout_u16be,
  u32 as layout_u32,
  u8 as layout_u8,
} from "@solana/buffer-layout";
import {
  addCodecSentinel as solana_addCodecSentinel,
  addCodecSizePrefix as solana_addCodecSizePrefix,
  fixCodecSize as solana_fixCodecSize,
  getArrayCodec as solana_getArrayCodec,
  getBytesCodec as solana_getBytesCodec,
  getDiscriminatedUnionCodec as solana_getDiscriminatedUnionCodec,
  getF32Codec as solana_getF32Codec,
  getF64Codec as solana_getF64Codec,
  getI8Codec as solana_getI8Codec,
  getStructCodec as solana_getStructCodec,
  getU16Codec as solana_getU16Codec,
  getU32Codec as solana_getU32Codec,
  getU8Codec as solana_getU8Codec,
  getUtf8Codec as solana_getUtf8Codec,
} from "@solana/codecs";
import { Parser } from "binary-parser";
import binaryEncoder from "binary-parser-encoder";
import {
  F32LE as packed_F32LE,
  F64LE as packed_F64LE,
  I8 as packed_I8,
  U16LE as packed_U16LE,
  U32LE as packed_U32LE,
  U8 as packed_U8,
  array as packed_array,
  bits as packed_bits,
  bytes as packed_bytes,
  cstring as packed_cstring,
  string as packed_string,
  struct as packed_struct,
  tag as packed_tag,
} from "micro-packed";
import {
  Array as RArray,
  Buffer as RBuffer,
  String as RString,
  Struct as RStruct,
  VersionedStruct as RVersionedStruct,
  doublele as restructure_doublele,
  floatle as restructure_floatle,
  int8 as restructure_int8,
  uint16le as restructure_uint16le,
  uint32le as restructure_uint32le,
  uint8 as restructure_uint8,
} from "restructure";
import {
  BufferReader as TBufferReader,
  BufferWriter as TBufferWriter,
  arrayOf as typed_arrayOf,
  object as typed_object,
  string as typed_string,
  u16 as typed_u16,
  u32 as typed_u32,
} from "typed-binary";

import { binopsySchema } from "./binopsy.mjs";
import { manual, textSize, bufferOf } from "./manual.mjs";

export const libraries = [
  "manual",
  "binopsy",
  "binary-parser",
  "binary-parser-encoder",
  "restructure",
  "typed-binary",
  "micro-packed",
  "@solana/codecs",
  "@pretendonetwork/binary-parser",
  "@solana/buffer-layout",
];

const parserText = (p, key) =>
  p
    .uint32le(`${key}Length`)
    .string(key, { length: `${key}Length`, encoding: "utf8" });

/**
 * Builds schemas for the three Parser-shaped APIs.
 * @param P The library's Parser constructor.
 * @param name Scenario name.
 * @param small Use the validation array length.
 * @returns The schema.
 */
function parserSchema(P, name, small) {
  const point = () => new P().floatle("x").floatle("y").uint16le("id");
  switch (name) {
    case "header": {
      return new P()
        .uint32le("magic")
        .uint16le("version")
        .uint16le("flags")
        .uint32le("length")
        .uint32le("sequence");
    }
    case "bits": {
      return new P()
        .bit3("version")
        .bit5("flags")
        .bit12("length")
        .bit4("kind")
        .uint16le("sequence");
    }
    case "numeric": {
      return new P().array("values", {
        type: "uint32le",
        length: small === true ? 8 : 4096,
      });
    }
    case "text": {
      return new P()
        .string("short", { zeroTerminated: true, encoding: "utf8" })
        .string("medium", { zeroTerminated: true, encoding: "utf8" })
        .string("long", { zeroTerminated: true, encoding: "utf8" });
    }
    case "points": {
      return new P()
        .uint16le("pointsCount")
        .array("points", { type: point(), length: "pointsCount" });
    }
    case "union": {
      return new P().uint8("tag").choice("data", {
        tag: "tag",
        choices: {
          0: new P().uint32le("sequence"),
          1: point(),
          2: parserText(new P(), "message"),
        },
      });
    }
    case "record": {
      return parserText(
        parserText(
          new P()
            .uint32le("rowId")
            .uint8("cls")
            .array("ratings", { type: "uint16le", length: 5 })
            .nest("club", { type: new P().uint32le("row").uint32le("uid") })
            .array("attributes", { type: "uint8", length: 69 }),
          "name",
        ),
        "fullName",
      )
        .uint8("itemsCount")
        .array("items", {
          type: new P()
            .uint8("kind")
            .uint16le("a")
            .uint32le("b")
            .int8("c")
            .floatle("d"),
          length: "itemsCount",
        })
        .uint8("hasExtra")
        .choice("extra", {
          tag: "hasExtra",
          choices: {
            0: new P(),
            1: new P().uint32le("x").buffer("y", { length: 12 }),
          },
        })
        .uint32le("historyCount")
        .array("history", { type: "uint8", length: "historyCount" })
        .doublele("value")
        .uint32le("uniqueId");
    }
    default: {
      throw new Error(`Unknown scenario ${name}`);
    }
  }
}

/**
 * Adds only bookkeeping fields required by Parser APIs.
 * @param name Scenario name.
 * @param v Canonical value.
 * @returns A native encoding input.
 */
function parserInput(name, v) {
  if (name === "record") {
    return {
      ...v,
      nameLength: textSize(v.name),
      fullNameLength: textSize(v.fullName),
      itemsCount: v.items.length,
      historyCount: v.history.length,
      extra: v.hasExtra === 1 ? { ...v.extra, y: bufferOf(v.extra.y) } : {},
    };
  }
  if (name === "points") return { ...v, pointsCount: v.points.length };
  if (name === "union" && v.tag === 2) {
    return {
      ...v,
      data: { ...v.data, messageLength: textSize(v.data.message) },
    };
  }
  return v;
}

/**
 * Composes common schemas using each library's own combinators.
 * @param api Native constructors with uniform argument order.
 * @param name Scenario name.
 * @param small Use the validation array length.
 * @returns A native schema.
 */
function composed(api, name, small) {
  const {
    struct,
    array,
    text,
    cstring,
    tag,
    bytes,
    u8,
    u16,
    u32,
    i8,
    f32,
    f64,
  } = api;
  const point = () => struct({ x: f32, y: f32, id: u16 });
  switch (name) {
    case "header": {
      return struct({
        magic: u32,
        version: u16,
        flags: u16,
        length: u32,
        sequence: u32,
      });
    }
    case "numeric": {
      return struct({ values: array(u32, small === true ? 8 : 4096) });
    }
    case "text": {
      return struct({ short: cstring, medium: cstring, long: cstring });
    }
    case "points": {
      return struct({ points: array(point(), u16) });
    }
    case "bits": {
      return struct({
        version: api.bits(3),
        flags: api.bits(5),
        length: api.bits(12),
        kind: api.bits(4),
        sequence: u16,
      });
    }
    case "union": {
      return tag([
        struct({ sequence: u32 }),
        point(),
        struct({ message: text(u32) }),
      ]);
    }
    case "record": {
      return struct({
        rowId: u32,
        cls: u8,
        ratings: array(u16, 5),
        club: struct({ row: u32, uid: u32 }),
        attributes: array(u8, 69),
        name: text(u32),
        fullName: text(u32),
        items: array(struct({ kind: u8, a: u16, b: u32, c: i8, d: f32 }), u8),
        extra: tag([struct({}), struct({ x: u32, y: bytes(12) })]),
        history: array(u8, u32),
        value: f64,
        uniqueId: u32,
      });
    }
    default: {
      throw new Error(`Unknown scenario ${name}`);
    }
  }
}

/**
 * Returns native combinators without doing work in timed calls.
 * @param library The compositional library.
 * @returns Constructors for that library.
 */
function compositionApi(library) {
  if (library === "micro-packed") {
    return {
      struct: packed_struct,
      array: (t, n) => packed_array(n, t),
      text: packed_string,
      cstring: packed_cstring,
      bytes: packed_bytes,
      tag: (cases) =>
        packed_tag(packed_U8, Object.fromEntries(cases.map((v, i) => [i, v]))),
      bits: packed_bits,
      u8: packed_U8,
      u16: packed_U16LE,
      u32: packed_U32LE,
      i8: packed_I8,
      f32: packed_F32LE,
      f64: packed_F64LE,
    };
  }
  if (library === "restructure") {
    return {
      struct: (fields) => new RStruct(fields),
      array: (t, n) => new RArray(t, n),
      text: (n) => new RString(n, "utf8"),
      cstring: new RString(null, "utf8"),
      bytes: (n) => new RBuffer(n),
      tag: (cases) =>
        new RVersionedStruct(
          restructure_uint8,
          Object.fromEntries(cases.map((v, i) => [i, { data: v }])),
        ),
      u8: restructure_uint8,
      u16: restructure_uint16le,
      u32: restructure_uint32le,
      i8: restructure_int8,
      f32: restructure_floatle,
      f64: restructure_doublele,
    };
  }
  return {
    struct: (fields) => solana_getStructCodec(Object.entries(fields)),
    array: (t, n) => solana_getArrayCodec(t, { size: n }),
    text: (n) => solana_addCodecSizePrefix(solana_getUtf8Codec(), n),
    cstring: solana_addCodecSentinel(
      solana_getUtf8Codec(),
      new Uint8Array([0]),
    ),
    bytes: (n) => solana_fixCodecSize(solana_getBytesCodec(), n),
    tag: (cases) =>
      solana_getDiscriminatedUnionCodec(
        cases.map((v, i) => [i, solana_getStructCodec([["data", v]])]),
        { size: solana_getU8Codec(), discriminator: "tag" },
      ),
    u8: solana_getU8Codec(),
    u16: solana_getU16Codec(),
    u32: solana_getU32Codec(),
    i8: solana_getI8Codec(),
    f32: solana_getF32Codec(),
    f64: solana_getF64Codec(),
  };
}

const layoutPoint = () =>
  layout_struct([layout_f32("x"), layout_f32("y"), layout_u16("id")]);

/**
 * Uses buffer-layout's native fixed, external-count, union, and bit layouts.
 * @param name Scenario name.
 * @param small Use the validation array length.
 * @returns A layout.
 */
function layoutSchema(name, small) {
  switch (name) {
    case "header": {
      return layout_struct([
        layout_u32("magic"),
        layout_u16("version"),
        layout_u16("flags"),
        layout_u32("length"),
        layout_u32("sequence"),
      ]);
    }
    case "numeric": {
      return layout_struct([
        layout_seq(layout_u32(), small === true ? 8 : 4096, "values"),
      ]);
    }
    case "text": {
      return layout_struct([
        layout_cstr("short"),
        layout_cstr("medium"),
        layout_cstr("long"),
      ]);
    }
    case "points": {
      return layout_struct([
        layout_u16("pointsCount"),
        layout_seq(layoutPoint(), layout_offset(layout_u16(), -2), "points"),
      ]);
    }
    case "bits": {
      const first = layout_bits(layout_u8(), true);
      first.addField(3, "version");
      first.addField(5, "flags");
      const second = layout_bits(layout_u16be(), true);
      second.addField(12, "length");
      second.addField(4, "kind");
      return layout_struct([
        first.replicate("first"),
        second.replicate("second"),
        layout_u16("sequence"),
      ]);
    }
    default: {
      throw new Error(`Unsupported layout scenario ${name}`);
    }
  }
}

/**
 * Produces an adapter; missing native features are explicit skips.
 * @param library The library.
 * @param name Scenario name.
 * @param small Use the validation array length.
 * @returns Native operations and optional untimed shape conversions, or a skip reason.
 */
export function create(library, name, small = false) {
  if (library === "manual") return manual(name);
  if (library === "binopsy") {
    const codec = binopsySchema(name, small);
    return { decode: (b) => codec.decode(b), encode: (v) => codec.encode(v) };
  }
  if (library === "typed-binary") {
    if (!["header", "numeric", "text"].includes(name)) {
      return {
        skip: "No native matching wire schema (u16-count arrays, scalar f64, numeric bitfields, or u8 tags).",
      };
    }
    return typedAdapter(name, small);
  }
  if (
    [
      "binary-parser",
      "binary-parser-encoder",
      "@pretendonetwork/binary-parser",
    ].includes(library)
  ) {
    if (
      library === "@pretendonetwork/binary-parser" &&
      ["union", "record", "text"].includes(name)
    ) {
      return { skip: "No choice combinator or zero-terminated string schema." };
    }
    const P =
      library === "binary-parser"
        ? Parser
        : library === "binary-parser-encoder"
          ? binaryEncoder.Parser
          : Pretendo;
    const codec = parserSchema(P, name, small);
    return {
      decode: (b) => codec.parse(b),
      ...(library === "binary-parser"
        ? { encodeSkip: "Decode-only library." }
        : library === "@pretendonetwork/binary-parser" && name === "points"
          ? {
              encodeSkip:
                "1.0.0 underallocates variable arrays of structs (52 instead of 502 bytes).",
            }
          : { encode: (v) => codec.encode(v) }),
      input: (v) => parserInput(name, v),
    };
  }
  if (library === "@solana/buffer-layout") {
    if (["record", "union"].includes(name)) {
      return {
        skip: "Count-prefixed UTF-8 strings require a custom Layout; no hand-written codec substituted.",
      };
    }
    const codec = layoutSchema(name, small);
    return {
      decode: (b) => codec.decode(b),
      encode(v) {
        const size =
          name === "text"
            ? textSize(v.short) + textSize(v.medium) + textSize(v.long) + 3
            : name === "points"
              ? 2 + v.points.length * 10
              : codec.span;
        const b = new Uint8Array(size);
        codec.encode(v, b);
        return b;
      },
      input: (v) =>
        name === "bits"
          ? {
              first: { version: v.version, flags: v.flags },
              second: { length: v.length, kind: v.kind },
              sequence: v.sequence,
            }
          : parserInput(name, v),
      output: (v) =>
        name === "bits" ? { ...v.first, ...v.second, sequence: v.sequence } : v,
    };
  }
  if (name === "bits" && library !== "micro-packed") {
    return {
      skip: "Native bitsets are booleans, not multi-bit integer fields.",
    };
  }
  const codec = composed(compositionApi(library), name, small);
  const key =
    library === "micro-packed"
      ? "TAG"
      : library === "restructure"
        ? "version"
        : "tag";
  const nativeTag = (tag, data) => ({ [key]: tag, data });
  return {
    decode: (b) =>
      library === "restructure" ? codec.fromBuffer(b) : codec.decode(b),
    encode: (v) =>
      library === "restructure" ? codec.toBuffer(v) : codec.encode(v),
    input: (v) =>
      name === "union"
        ? nativeTag(v.tag, v.data)
        : name === "record"
          ? { ...v, extra: nativeTag(v.hasExtra, v.extra) }
          : v,
    output: (v) =>
      name === "union"
        ? { tag: v[key], data: v.data }
        : name === "record"
          ? { ...v, hasExtra: v.extra[key], extra: v.extra.data }
          : v,
  };
}

/**
 * Wraps typed-binary's read/write API, allocating output from its measured size.
 * @param name Scenario.
 * @param small Validation array length.
 * @returns Operations.
 */
function typedAdapter(name, small) {
  const codec =
    name === "header"
      ? typed_object({
          magic: typed_u32,
          version: typed_u16,
          flags: typed_u16,
          length: typed_u32,
          sequence: typed_u32,
        })
      : name === "numeric"
        ? typed_object({
            values: typed_arrayOf(typed_u32, small === true ? 8 : 4096),
          })
        : typed_object({
            short: typed_string,
            medium: typed_string,
            long: typed_string,
          });
  const fixedSize = name === "text" ? Number.NaN : codec.maxSize;
  return {
    decode: (b) =>
      codec.read(
        new TBufferReader(b.buffer, {
          byteOffset: b.byteOffset,
          endianness: "little",
        }),
      ),
    encode(v) {
      const b = new Uint8Array(
        Number.isFinite(fixedSize) ? fixedSize : codec.measure(v).size,
      );
      codec.write(new TBufferWriter(b.buffer, { endianness: "little" }), v);
      return b;
    },
  };
}
