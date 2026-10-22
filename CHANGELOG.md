# Changelog

## Unreleased

binopsy is rewritten in TypeScript, with typed parse results, a compiled parser and new parsing methods.
Changes are relative to the last JavaScript version (`master`).

### Breaking changes

- **ES module only, Node.js ≥ 22.18.** `require("binopsy")` returned the parser class; now there are named exports.
  Migration: `import { Bin } from "binopsy"` (or `Parser`). In CommonJS on a Node.js version with `require(esm)`: `const { Bin } = require("binopsy")`.
- **`endianess()` is renamed `endianness()`** (as in binary-parser 2). Migration: rename the call.
- **`compile()`, `getCode()` and the static `Bin.Parser` are removed.** Parsers compile themselves. Migration: drop `compile()` calls; use the `Parser` export instead of `Bin.Parser`.
- **Internals are private**: `parser`, `serializer`, `endian`, `bitRequests`, `_flushBitfield()`, `readFunc`, `writeFunc`, `sizeFunc`, `constructorFn`, `fixedSize`. Migration: use `parse`, `parseFrom`, `serialize`, `sizeOf` and `stream`.
- **Truncated input is an error.** `parse()` throws a `RangeError` instead of returning `{}` or a partly filled object, and a zero-terminated string must end with a zero byte. Streams emit an error when the input ends in the middle of a value, instead of dropping it or emitting a partial value, and no longer emit an extra (empty) value at the end.
  Migration: catch the `RangeError`; for data that ends early by design, read the rest with `buffer(name, { readUntil: "eof" })` or `length: Infinity`.
- **Arrays need `length` or `readUntil`.** Without either, they used to read to the end of the input. Migration: add `readUntil: "eof"`.
- **An array ending at a `readUntil` function must find its last item.** Input that ends before is an error. Migration: as for truncated input.
- **Serializing checks lengths.** Arrays and buffers must have the length their `length` gives, an array with a `readUntil` function must end with its first item passing it, a string may not be longer than its `length`, and a zero-terminated string may not contain a zero byte; these were written as given, producing bytes that do not parse back. Migration: keep length fields in sync with the values.
- **Lengths from fields or functions must be non-negative integers**; others are an error (a negative length used to move the offset back). Numeric lengths are checked when the field is defined.
- **The bit fields of a nested parser no longer join the parent's run of bit fields**, so a parser has the same layout wherever it is nested (the joining depended on whether the nested parser had been used before, and skipped its formatter). Migration: define bit fields that share bytes in one parser, e.g. `.bit1("a").bit2("b")` instead of `.bit1("a").nest("x", { type: Bin.start().bit2("b") })`, and regroup them with a formatter if needed.
- **Keyed arrays (`key`) with two items of the same key are an error** instead of losing one of them.
- **Falsy asserts (`assert: 0`, `""`) are checked**; they used to be ignored. Migration: remove asserts that never held.
- **A `type` must be a parser or a primitive name.** Custom type objects (with `readFunc`, `writeFunc` and `sizeFunc`) are no longer accepted. Migration: a parser, with a `formatter` and `deformatter` if the value needs converting.
- **Parsers that create class instances (`create`) can only be flattened through a formatter**, as flattening copies their fields but not their methods. Migration: add a `formatter` that returns the fields to copy (and a `deformatter`).
- **`serialize(value, buffer)` returns the bytes written** (the start of `buffer`) instead of the whole `buffer`, and throws a `RangeError` if `buffer` is too small. Migration: use the returned buffer, or its `length`.
- **Errors during streaming are `error` events**, instead of exceptions thrown from `write()`.
- **Constructors given to `create()` are called without arguments**; they used to get the parent object (undocumented). Migration: set references to parents after parsing.

### Additions

- TypeScript types: the type of parsed values is inferred from the fields (`ValueOf<typeof parser>`), and options are checked (e.g. lengths and tags must name earlier fields, a formatter needs a deformatter).
- `parseFrom(buffer, offset, { fields })` parses at an offset and returns the end offset; with `fields`, it decodes only the named fields (`fields: []` finds the end of a value).
- 64-bit integers (`uint64le`, `int64be`, … and `uint64`/`int64`) as `bigint`.
- `Bin.lazy(() => parser)` for recursive types.
- Parsers are compiled to JavaScript functions: parsing is about ten times faster, also for streams.
- `assert` accepts any primitive value (e.g. a `bigint` or, after a formatter, a boolean).
- Length and tag functions also get the object as their argument (besides `this`), so arrow functions work.
- `fixedSizeNest` accepts `flatten: true`.

### Fixes

- Using a parser (e.g. `sizeOf()` or nesting it) between two of its bit fields no longer splits their run.
- A run of bit fields keeps the byte order in force when it is defined; `.endianness()` used to also change bit fields defined before it. With little endian, the fields of a run are stored in order, so formatters and asserts can read earlier fields of the run.
- Streams respect backpressure: values are parsed as the reader takes them, not all values of a chunk at once.
- Fixed-length strings shorter than their length are padded with zeros when serialized; they used to shift the following fields.
- `bit32` fields (and other fields of runs longer than 31 bits) are unsigned in streams too, and runs longer than 53 bits are exact.
- Bit fields with a formatter are deformatted when serialized.
- Keyed arrays whose key is a number can be serialized.
- A `nest` after bit fields no longer moves before them.
- Zero-length arrays, long arrays, long strings and many values in one chunk no longer fail (empty results or stack overflows).
- Empty zero-terminated strings, and zero-terminated strings with multi-byte characters, are parsed and serialized correctly.
- `sizeOf()` reports zero-terminated strings with a maximum length and arrays with `readUntil` as variable (`NaN`).
- A tag value such as `"constructor"` no longer matches properties inherited by the `choices` object.
- Streams of a parser that reads no bytes emit an error instead of hanging.
- A fixed-size nested value is padded with zeros when serialized into a given buffer.
