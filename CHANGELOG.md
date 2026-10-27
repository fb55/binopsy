# Changelog

## Unreleased

`enumOf(codec, table, policy?)` names numeric wire values or checks membership in TypeScript enums and const objects. Unknown raw values can be rejected (`enumOf.reject`), kept (`enumOf.keep`), or decoded as a declared fallback passed directly as the third argument. A policy is required unless a small raw domain is completely covered. Static coverage proofs are limited to `bits(1)` through `bits(5)` (at most 32 values), using a complete tuple, numeric-key object, or TypeScript enum/const object's member values. Larger codecs, including `u8` and `i8`, and dynamic tables require an explicit policy in TypeScript. Runtime still recognizes complete domains through eight bits and checks integer bounds at definition time. Tables are snapshotted and validated when defined; unknown data reports its field and offset, including under `pick`.

Numeric enum members work as `match` cases, keeping their enum types.

Bundlers leave out the code of matches and bit fields that a format does not use.
Bit fields are codecs: a bit field is `.field(name, bits(width))`.
`bits` and its `enumOf`, `map`, `literal`, and `refine` wrappers pack together as direct parser fields. Standalone use and array items are rejected by the types and throw when compiled from JavaScript. Consecutive fields retain their byte sharing, bit order, and merge behavior.

binopsy is rewritten in TypeScript, around codecs: values that decode and encode, compiled to specialized JavaScript functions.
Parsers are defined as before, field by field, but each method returns a new parser, and every parser is a codec.
Changes are relative to the last published version, 0.0.0, whose API followed binary-parser's; all of it changed.
Formats keep their bytes with the rewrites below (except where noted), but not the quirks of 0.0.0 (such as returning partial values for truncated input).

### Migration

| 0.0.0                                                                        | Now                                                                                                              |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `const Bin = require("binopsy")`, `new Bin()`, `Bin.start()`                 | `import { bin } from "binopsy"`, `bin()` (ES module only)                                                        |
| Field methods change the parser                                              | Field methods return a new parser                                                                                |
| `.uint8("a")`, `.int16le("a")`, `.floatbe("a")`, `.doublele("a")`            | `.u8("a")`, `.i16le("a")`, `.f32be("a")`, `.f64le("a")`                                                          |
| `.endianess("little").uint16("a")`                                           | `.u16le("a")` (no default byte order)                                                                            |
| `.bit3("a").bit5("b")`                                                       | `.field("a", bits(3)).field("b", bits(5))`; numbers after bit fields start at the next byte, as before           |
| `.endianess("little").bit3("a").bit2("b")`                                   | `.field("b", bits(2)).field("a", bits(3))`: the fields of each run in reverse order (the padding stays last)     |
| Bit fields of nested parsers sharing bytes with the parent's                 | One run of bit fields, and `map` to the nested object (nested parsers start at a byte)                           |
| `.string("s", { length: 4 })`                                                | `.field("s", string(4))`; encoding needs text of 4 bytes, unless it has a terminator or padding                  |
| `.string("s", { length: 4, stripNull: true })`                               | `string(4, { padRight: 0 })` (trailing zeros are removed)                                                        |
| `.string("s", { zeroTerminated: true })`                                     | `string({ terminator: 0 })`; a missing terminator fails                                                          |
| `.string("s", { zeroTerminated: true, length: 8 })` (or a field or function) | `string({ terminator: 0, max: 8 })` (`string(8, { terminator: 0 })` takes all 8 bytes)                           |
| `.string("s", { length: "n" })`, `{ encoding: "latin1" }`                    | `string("n")`, `string(n, { encoding: "latin1" })`; zero terminators of `utf16le` strings are 16-bit units       |
| `{ encoding: "hex" }`, `"base64"`                                            | `map(bytes(length), …)` (text encodings: utf8, latin1, ascii, utf16le)                                           |
| `.buffer("b", { length: "n" })`, `{ readUntil: "eof" }`                      | `bytes("n")`, `bytes(Infinity)` (`Uint8Array`s, viewing the input)                                               |
| `.buffer("b", { length: 4, clone: true })`                                   | `map(bytes(4), { decode: (b) => new Uint8Array(b), encode: (b) => b })`                                          |
| `.array("a", { type, length: "n" })`                                         | `array(type, "n")`, or `array(type, u8)` (the count is not a field, and is written from the array)               |
| `.array("a", { type, readUntil: "eof" })`, `{ readUntil: (item) => … }`      | `array(type, Infinity)`, `array(type, { until: (item) => … })` (the last item is included)                       |
| `.array("a", { type, length, readUntil })`                                   | A `custom` codec (an array up to an item, or of a length, whichever comes first)                                 |
| `.array("a", { type, length, key: "id" })`                                   | `map(array(type, length), …)` to an object                                                                       |
| `.nest("a", { type: Parser })`, `{ flatten: true }`                          | `.field("a", Parser)`, `.merge(Parser)`                                                                          |
| `.fixedSizeNest("a", { type, length })`                                      | `.field("a", sized(length, type))`                                                                               |
| `.choice("a", { tag: "t", choices, defaultChoice })`                         | `.field("a", match("t").case(1, A).case(2, B).otherwise(D))`: the objects become a union discriminated by `t`    |
| `.choice("a", { tag: (o) => …, choices })`                                   | `.field("a", match((o: …) => …).case(…))`                                                                        |
| `.choice("a", { …, flatten: true })`                                         | `.merge(match("t").case(1, A)…)`, of parsers                                                                     |
| `{ formatter, deformatter }`                                                 | `map(codec, { decode, encode })`, or only `decode`; functions of the whole object map the parser                 |
| `{ assert: 1 }`, `{ assert: (v) => … }`                                      | `literal(codec, 1)` (which may be omitted when encoding), `refine(codec, (v) => …)` (also checked when encoding) |
| `.create(Class)`                                                             | `map(parser, { decode: (o) => Object.assign(new Class(), o), encode: … })`                                       |
| `parser.parse(buffer)`                                                       | `parser.decode(bytes)`; truncated input throws a `DecodeError`                                                   |
| `parser.serialize(value)`, `parser.serialize(value, buffer)`                 | `parser.encode(value)`, `parser.encodeInto(value, bytes)` (which returns the offset after the value)             |
| `parser.sizeOf()`, `parser.sizeOf(value)`                                    | `parser.size` (fixed size, otherwise NaN), `parser.sizeOf(value)`                                                |
| `parser.stream()` (a `Transform`)                                            | `decodeStream(parser, source)` (an async iterator); `Readable.from` it for a Node.js stream                      |
| Type objects with `readFunc`, `writeFunc`, `sizeFunc`                        | `custom({ decode, encode, size })`                                                                               |
| `compile()`, `getCode()`                                                     | Not needed: codecs compile themselves                                                                            |
| Functions of the parent object (`function () { return this.n }`)             | Functions of the earlier fields: `(o) => o.n`                                                                    |

