# `binopsy`

Typed binary codecs: declare a format once, then decode, encode and stream it.
Codecs compile to specialized JavaScript functions with direct numeric loads and stores, constant offsets, and specialized branches.

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

const player = Player.decode(bytes);
// { id: number; name: string; count: number; ratings: number[] }

Player.encode(player); // The bytes again
```

Types are inferred: no annotations are needed, and mistakes (a misspelled field, a length that is not a number, a case for a value the tag never has) are type errors where they are written.

## Parsers

`bin()` is an empty parser; each method returns a new parser with a field added, typed from the fields before it.

- `.u8(name)`, `.i16le(name)`, … add a number field (one method for each number codec below).
- `.bits(name, width)` adds a field of 1 to 32 bits (see [bit fields](#bit-fields)).
- `.field(name, codec)` adds a field of any codec, including other parsers and [matches](#matches).
- `.merge(parser)` adds the fields of another parser (or of one of several: `cond ? A : B` gives a union), or of the case of a [match](#matches) of parsers.
- `.pipe(f)` applies a function adding fields, for groups of fields used in several parsers.
- `.computed(name, f)` computes a field when encoding (see [encoding](#encoding)); it ends the parser.
- `.pick(...names)` is a decoder of only some fields (see [decoding](#decoding)).

Every parser is itself a codec, so parsers nest: `.field("club", Ref)`. Field names are unique: adding one twice throws (only the cases of one match may have fields of the same names). Duplicate field names are checked at definition time, not by TypeScript: a schema can type-check and still throw while it is built. This includes repeated names in separate matches on the same tag, even when the branches are mutually exclusive.

### Codecs

| Codec                                             | Values                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `u8`, `i8`, `u16le`, `i32be`, `f32le`, `f64be`, … | Integers of 8, 16 and 32 bits and floats, little (`le`) or big (`be`) endian                                            |
| `u64le`, `i64be`, …                               | 64-bit integers, as `bigint`                                                                                            |
| `bytes(length)`                                   | `Uint8Array`s, viewing the input (`slice()` them to copy them)                                                          |
| `string(length, options?)`                        | Strings stored in `length` bytes (see [strings](#strings))                                                              |
| `string({ terminator, max? })`                    | Strings ending with a terminator, of at most `max` bytes                                                                |
| `array(item, length)`                             | Arrays of `length` items                                                                                                |
| `array(item, { until })`                          | Arrays up to the first item for which `until(item)` is true (included)                                                  |
| `sized(length, codec)`                            | A value in a region of `length` bytes: it may not read past them, and they are padded with zeros                        |
| `literal(codec, value)`                           | A fixed value (a number, string, bigint or boolean), checked when decoding and written when encoding                    |
| `refine(codec, test, message?)`                   | Values passing `test`, when decoding and encoding (a type guard narrows their type)                                     |
| `map(codec, { decode, encode })`                  | Values converted both ways (e.g. a date from its parts); without `encode`, only when decoding                           |
| `optional(flag, codec)`                           | `null`, or a value after a non-zero `flag` (e.g. `u8`; encoding writes 0 or 1)                                          |
| `when(condition, codec)`                          | `null`, or a value if `condition` holds: an earlier field is truthy, or a function of the earlier fields returns `true` |
| `match(tag).case(value, codec)…`                  | One of several codecs, picked by a tag (see [matches](#matches))                                                        |
| `lazy(() => codec)`                               | A codec defined later, for formats that contain themselves                                                              |
| `custom({ decode, encode })`                      | A codec of functions of your own (see [custom codecs](#custom-codecs))                                                  |
| `fail(message)`                                   | Nothing: decoding and encoding fail (e.g. for parts that are not supported)                                             |

A `length` is

- a number; `Infinity` means up to the end of the input (or of the enclosing `sized` region),
- a codec of the count read before the value (`string(u32le)`: a 32-bit length, then the bytes; `sized(u32le, Chunk)`: a size, then a chunk),
- the name of an earlier number field (`bytes("size")`),
- or a function of the earlier fields (`bytes((o) => o.size * 2)`).

When encoding, counts read before a value are written from the value (a size before a region, after it); fields named as lengths, and functions, must match it. Counts must be nonnegative safe integers. Only a directly supplied `Infinity` means the enclosing boundary; a field or callback returning Infinity is invalid. A region prefix must have a known fixed size; fixed mapped and refined numeric codecs work too. The child is encoded once, then the prefix is backpatched.

Until arrays require a nonempty encoding input whose last item, and no earlier item, satisfies the predicate. Decoding fails if input ends before that item or an unbounded item consumes no bytes. Finite counted arrays may contain zero-byte items.

### Strings

```ts
string(16); // Exactly 16 bytes of text
string(16, { terminator: 0 }); // 16 bytes, the text ending with a zero (C's char[16])
string(16, { padRight: 0x20 }); // 16 bytes, the text padded with spaces
string(u8); // A length byte, then the text
string({ terminator: 0 }); // The text, then a zero
string({ terminator: 0, max: 16 }); // The same, of at most 16 bytes (a string of 16 bytes has no zero)
```

A fixed, named or callback string length reserves the whole storage region. Without options, encoding must fill it exactly. A terminator or padding allows shorter text. Decoding stops at the terminator, or trims trailing padding when no terminator is configured. Embedded encoded terminators are rejected, as are trailing pad units with padding alone; with both options, a terminator distinguishes trailing text from padding. Exactly full text needs no terminator.

A prefix counts the actual text bytes plus any terminator; it provides no padding budget. `string(Infinity, options)` uses the enclosing remainder. The terminated-options form consumes only through its terminator or `max`, including terminator bytes in the cap; EOF before either is truncation. `max` may be zero, an earlier numeric field, or a callback, but cannot be a prefix codec.

The encodings are `"utf8"` (the default), `"latin1"`, `"ascii"` and `"utf16le"`: `string(8, { encoding: "utf16le", terminator: 0 })`. Lengths are in bytes; terminators and padding are bytes, or 16-bit units in UTF-16. UTF-16LE bounds must be even; its raw code units preserve BOMs and isolated surrogates. UTF-8 preserves BOMs and replaces malformed text. Latin1 maps byte values directly; ASCII decoding masks the high bit. Latin1 and ASCII encoders reject characters outside their domains. These rules also apply without Node's Buffer.

For other representations of bytes, such as hex, use `map(bytes(length), …)`.

### Matches

`match(tag)` picks a codec by the value of the earlier field `tag`, with a case for each value (and `otherwise` for the others; without it, they fail). Added to a parser, it makes the parsed type a discriminated union:

```ts
const Value = bin()
  .u8("type")
  .field(
    "value",
    match("type")
      .case(1, i32le)
      .case(2, string(u32le))
      .case(3, bin().i16le("x").i16le("y")),
  );
