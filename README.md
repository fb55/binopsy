# `binopsy`

Declarative binary parsers that also serialize and stream, with typed results.
The API is modelled on [keichi/binary-parser](https://github.com/keichi/binary-parser) (see [differences](#differences-from-binary-parser)).

```sh
npm install binopsy
```

binopsy is an ES module with TypeScript types, for Node.js 22.18 or newer.

```ts
import { Bin } from "binopsy";

const Header = Bin.start()
  .uint8("version")
  .uint32le("count")
  .array("items", { type: "uint16le", length: "count" })
  .string("name", { zeroTerminated: true });

const header = Header.parse(buffer);
// { version: number; count: number; items: number[]; name: string }

Header.serialize(header); // The bytes again
```

## Defining parsers

`Bin.start()` (or `new Bin()`) creates an empty parser. Each field method adds a field and returns the parser, whose type grows with it.
Field methods change the parser they are called on, so start a new parser for each layout.

| Method                                          | Parses                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `uint8`, `int8`                                 | 8-bit integers                                                                                                             |
| `uint16le`, `int32be`, `floatle`, `doublebe`, … | Integers of 16 and 32 bits, floats and doubles; `le`/`be` is the byte order                                                |
| `uint64le`, `int64be`, …                        | 64-bit integers, as `bigint`                                                                                               |
| `uint16`, `int32`, `float`, …                   | The same, in the byte order set by `.endianness("little" \| "big")` (default: big endian)                                  |
| `bit1` … `bit32`                                | Unsigned bit fields, see [bit fields](#bit-fields)                                                                         |
| `string(name, options)`                         | A string; `length` or `zeroTerminated: true`, and optionally `encoding` (default `"utf8"`) and `stripNull`                 |
| `buffer(name, options)`                         | A `Buffer` referencing the input; `length` or `readUntil: "eof"`, and `clone: true` to copy it                             |
| `array(name, options)`                          | Values of `type`; `length`, or `readUntil` `"eof"` or a function of the last item that ends the array when it returns true |
| `nest(name, { type })`                          | A value of another parser (or a primitive)                                                                                 |
| `fixedSizeNest(name, { type, length })`         | Like `nest`, but the value takes exactly `length` bytes: it may not read further, and is followed by padding               |
| `choice(name, options)`                         | One of `choices` (an object of types by tag value), picked by `tag`; `defaultChoice` for other tag values                  |

`type` is a parser or the name of a primitive (`"uint8"`, `"int16le"`, …). A parser used as a `type` is copied as it is at that point: define it completely first (or use [`Bin.lazy`](#recursive-types-and-classes)).

A `length` (of a string or buffer in bytes, of an array in items) is a number, the name of a field parsed before, or a function of the object parsed so far (`(obj) => number`, also called with `this` set to it); it must be a non-negative integer.
For strings, buffers and arrays, `Infinity` means up to the end of the input, or of the enclosing `fixedSizeNest`.
For a zero-terminated string, `length` is the maximum length.
`tag` is likewise a field name or a function.

### Options of all fields

- `formatter(value)`: turns the parsed value into the stored one, and requires a `deformatter(value, obj)` that turns it back for serializing. A `deformatter` alone computes the value to serialize (e.g. a checksum); the field may then be omitted from the value, unless a length or tag refers to it (TypeScript still asks for it).
- `assert`: a value the field must equal (`===`), or a function that must return true; otherwise parsing fails. It checks the formatted value.
- `flatten: true` (`nest`, `fixedSizeNest`, `choice`): adds the fields of the nested (or formatted) value to the current object instead of storing it in a field. Objects of a class (`create`) are only flattened through a formatter, as their methods would be lost.
- `key` (`array`): stores the items in an object, keyed by this field of each item. Keys must be unique; items are serialized in the object's key order (integer keys ascending).

Formatters, asserts, and length and tag functions are called with `this` set to the object parsed so far (length and tag functions also get it as their argument); deformatters get it as their second argument.

```ts
const Packet = Bin.start()
  .uint8("magic", { assert: 0x42 })
  .uint8("type")
  .choice("body", {
    tag: "type",
    choices: { 1: Bin.start().uint32le("id"), 2: "uint16le" },
  })
  .array("ip", {
    type: "uint8",
    length: 4,
    formatter: (bytes) => bytes.join("."),
    deformatter: (ip) => ip.split(".").map(Number),
  });
// { magic: number; type: number; body: { id: number } | number; ip: string }
```

### Bit fields

Consecutive bit fields are read together from as many bytes as they need (runs may be longer than 32 bits), most significant bit first; the last byte is padded.
With little endian (`.endianness("little")`), the fields of a run are taken in reverse order: the first field takes the last bits. The byte order of a run is the one in force when its fields are defined.
The bit fields of a nested parser form their own run.

### Recursive types and classes

`Bin.lazy(() => parser)` refers to a parser that is defined later, so that a type can contain itself:

```ts
interface Tree {
  count: number;
  children: Tree[];
}
const Tree: Bin<Tree> = Bin.start()
  .uint8("count")
  .array("children", { type: Bin.lazy(() => Tree), length: "count" });
```

A lazy parser itself cannot be changed (no fields or `create`); change the parser its factory returns.

`.create(Class)` creates the parsed objects with `new Class()` instead of as plain objects. Parsed fields overwrite the class's properties; their types are intersected with the class's, so a formatter should not change the type of a property the class declares.

## Parsing

- `.parse(buffer)` parses a value from the start of `buffer`. Bytes after it are ignored.
- `.parseFrom(buffer, offset = 0)` parses a value at `offset` and returns `{ result, offset }`, where `offset` is the end of the value. This reads consecutive values from one buffer without copying.
- `.parseFrom(buffer, offset, { fields: ["name", …] })` decodes only these top-level fields and steps over the others without decoding them; fields that lengths or tags refer to (and fields with asserts) are decoded too. The fields of a flattened value count as top-level fields. With `fields: []`, it only finds the end of the value.
  A parser (or nested parser) that uses functions for lengths, tags, `readUntil` or asserts, or asserts on formatted values, is always decoded completely, as they may read any field. Formatters see only the decoded fields, so select the fields a formatter reads through `this`.

Parsers are compiled to JavaScript functions on first use.
If the input ends before the value, they throw a `RangeError`; failed asserts and unknown choices throw an `Error`.

## Serializing

- `.serialize(value)` returns the value's bytes. `.serialize(value, buffer)` writes them to the start of `buffer` instead and returns that part of it.
- `.sizeOf(value)` returns the size of the value's bytes; `.sizeOf()` the size of every value of the parser, or `NaN` if it varies.

Lengths must match the value: an array or buffer must have the number of items or bytes its length says, and a string may not be longer (shorter strings are padded with zero bytes).

## Streams

`.stream()` returns a `Transform` stream that parses the bytes written to it into a sequence of values.
Values may span any number of chunks. (A value that spans chunks is first tried as if it did not, so its formatters and asserts may run twice; they should have no side effects.)
When the input ends in the middle of a value, the stream emits an error; values that read up to the end of the input (`readUntil: "eof"`, `length: Infinity`) end with it.

## Types

The type of parsed values is inferred from the field definitions; `ValueOf<typeof parser>` names it.
The option types (`StringOptions`, `ArrayOptions`, `FormattedOptions`, …) are exported for helpers that build options.
`Parser` is exported as an alias of `Bin`.

## Differences from binary-parser

- binopsy serializes (`serialize`, `sizeOf`), parses streams (`stream`), and parses at offsets or only some fields (`parseFrom`).
- Formatters need a deformatter, so that values can be serialized.
- With little endian, a run of bit fields longer than a byte is not read as a little-endian integer: its bytes keep their order and the fields are taken from the end.
- `readUntil` functions get only the item (no read-ahead buffer). Strings up to the end of the input use `length: Infinity` (binary-parser: `greedy`).
- `skip`, `seek`, `pointer`, `saveOffset`, `wrapped` and `useContextVars` are not supported; read unused bytes with `buffer`.
- A nested parser is copied when it is used, so fields added to it later do not change the parsers it was used in.
- `flatten`, `fixedSizeNest`, `Bin.lazy` and keyed arrays are additions.

See [CHANGELOG.md](CHANGELOG.md) for changes, including breaking ones, and [examples/tar.ts](examples/tar.ts) for a tar archive reader and writer.

## Development

```sh
npm install
npm test          # mocha, runs the TypeScript tests directly
npm run lint      # eslint + tsc
npm run build     # compiles src/ to lib/
node bench/parse.ts
```

**License: MIT**
