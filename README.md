# `binopsy`

Typed binary codecs for TypeScript: declare a format once, then decode it, encode it and stream it.
Codecs compile to JavaScript functions specialized to their format.

```sh
npm install binopsy
```

binopsy is an ES module with TypeScript types. It works on `Uint8Array`s (Node.js `Buffer`s are ones), in Node.js and in browsers.

```ts
import { array, bin, string, u16le, u8 } from "binopsy";

const Player = bin()
  .u32le("id")
  .field("name", string(u8)) // A length byte, then the string
  .u8("count")
  .field("ratings", array(u16le, "count"));

const player = Player.decode(input);
// { id: number; name: string; count: number; ratings: number[] }

Player.encode(player); // The bytes again
```

Types are inferred: no annotations are needed, and mistakes (a misspelled field, a length that is not a number, a case for a value the tag never has) are type errors where they are written.

Each section below solves one problem:

- [Read a file format](#read-a-file-format): magic bytes, then chunks with a type and a length.
- [Optional and versioned parts](#optional-and-versioned-parts): fields that depend on a version or a flag.
- [Messages with a type tag](#messages-with-a-type-tag): a protocol whose messages differ by type.
- [Bit-packed fields](#bit-packed-fields): flags and small numbers that share bytes.
- [Decode a stream](#decode-a-stream): messages from a socket, records from a file.
- [Read a few fields of large records](#read-a-few-fields-of-large-records), quickly.
- [Write messages and files](#write-messages-and-files), with lengths and checksums filled in.
- [Recursive structures](#recursive-structures): trees, nested containers.
- [Custom encodings, such as varints](#custom-encodings-such-as-varints).
- [Malformed input](#malformed-input): what failed, and where.
- [Parts shared by formats](#parts-shared-by-formats): common headers and groups of fields.

The [reference](#reference) lists the rest: every codec, the forms of lengths, the options of strings, and errors.

## Read a file format

A file starts with magic bytes, then holds sections, each with a type and a length. A PNG image is one:

```ts
import { readFileSync } from "node:fs";

import { array, bin, bytes, literal, string, u64be } from "binopsy";

const Chunk = bin()
  .u32be("length")
  .field("type", string(4)) // "IHDR", "IDAT", …
  .field("data", bytes("length")) // As many bytes as `length` says
  .u32be("crc");

const Png = bin()
  .field("signature", literal(u64be, 0x89504e470d0a1a0an))
  .field("chunks", array(Chunk, { until: (chunk) => chunk.type === "IEND" }));

const png = Png.decode(readFileSync("image.png"));
png.chunks.map((chunk) => chunk.type); // ["IHDR", "IDAT", "IEND"]
```

The data of the first chunk is a header: decode it with a parser of its own.

```ts
const Header = bin()
  .u32be("width")
  .u32be("height")
  .u8("bitDepth")
  .u8("colorType")
  .u8("compression")
  .u8("filter")
  .u8("interlace");

const { width, height } = Header.decode(png.chunks[0].data);
```

- `literal(codec, value)` is a fixed value: decoding fails on any other, and encoding writes it, so it may be omitted. Values are numbers, strings, bigints or booleans that the codec stores exactly (not `0.1` in an `f32le`).
- Numbers are little (`le`) or big (`be`) endian, except `u8` and `i8`. 64-bit integers (`u64be`, `i64le`, …) are `bigint`s. Each number codec has a parser method: `.u32be("length")` is `.field("length", u32be)`.
- A length is a number, the name of an earlier field (`bytes("length")`), a function of the earlier fields, or a codec of a count read just before the value (`string(u8)`). See [lengths](#lengths).
- `array(item, { until })` reads up to the first item for which `until` is true, and includes it.
- `bytes` values view the input: `new Uint8Array(bytes)` copies one.
- `.skip(n)` steps over `n` reserved bytes, and `.align(n)` over those up to a multiple of `n` bytes from the start of the parser: a RIFF chunk, `bin().field("id", string(4)).u32le("size").field("data", bytes("size")).align(2)`, takes an even number of bytes. Encoding writes zeros.
- `decode(bytes, offset)` decodes a value at an offset, such as an index whose offset the header gives. Bytes after the value are ignored.

## Optional and versioned parts

Later versions of a format add fields, and some fields are only there if a flag says so:

```ts
import { bin, literal, optional, string, u32le, u8, when } from "binopsy";

const Header = bin()
  .field("magic", literal(string(4), "DATA"))
  .u8("version")
  .u32le("count")
  .field(
    "checksum", // Since version 2
    when((header) => header.version >= 2, u32le),
  )
  .field("comment", optional(u8, string(u8))); // A flag byte, then the comment if it is not 0
// { magic: "DATA"; version: number; count: number; checksum: number | null; comment: string | null }
```

- Absent values are `null`. When encoding, a value must be `null` exactly when it is absent: `{ version: 1, checksum: 5, … }` throws an `EncodeError`.
- `when(condition, codec)` reads the value if `condition` holds: the name of an earlier field that is truthy, or a function of the earlier fields that returns `true`.
- `optional(flag, codec)` reads a flag with the codec `flag`, then the value if the flag is not zero. Encoding writes 0 or 1.
- Parts laid out differently in each version are a [match](#messages-with-a-type-tag) on the version. `fail(message)` is a part you do not support: `match("compression").case(0, bytes(u32le)).case(1, fail("compressed data is not supported"))`.

## Messages with a type tag

Each message of a protocol starts with its type, and the type decides what follows:

```ts
import { bin, match, string, u16be, u8, type Output } from "binopsy";

const Message = bin()
  .u8("type")
  .merge(
    match("type")
      .case(1, bin().field("name", string(u8))) // Join
      .case(2, bin().u32be("room").field("text", string(u16be))) // Chat
      .case(3, bin().f32be("x").f32be("y")), // Move
  );

type Message = Output<typeof Message>;
// | { type: 1; name: string }
// | { type: 2; room: number; text: string }
// | { type: 3; x: number; y: number }

function handle(message: Message) {
  if (message.type === 2) console.log(message.text); // TypeScript knows `text` is there
}
```

- `match(tag)` picks a codec by the value of the earlier field `tag`. `.merge` adds the fields of the case's parser to the message.
- `.field(name, match(…))` puts the case's value in a field instead: `bin().u8("type").field("value", match("type").case(1, i32le).case(2, string(u32le)))` decodes `{ type: 1; value: number } | { type: 2; value: string }`.
- A tag without a case fails, with a `DecodeError` of code `"no-match"`. `.otherwise(codec)` takes all other values.
- Case values are numbers, strings, bigints or booleans (`1` and `"1"` are different), each with one case.
- The tag may be computed from the earlier fields, with their type annotated: `match((o: { kind: number }) => o.kind & 0xf)`.
- A match is a codec: define it once, and use it in several parsers.

## Bit-packed fields

Fields smaller than a byte, such as versions and flags, share bytes. An IPv4 header:

```ts
import { bin, bytes, map } from "binopsy";

// An IPv4 address, as "192.168.0.1"
const address = map(bytes(4), {
  decode: (b) => b.join("."),
  encode: (text: string) => Uint8Array.from(text.split("."), Number),
});

const IPv4 = bin()
  .bits("version", 4)
  .bits("ihl", 4) // The header's length, in 32-bit words
  .bits("dscp", 6)
  .bits("ecn", 2)
  .u16be("totalLength")
  .u16be("identification")
  .bits("reserved", 1)
  .bits("dontFragment", 1)
  .bits("moreFragments", 1)
  .bits("fragmentOffset", 13)
  .u8("ttl")
  .u8("protocol")
  .u16be("checksum")
  .field("source", address)
  .field("destination", address)
  .field(
    "options",
    bytes((header) => header.ihl * 4 - 20),
  );

// The header 45 00 00 73 00 00 40 00 40 11 b8 61 c0 a8 00 01 c0 a8 00 c7:
IPv4.decode(packet);
// { version: 4, ihl: 5, dscp: 0, ecn: 0, totalLength: 115, identification: 0,
//   reserved: 0, dontFragment: 1, moreFragments: 0, fragmentOffset: 0,
//   ttl: 64, protocol: 17, checksum: 47201,
//   source: "192.168.0.1", destination: "192.168.0.199", options: Uint8Array(0) }
```

- `.bits(name, width)` adds a number of 1 to 53 bits. Bit fields that follow each other share their bytes; other fields start at the next byte. A run of bit fields is padded to whole bytes, with zeros when encoding.
- The first bit field takes the most significant bits of its byte, as in network protocols. `bin({ bitOrder: "lsb" })` starts with the least significant ones.
- `map(codec, { decode, encode })` converts values both ways. Without `encode`, it only decodes.

## Decode a stream

Messages arrive from a socket, or records from a file, in chunks that do not line up with them. `decodeStream` decodes the values as the chunks arrive. With the `Message` above, and a size before each:

```ts
import { connect } from "node:net";

import { decodeStream, sized, u16be } from "binopsy";

const Frame = sized(u16be, Message); // A 16-bit size, then the message

const socket = connect(9000, "localhost");
for await (const message of decodeStream(Frame, socket)) {
  handle(message);
}
```

- The source is any iterable or async iterable of `Uint8Array`s: a Node.js stream (a socket, `fs.createReadStream`), a web `ReadableStream` (such as `response.body`), or an array of chunks.
- Values may span any number of chunks: decoding continues as more input arrives, without starting over. If the input ends inside a value, the loop throws a `DecodeError` of code `"end-of-input"`.
- Leaving the loop (with `break`, or by an error) closes the source. For a Node.js stream of the values, use `Readable.from(decodeStream(codec, source))`.
- `sized(length, codec)` is a value in a region of `length` bytes: it may not read past them, and bytes it leaves are skipped. A case `.otherwise(bin().field("payload", bytes(Infinity)))` in a region keeps messages of unknown types as their bytes.
- For bytes in memory, `new Reader(bytes)` reads values one after the other: `reader.read(codec)` returns the next one, and `reader.done` tells whether all bytes were read.

[examples/tar.ts](examples/tar.ts) lists tar archives this way.

## Read a few fields of large records

A file holds many records, and you need two fields of each. `pick` decodes only those, and steps over the rest:

```ts
import { array, bin, bytes, Reader, string, u8 } from "binopsy";

const Song = bin()
  .u32le("id")
  .field("title", string(u8))
  .field("artists", array(string(u8), u8))
  .u32le("coverSize")
  .field("cover", bytes("coverSize"))
  .f64le("duration");

const Summary = Song.pick("id", "duration"); // Decodes { id: number; duration: number }

const durations = new Map<number, number>();
const reader = new Reader(file);
while (!reader.done) {
  const { id, duration } = reader.read(Summary);
  durations.set(id, duration);
}
```

- Fields stepped over are not decoded: no strings, no objects, no conversions of `map`. Their literals and refinements are still checked.
- Fields that a later length or tag names are read too (here `coverSize`). A length or condition given as a function may read any earlier field, so all the fields before it are decoded: name a field where you can.
- `pick()` without names steps over whole values, e.g. to count them.
- A picked parser only decodes (also in streams); it does not encode.

## Write messages and files

Every codec encodes what it decodes, except picked parsers and codecs without `encode`. Counts and sizes read before a value are written from the value:

```ts
Frame.encode({ type: 2, room: 7, text: "hi" });
// Uint8Array [0, 9, 2, 0, 0, 0, 7, 0, 2, 104, 105]: the size, the type, the room, the length of the text, and the text
```

A field that a later length names is given with the value, or computed from it. For the PNG `Chunk` above, the length and the CRC:

```ts
import { crc32 } from "node:zlib";

const WritableChunk = Chunk.computed({
  length: (chunk) => chunk.data.length,
  crc: (chunk) => crc32(chunk.data, crc32(chunk.type)),
});

WritableChunk.encode({ type: "IEND", data: new Uint8Array(0) });
// Uint8Array [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]
```

- The type of the values to encode, `Input<typeof WritableChunk>`, is that of decoded values, `Output<typeof WritableChunk>`, except that computed fields and literals may be omitted. A value given for a computed field must be the computed one.
- `.computed(name, f)` computes one field; `.computed({ … })` several, each from the value without the computed fields. Like every method, it returns a new parser (to which no fields can be added); `Chunk` is unchanged.
- Values are checked: numbers must fit, arrays and bytes must have their length, and text must fit its string. Failures throw an `EncodeError` with the path of the field: a `name` of 300 bytes gives `` expected u8, got 300 in `name` ``.
- `encodeInto(value, bytes, offset?)` writes to a buffer you have, and returns the offset after the value. If it fails, it may have written part of the value.
- `sizeOf(value)` is the number of bytes of `value`, without encoding it (`custom` codecs are encoded, unless they have a `size`). It skips the checks of encoding, which may still fail.

## Recursive structures

A format contains itself: a tree of nodes, or containers in containers.

```ts
import { array, bin, lazy, string, u16le, u8, type Codec } from "binopsy";

interface Tree {
  name: string;
  children: Tree[];
}

const Tree: Codec<Tree> = bin()
  .field("name", string(u8))
  .field(
    "children",
    array(
      lazy(() => Tree),
      u16le,
    ),
  );
```

- `lazy(() => codec)` is a codec defined later, or the one being defined. It sees no fields around it: functions in it get only the fields of its own parsers.
- TypeScript cannot infer the type of a value that refers to itself: annotate it, as `Codec<Tree>`.

## Custom encodings, such as varints

Some encodings are not fields of a fixed layout, such as variable-length integers. `custom` takes functions of your own:

```ts
import { custom } from "binopsy";

// Variable-length integers (LEB128) of up to 32 bits.
const varint = custom({
  decode(input, final) {
    let value = 0;
    for (let i = 0; i < input.length && i < 5; i++) {
      if (i === 4 && input[i] > 0x0f) throw new Error("varint exceeds u32");
      value += (input[i] & 0x7f) * 2 ** (7 * i);
      if (input[i] < 0x80) return { value, bytesRead: i + 1 };
    }
    if (!final && input.length < 5) return undefined;
    throw new Error("invalid varint");
  },
  encode(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error("expected an unsigned 32-bit integer");
    }
    const digits = [];
    let rest = value;
    do {
      digits.push((rest % 128) | (rest >= 128 ? 0x80 : 0));
      rest = Math.floor(rest / 128);
    } while (rest);
    return Uint8Array.from(digits);
  },
});
```

It works wherever a codec does, also as a length:

```ts
import { array, bin, string } from "binopsy";

const Entry = bin()
  .field("key", string(varint)) // A varint length, then the text
  .field("values", array(varint, varint)); // A varint count, then varints

Entry.encode({ key: "id", values: [1, 300] }); // Uint8Array [2, 105, 100, 2, 1, 172, 2]
```

- `decode(bytes, final)` gets the bytes from the value on. It returns `{ value, bytesRead }`, or `undefined` if it needs more bytes and `final` is false (in a stream, more may follow).
- It is then called again with more bytes, so it must have no side effects.
- Given a number as `size`, `decode` gets exactly that many bytes, and `final` is true. A function of a value as `size` is only for `sizeOf`, which calls it rather than encoding the value. Without `encode`, the codec only decodes.
- For a conversion of bytes that other codecs read, `map` is enough: [examples/tar.ts](examples/tar.ts) reads octal numbers with a `map` of `bytes`.

## Malformed input

Input from outside may be truncated or corrupt. Decoding then throws a `DecodeError` that tells what failed, and where (it never returns part of a value). With the `Png` above, and an image cut off in its second chunk:

```ts
import { DecodeError } from "binopsy";

try {
  Png.decode(truncated);
} catch (e) {
  if (!(e instanceof DecodeError)) throw e;
  console.log(e.code, e.path, e.offset); // "end-of-input" ["chunks", 1, "data"] 41
  console.log(e.message); // "unexpected end of input (10 bytes needed, 4 left) in `chunks[1].data` at offset 41"
}
```

- `code` is `"end-of-input"`, `"invalid"` (a value failed a check, e.g. of a literal), `"no-match"` (a tag without a case), or `"error"` (a function of yours threw; its error is the `cause`).
- `refine(codec, test, message?)` adds a check of your own, when decoding and when encoding: `refine(u32be, (width) => width > 0, "width must be positive")`. A type guard as `test` narrows the type.
- An `EncodeError` has the `path` too, but no offset.

## Parts shared by formats

Parsers are codecs, so they nest: `.field("header", Header)`. `.merge(Header)` adds the fields of `Header` instead. A parser can also read fields of the parser it is merged into, which it declares:

```ts
import { bin, bytes } from "binopsy";

const Prefix = bin().u8("kind").u16le("length");
const Payload = bin<{ length: number }>().field("body", bytes("length"));
const Packet = Prefix.merge(Payload); // { kind: number; length: number; body: Uint8Array }
```

A group of fields used in several parsers is a function of parsers, added with `.pipe`:

```ts
import { bin, bytes, type Bin } from "binopsy";

const withValues = <T extends { count: number }, I extends { count: number }>(
  b: Bin<T, I>,
) =>
  b.field(
    "values",
    bytes((o) => o.count * 2),
  );

const Record = bin().u8("count").pipe(withValues);
```

- `.merge(cond ? A : B)` adds the fields of one of several parsers, as a union.
- Codecs defined outside a parser, such as match cases, do not know its fields: annotate the argument of their functions, e.g. `(o: Output<typeof Prefix>) => …`.
- In generic functions, give lengths as functions (as above), or define the codecs that read fields outside them: names of fields cannot be checked against a type parameter.

## Performance

- A codec compiles to JavaScript functions for its format, each when it is first needed: a decoder, an encoder, a resumable decoder for streams, and a decoder for each `pick`. Fixed-size fields are read and written at constant offsets, and a run of them shares one bounds check.
- Compiling uses `new Function`: binopsy does not work where generating code is forbidden, such as under a Content Security Policy without `'unsafe-eval'`.
- Streams decode a value with the plain decoder when its chunk holds all of it, and resume decoding only for values that span chunks.
- `bench/parse.ts`, in the repository, measures decoding and encoding of a database-like format. Throughput depends on the format: measure yours, on your Node.js version and hardware.

## Reference

### Parsers

`bin()` is an empty parser; each method returns a new parser with a field added, typed from the fields before it.

- `.u8(name)`, `.i16le(name)`, … add a number field (a method for each number codec).
- `.bits(name, width)` adds a field of 1 to 53 bits.
- `.field(name, codec)` adds a field of any codec, including parsers and matches.
- `.merge(parser)` adds the fields of another parser, of one of several (`cond ? A : B`), or of the cases of a match of parsers.
- `.skip(size)` skips bytes, and `.align(size)` skips to a multiple of `size` bytes from the start of the parser (a merged parser aligns from its own start); encoding writes zeros.
- `.pipe(f)` applies a function adding fields.
- `.computed(name, f)` and `.computed({ … })` compute fields when encoding; they end the parser.
- `.pick(...names)` is a decoder of only the named fields.

`bin({ bitOrder: "lsb" })` takes the bits of bit fields from the least significant one. `bin<{ length: number }>()` reads the field `length` of the parser it is merged into, or is a match case of.

Field names are unique: adding a name twice throws when the parser is defined (TypeScript does not check it). Only the cases of one match may have fields of the same names; two matches may not, even on the same tag.

### Codecs

| Codec                                             | Values                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `u8`, `i8`, `u16le`, `i32be`, `f32le`, `f64be`, … | Integers of 8, 16, 24 and 32 bits and floats, little (`le`) or big (`be`) endian (`f32` rounds numbers to 32 bits)      |
| `u64le`, `i64be`, …                               | 64-bit integers, as `bigint`                                                                                            |
| `bytes(length)`                                   | `Uint8Array`s, viewing the input (`new Uint8Array(b)` copies them)                                                      |
| `string(length, options?)`                        | Strings stored in `length` bytes (see [strings](#strings))                                                              |
| `string({ terminator, max?, encoding? })`         | Strings ending with a terminator, of at most `max` bytes                                                                |
| `array(item, length)`                             | Arrays of `length` items                                                                                                |
| `array(item, { until })`                          | Arrays up to the first item for which `until(item)` is true (included)                                                  |
| `sized(length, codec)`                            | A value in a region of `length` bytes: it may not read past them, and they are padded with zeros                        |
| `literal(codec, value)`                           | A fixed value (a number, string, bigint or boolean), checked when decoding and written when encoding                    |
| `refine(codec, test, message?)`                   | Values passing `test`, when decoding and encoding (a type guard narrows their type)                                     |
| `map(codec, { decode, encode? })`                 | Values converted both ways; without `encode`, only when decoding                                                        |
| `optional(flag, codec)`                           | `null`, or a value after a non-zero `flag` (e.g. `u8`; encoding writes 0 or 1)                                          |
| `when(condition, codec)`                          | `null`, or a value if `condition` holds: an earlier field is truthy, or a function of the earlier fields returns `true` |
| `match(tag).case(value, codec)…`                  | One of several codecs, picked by a tag (`.otherwise(codec)` for other values)                                           |
| `lazy(() => codec)`                               | A codec defined later, for formats that contain themselves                                                              |
| `custom({ decode, encode?, size? })`              | A codec of functions of your own                                                                                        |
| `fail(message)`                                   | Nothing: decoding and encoding fail (e.g. for parts that are not supported)                                             |

Every codec has `decode`, `encode`, `encodeInto` and `sizeOf`, and `size`: the size of every value in bytes, or `NaN` if it varies (or, for `lazy`, is not known yet).

### Lengths

A `length` is

- a number; `Infinity` means up to the end of the input (or of the enclosing `sized` region),
- a codec of the count read before the value (`string(u32le)`: a 32-bit length, then the bytes; `sized(u32le, Chunk)`: a size, then a chunk),
- the name of an earlier number field (`bytes("size")`),
- or a function of the earlier fields (`bytes((o) => o.size * 2)`).

Lengths are non-negative safe integers (`Infinity` only as a number given to the codec, not from a field or a function). When encoding, a count read before a value is written from the value, and fields and functions giving a length must agree with it. A size read before a region is written after the region's value, so its codec must have a fixed size (e.g. `u32le`, or a `map` of it).

To be encoded, an array with `until` needs a last item for which `until` is true, and no other. Arrays read without a count (with `until`, or up to the end) fail on an item that takes no bytes, which would be read forever.

### Strings

```ts
string(16); // Exactly 16 bytes of text
string(16, { terminator: 0 }); // 16 bytes, the text ending with a zero (C's char[16])
string(16, { padRight: 0x20 }); // 16 bytes, the text padded with spaces
string(u8); // A length byte, then the text
string({ terminator: 0 }); // The text, then a zero
string({ terminator: 0, max: 16 }); // The same, of at most 16 bytes (a string of 16 bytes has no zero)
```

A string of a length (a number, a field or a function) takes all of it: without options, the text must fill it exactly. A terminator or padding allows shorter text: decoding stops at the terminator, or else removes the trailing padding. Text filling the whole length needs no terminator. Encoding pads with `padRight` (zeros by default), and rejects text that contains the terminator, or (with padding alone) ends with the padding, as it would decode to other text.

A count read before the string (`string(u8)`) counts the bytes of the text and of its terminator, if it has one. `string(Infinity, options)` takes the rest of the input. `string({ terminator, max })` takes the bytes up to and including its terminator, or `max` bytes; `max` is a number, an earlier field or a function.

The encodings are `"utf8"` (the default), `"latin1"`, `"ascii"` and `"utf16le"`: `string(8, { encoding: "utf16le", terminator: 0 })`. Lengths are in bytes (even ones in UTF-16); terminators and padding are bytes, or 16-bit units in UTF-16. Decoding keeps byte order marks; malformed UTF-8 becomes U+FFFD, UTF-16 keeps unpaired surrogates, and ASCII ignores the high bit. Encoding rejects characters that latin1 or ASCII do not have.

For other representations of bytes, such as hex, use `map(bytes(length), …)`.

### Bit fields

The bit fields of a merged parser continue the run (if they have the same bit order: adjoining runs of different orders throw); those of nested parsers, of merged matches, and of merged parsers that compute or pick fields start at a byte.

### Fields that functions see

Lengths, tags and functions see the fields before them. Functions get the decoded fields, or, when encoding, the values being encoded (so a field mapped from another representation has the type of both). When encoding, they see the fields before them (never later ones), with omitted literals and computed fields filled in. A parser's own fields hide those of the same names around it.

Functions must have no side effects, as they may be called again for the same value: a stream decodes a value again if it did not fit in its chunk, and calls `custom` decoders again with more bytes.

A literal keeps its default (and may be omitted) through `sized` and `lazy`, but not through `map`, arrays, `optional` or `when`.

### Decoding and encoding

`codec.decode(bytes, offset?)` decodes a value at `offset`, ignoring the bytes after it. `new Reader(bytes, offset?)` reads consecutive values: `reader.read(codec)` returns one and moves `reader.offset` past it (if it fails, the offset stays), and `reader.done` tells whether all bytes were read.

`trace(codec, bytes, offset?)` decodes a value and returns where each field of its parsers is, to annotate or compare bytes: `{ path, start, end, value }` for every field, after the fields inside it (`["items", 0, "name"]`, then `["items"]`). Bit fields have the bytes of their run. With `pick`, fields stepped over have `value: undefined`, and arrays stepped over without visiting their items have no spans for them.

`codec.encode(value)` returns a view of the bytes. Small results share a buffer with other results (as Node.js does for small `Buffer`s), but are never overwritten. Results are views of `ArrayBuffer`s (never of shared memory), so they work with `Blob`, `Response` and Web Crypto. `codec.encodeInto(value, bytes, offset?)` writes to `bytes` instead, and returns the offset after the value. Inputs and the bytes of `encodeInto` may be shared memory, but values must not be views of the bytes it writes to. Values being encoded are never changed.

Computed fields: with an object of functions, `.computed({ size: …, count: … })`, each function gets the value without the computed fields (and without filled-in literals), so they do not see each other's results. Results must not be `undefined`, and a value given for a computed field must be the computed one (as by `Object.is`). Merged into another parser, a parser computing fields still computes them from its own fields.

### Streams

`decodeStream(codec, source)` returns an async iterator of the values. Calls of `next` run one after the other. `return()` ends the iteration at once (a pending `next` gives no value), and resolves once the source is closed (async generators close after their pending read). Errors of the source are thrown as they are.

Every value must take at least one byte. A value that reads up to the end of the input, such as `bytes(Infinity)`, ends with the stream. `bytes` values stay valid as long as the source does not reuse its chunks. A value spanning chunks is collected in a buffer of its own (holding the rest of the input, for a value that reads up to its end). Functions in a value may run twice, as it is first decoded as if its chunk held all of it.

### Errors

| `DecodeError` | Holds                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------- |
| `code`        | `"end-of-input"`, `"invalid"`, `"no-match"`, or `"error"` (an exception in a function)        |
| `path`        | The field names and array indexes of the value that failed, e.g. `["items", 3, "name"]`       |
| `offset`      | The offset of the value that failed                                                           |
| `detail`      | The failure, without its location; `message` adds them: ``… in `items[3].name` at offset 12`` |
| `cause`       | The exception, for `"error"`                                                                  |

An `EncodeError` has a `path`, a `detail` and a `cause`, but no `code` or offset. Offsets of `DecodeError`s that `custom` decoders throw are in the bytes they got; binopsy moves them to the input's.

### Types

- `Output<typeof codec>` is the type of decoded values, `Input<typeof codec>` that of encoded ones.
- `Codec<O, I>` is the type of codecs; `Bin<T, I>` that of parsers, and `Struct<T, I>` that of parsers adding no more fields (computing some, or picking some).
- `Context<typeof codec>` is the type of the fields a codec reads around it. A codec reading such fields (e.g. `bytes("length")`) only decodes and encodes in a parser that has them: `decode`, `encode`, `sizeOf`, `trace`, `Reader` and streams take codecs that read none.
- `AnyCodec` and `AnyBin` accept any codec and any parser, in generic functions.
- Options and parts: `BinOptions`, `StringOptions`, `TerminatedStringOptions`, `Encoding`, `Length`, `CustomOptions`, `DecodeResult` and `Path`.

TypeScript may miss a misspelled option in a union of option objects (`cond ? { terminator: 0 } : { padRight: 0 }`); options are also checked when a codec is defined.

See [CHANGELOG.md](CHANGELOG.md) for changes.

**License: MIT**