// | { type: 1; value: number }
// | { type: 2; value: string }
// | { type: 3; value: { x: number; y: number } }
```

Cases of parsers can also be merged, which adds their fields:

```ts
const Shape = bin()
  .u8("kind")
  .merge(
    match("kind")
      .case(1, bin().f32le("radius"))
      .case(2, bin().f32le("width").f32le("height")),
  );
// { kind: 1; radius: number } | { kind: 2; width: number; height: number }
```

Case values are literals (numbers, strings, bigints or booleans: `1` and `"1"` are different), each with one case. A match is a codec of its own, which can be defined once and used in several parsers. The tag may also be computed from the earlier fields, with their type annotated (a match is defined before the parser it is in): `match((o: { kind: number }) => o.kind & 0xf)`.

### Bit fields

`bin().bits("a", 3).bits("b", 5)` decodes `{ a: number; b: number }` from one byte. Bit fields that follow each other share their bytes (they are padded to whole bytes, with zeros when encoding); other fields start at the next byte. By default the first field takes the most significant bits of the first byte; with `bin({ bitOrder: "lsb" })`, the least significant ones.

The bit fields of a merged parser continue the run (if they have the same bit order: adjoining runs of different orders throw); those of nested parsers, of merged matches, and of merged parsers that compute or pick fields start at a byte.

### Fields around a parser

Lengths, tags and functions see the fields before them. A parser added to another may also read fields of that one, which it declares, so that it is checked where it is added:

```ts
const Header = bin().u8("kind").u16le("length");
const Raw = bin<{ length: number }>().field("body", bytes("length"));
const Message = Header.merge(Raw);
```

Functions get the decoded fields, or, when encoding, the values being encoded (so a field mapped from another representation has the type of both). Codecs defined outside a parser, such as match cases, do not know the parser's fields: functions in them need their argument annotated, e.g. with the parser's types, `(o: Output<typeof Header>) => …`.

Callbacks must be pure. They see the logical earlier-field prefix in both directions, with literal and computed defaults resolved when encoding. They do not see later encode fields. Local fields shadow outer fields. `sized` and `lazy` retain literal defaults, while `map`, arrays, and presence wrappers do not. A map or custom codec accepting undefined still requires its input key. `optional` and `when` use null as the only absence marker; `when` rejects null when its condition is true.

### Recursion

```ts
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

