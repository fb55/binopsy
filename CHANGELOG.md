# Changelog

## Unreleased

binopsy is rewritten in TypeScript, around codecs: values that decode and encode, compiled to specialized JavaScript functions.
Parsers are defined as before, field by field, but each method returns a new parser, and every parser is a codec.
Changes are relative to the last published version, 0.0.0, whose API followed binary-parser's; all of it changed.
Formats keep their bytes with the rewrites below (except where noted), but not the quirks of 0.0.0 (such as returning partial values for truncated input).

### Migration

| 0.0.0                                                                        | Now                                                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `const Bin = require("binopsy")`, `new Bin()`, `Bin.start()`                 | `import { bin } from "binopsy"`, `bin()` (ES module only)                                                           |
| Field methods change the parser                                              | Field methods return a new parser                                                                                   |
| `.uint8("a")`, `.int16le("a")`, `.floatbe("a")`, `.doublele("a")`            | `.u8("a")`, `.i16le("a")`, `.f32be("a")`, `.f64le("a")`                                                             |
| `.endianess("little").uint16("a")`                                           | `.u16le("a")` (no default byte order)                                                                               |
| `.bit3("a").bit5("b")`                                                       | `.bits("a", 3).bits("b", 5)`; numbers after bit fields start at the next byte, as before                            |
| `.endianess("little").bit3("a").bit2("b")`                                   | `.bits("b", 2).bits("a", 3)`: the fields of each run in reverse order (the padding stays last)                      |
| Bit fields of nested parsers sharing bytes with the parent's                 | One run of bit fields, and `map` to the nested object (nested parsers start at a byte)                              |
| `.string("s", { length: 4 })`                                                | `.field("s", string(4))`; encoding needs text of 4 bytes, unless it has a terminator or padding                     |
| `.string("s", { length: 4, stripNull: true })`                               | `string(4, { padRight: 0 })` (trailing zeros are removed)                                                           |
| `.string("s", { zeroTerminated: true })`                                     | `string({ terminator: 0 })`; a missing terminator fails                                                             |
| `.string("s", { zeroTerminated: true, length: 8 })` (or a field or function) | `string({ terminator: 0, max: 8 })` (`string(8, { terminator: 0 })` takes all 8 bytes)                              |
| `.string("s", { length: "n" })`, `{ encoding: "latin1" }`                    | `string("n")`, `string(n, { encoding: "latin1" })`; zero terminators of `utf16le` strings are 16-bit units          |
| `{ encoding: "hex" }`, `"base64"`                                            | `map(bytes(length), …)` (text encodings: utf8, latin1, ascii, utf16le)                                              |
| `.buffer("b", { length: "n" })`, `{ readUntil: "eof" }`                      | `bytes("n")`, `bytes(Infinity)` (`Uint8Array`s, viewing the input)                                                  |
| `.buffer("b", { length: 4, clone: true })`                                   | `map(bytes(4), { decode: (b) => b.slice(), encode: (b) => b })`                                                     |
| `.array("a", { type, length: "n" })`                                         | `array(type, "n")`, or `array(type, u8)` (the count is not a field, and is written from the array)                  |
| `.array("a", { type, readUntil: "eof" })`, `{ readUntil: (item) => … }`      | `array(type, Infinity)`, `array(type, { until: (item) => … })` (the last item is included)                          |
| `.array("a", { type, length, readUntil })`                                   | A `custom` codec (an array up to an item, or of a length, whichever comes first)                                    |
| `.array("a", { type, length, key: "id" })`                                   | `map(array(type, length), …)` to an object                                                                          |
| `.nest("a", { type: Parser })`, `{ flatten: true }`                          | `.field("a", Parser)`, `.merge(Parser)`                                                                             |
| `.fixedSizeNest("a", { type, length })`                                      | `.field("a", sized(length, type))`                                                                                  |
| `.choice("a", { tag: "t", choices, defaultChoice })`                         | `.field("a", match("t").case(1, A).case(2, B).otherwise(D))`: the objects become a union discriminated by `t`       |
| `.choice("a", { tag: (o) => …, choices })`                                   | `.field("a", match((o: …) => …).case(…))`                                                                           |
| `.choice("a", { …, flatten: true })`                                         | `.merge(match("t").case(1, A)…)`, of parsers                                                                        |
| `{ formatter, deformatter }`                                                 | `map(codec, { decode, encode })`, or only `decode`; functions of the whole object map the parser                    |
| `{ assert: 1 }`, `{ assert: (v) => … }`                                      | `literal(codec, 1)` (which may be omitted when encoding), `refine(codec, (v) => …)` (also checked when encoding)    |
| `.create(Class)`                                                             | `map(parser, { decode: (o) => Object.assign(new Class(), o), encode: … })`                                          |
| `parser.parse(buffer)`                                                       | `parser.decode(bytes)`; truncated input throws a `DecodeError`                                                      |
| `parser.serialize(value)`, `parser.serialize(value, buffer)`                 | `parser.encode(value)`, `parser.encodeInto(value, bytes)` (which returns the offset after the value)                |
| `parser.sizeOf()`, `parser.sizeOf(value)`                                    | `parser.size` (fixed size, otherwise NaN), `parser.encode(value).length` (allocates and encodes; not a sizing pass) |
| `parser.stream()` (a `Transform`)                                            | `decodeStream(parser, source)` (an async iterator); `Readable.from` it for a Node.js stream                         |
| Type objects with `readFunc`, `writeFunc`, `sizeFunc`                        | `custom({ decode, encode, size })`                                                                                  |
| `compile()`, `getCode()`                                                     | Not needed: codecs compile themselves                                                                               |
| Functions of the parent object (`function () { return this.n }`)             | Functions of the earlier fields: `(o) => o.n`                                                                       |

### Additions

- Types: the decoded and encoded values are inferred (`Output<typeof parser>`, `Input<typeof parser>`); lengths, tags and functions are checked against the fields before them, and editors complete the names of fields.
- `parser.pick(...fields)` decodes some fields and steps over the others; `Reader` decodes consecutive values.
- Computed fields (`.computed`) and literals may be omitted when encoding; counts read before a value are written from it (also the size of a region, after it).
- Parsers can read fields of the parser they are added to: `bin<{ length: number }>()`.
- `optional(flag, codec)` and `when(condition, codec)` for values that may be absent; `lazy` for recursive formats; `custom` for formats of your own; `fail` for unsupported parts.
- Strings: padding, terminators of any byte, and lengths of any kind.
- 64-bit integers, as `bigint`; bit fields of up to 53 bits (#12).
- Errors give the path of the field (e.g. `items[3].name`) and the offset.
- Streams decode values spanning chunks without starting over, work with any async iterable, such as Node.js and web streams, and close their source when stopped.
- binopsy works in browsers: it uses `Uint8Array`s and `DataView`s instead of `Buffer`s.

`size` can also be unknown before lazy compilation. The former little-endian bit layout is not the new `lsb` layout: use the reversal migration above, with padding last. Audit old UTF-16LE terminated strings: 0.0.0 scanned zero bytes, while the new scanner recognizes complete code units. Mapping keyed arrays must account for duplicate keys and property order. Parent-dependent assertions should refine the whole raw record, and constructor-created parser state needs an explicit map or custom rewrite.

Callbacks must be pure. Complete-record decoding may be retried with resumable decoding, and custom callbacks can restart with each larger view. Stream records must consume bytes; source errors retain identity. Definitions reject unknown options, invalid bounds, duplicate reachable fields and `__proto__`. Null alone denotes absence. Literal defaults survive sized/lazy wrappers; map/custom inputs accepting undefined remain required keys.