### Additions

- Types: the decoded and encoded values are inferred (`Output<typeof parser>`, `Input<typeof parser>`); lengths, tags and functions are checked against the fields before them, and editors complete the names of fields.
- `parser.pick(...fields)` decodes some fields and steps over the others; `Reader` decodes consecutive values.
- `codec.sizeOf(value)` computes the size of a value without encoding it (`custom` codecs are encoded, unless they have a `size`).
- `trace(codec, bytes)` returns where each field of a value is, with its value.
- `.skip(n)` steps over reserved bytes (0.0.0 did not support `.skip`), and `.align(n)` over those up to a multiple of `n` bytes from the start of the parser.
- Computed fields (`.computed`) and literals may be omitted when encoding; counts read before a value are written from it (also the size of a region, after it).
- Parsers can read fields of the parser they are added to: `bin<{ length: number }>()`.
- `optional(flag, codec)` and `when(condition, codec)` for values that may be absent; `lazy` for recursive formats; `custom` for formats of your own; `fail` for unsupported parts.
- Strings: padding, terminators of any byte, and lengths of any kind.
- 24-bit integers, 64-bit integers as `bigint`, and bit fields of up to 53 bits (#12).
- Errors give the path of the field (e.g. `items[3].name`) and the offset.
- Streams decode values spanning chunks without starting over at each chunk, work with any async iterable, such as Node.js and web streams, and close their source when stopped.
- binopsy works in browsers: it uses `Uint8Array`s and `DataView`s instead of `Buffer`s.

### More to know when migrating

- The bit layout of `.endianess("little")` is not the `lsb` order: reverse the fields of each run of bit fields, and keep the padding last.
- Terminators of `utf16le` strings are 16-bit units (0.0.0 looked for a zero byte).
- Arrays mapped to objects by a key must decide what duplicate keys and the order of keys become.
- Assertions on other fields of the object (`this` in 0.0.0) become a `refine` of the whole parser.
- State set by the constructor of `.create(Class)` needs a `map` or a `custom` codec.

### Behaviour to know

- `codec.size` is `NaN` when values vary in size, or (for `lazy`) when it is not known yet.
- Functions given to codecs must have no side effects: a value may be decoded more than once (a stream decodes again a value that did not fit in its chunk, and calls `custom` decoders again with more bytes).
- Streamed values must take at least one byte; errors of the source are passed on as they are.
- Definitions reject unknown options, invalid lengths, duplicate field names and `__proto__`.
- Absent values (`optional`, `when`) are `null`, never `undefined`.
- Literals keep their default through `sized` and `lazy`; inputs of `map` and `custom` codecs are required, even if they accept `undefined`.