### Custom codecs

For formats the other codecs cannot express, `custom` takes functions of your own: `decode` gets the bytes from the value on (and whether more may follow, in a stream), and returns the value and its size in bytes, or `undefined` for more bytes.

```ts
// Variable-length integers (LEB128) of up to 32 bits.
const varint = custom({
  decode(bytes, final) {
    let value = 0;
    for (let i = 0; i < bytes.length && i < 5; i++) {
      if (i === 4 && bytes[i] > 0x0f) throw new Error("varint exceeds u32");
      value += (bytes[i] & 0x7f) * 2 ** (7 * i);
      if (bytes[i] < 0x80) return { value, bytesRead: i + 1 };
    }
    if (!final && bytes.length < 5) return undefined;
    throw new Error("invalid varint");
  },
  encode(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw new Error("expected an unsigned 32-bit integer");
    const bytes = [];
    do {
      bytes.push((value % 128) | (value >= 128 ? 0x80 : 0));
      value = Math.floor(value / 128);
    } while (value);
    return Uint8Array.from(bytes);
  },
});
```

`decode` may be called again for a value (with more bytes), so it must have no side effects. With a `size`, it gets exactly that many bytes with `final=true`. Outer undefined requests more bytes; `{ value: undefined, bytesRead: n }` succeeds with an undefined value. Results must contain both members and consume a safe count within the supplied view (exactly `size` when declared). Custom DecodeError offsets are relative to that view and are rebased once by the adapter.

## Decoding

- `codec.decode(bytes, offset?)` decodes a value at `offset` (bytes after it are ignored).
- `new Reader(bytes, offset?)` reads consecutive values: `reader.read(codec)` returns a value and moves `reader.offset` past it (if it fails, the offset stays); `reader.done` tells whether all bytes were read.
- `parser.pick("a", "b")` decodes only these fields. The others are stepped over without decoding strings, building objects or running conversions, but their literals and refinements are still checked. Fields that later lengths or tags name are read too; before a function of the earlier fields, all of them are.

Failures throw a `DecodeError` with a `code` (`"end-of-input"`, `"invalid"`, `"no-match"`, or `"error"` for an exception in a function, which is its `cause`), the `path` of the field (e.g. `["items", 3, "name"]`, shown as `items[3].name`) and the `offset`.

## Encoding

`codec.encode(value)` returns the bytes. Small results are views of a buffer shared with other results (as Node.js does for small `Buffer`s), but never overwritten. `codec.encodeInto(value, bytes, offset?)` writes them to `bytes` instead, and returns the offset after them.

Returned bytes are backed by ArrayBuffer, including custom encodings copied from shared memory, and can be used with Blob, Response and Web Crypto. Decode views and encodeInto targets also accept shared memory. Offsets must be safe integers within the supplied view; encodeInto may partially modify its target on failure, and overlapping source/target storage is unsupported.

The type of encoded values, `Input<typeof codec>`, can differ from the decoded one, `Output<typeof codec>`: literals and computed fields may be omitted.

```ts
const Chunk = bin()
  .u32le("size")
  .field("data", bytes("size"))
  .computed("size", (chunk) => chunk.data.length);

Chunk.encode({ data }); // `size` is computed
```

Several fields are computed with an object of functions, `.computed({ size: …, count: … })`; each gets the original input with all computed keys absent. These callbacks run once before writing their group and cannot observe one another's results. Other omitted literal inputs remain omitted in this whole-input projection. Results must be defined. Supplied values must agree via `Object.is`, including object identity, NaN, and signed zero. Merged finalized groups retain their original computation scope; input objects are never changed.

Values are checked: numbers must fit, arrays and bytes must have their length, strings must fit theirs, and values of conditions must be `null` exactly when their condition does not hold. Failures throw an `EncodeError` with the `path` of the field.

## Streams

`decodeStream(codec, source)` decodes the values in the chunks of `source`, which may be any (async) iterable of `Uint8Array`s, such as a Node.js or web stream:

```ts
for await (const entry of decodeStream(
  Entry,
  createReadStream("archive.tar"),
)) {
  console.log(entry.name);
}
```

Values may span any number of chunks; a value that does is not decoded again from its start when more input arrives (but an initial attempt may repeat callbacks, and custom decoding may retry with each larger view). Values that read up to the end of the input end with the stream. If the input ends in the middle of a value, the iteration fails with a `DecodeError`. Stopping the iteration (or a failure) closes the source.

Concurrent next calls are serialized. Return marks the iterator closed immediately, suppresses values from a pending pull, and waits for it to settle before closing the source; it cannot interrupt a source pull that never settles. Source errors retain their identity. Each yielded record must consume bytes. Retained byte views stay stable during later iteration, provided producers do not mutate or reuse their chunks. Buffering may grow to the largest value, including the whole stream for an EOF-reading codec.

For a Node.js stream of the values, use `Readable.from(decodeStream(codec, source))`.

## Types

`Output<typeof codec>` is the type of decoded values, `Input<typeof codec>` that of encoded ones. `Codec<O, I>` is the type of codecs; `Bin<T, I>` that of parsers, and `Struct<T, I>` that of parsers adding no more fields (computing some, or picking some); `AnyBin` is any parser.

Groups of fields used in several parsers are functions of parsers:

```ts
const withValues = <T extends { count: number }, I extends { count: number }>(
  b: Bin<T, I>,
) =>
  b.field(
    "values",
    bytes((o) => o.count * 2),
  );

const Record = bin().u8("count").pipe(withValues);
```

Standalone decode, encode, Reader and stream operations require context `unknown`; reusable dependent groups attach to an enclosing parser first. `Context<C>` names a codec's requirement; `AnyCodec` and `AnyBin` are acceptance types for generic boundaries.

Generic numeric-name filtering sometimes needs a callback length (as above) or a dependent codec defined before the generic function. Validate individual option literals with `satisfies StringOptions` or `satisfies TerminatedStringOptions<Fields>` before combining them into unions: TypeScript may lose excess-property checks in overlapping option unions. Runtime definition checks remain authoritative.

See [examples/tar.ts](examples/tar.ts) for a tar archive reader and writer, and [CHANGELOG.md](CHANGELOG.md) for changes.

## Performance

`bench/parse.ts` measures full decoding, two-field selection, empty selection, streams and encoding on a database-like format with strings, nested parsers, arrays and a match. Use bounded, repeated runs on the target Node version and hardware; throughput depends on the schema and workload:

```sh
NODE_OPTIONS=--max-old-space-size=1536 timeout 120 node bench/parse.ts 100000
```

## Development

```sh
npm install
npm test          # mocha, runs the TypeScript tests directly
npm run lint      # eslint + tsc (including the type tests in test/types)
npm run build     # compiles src/ to lib/
node bench/parse.ts
```

**License: MIT**
