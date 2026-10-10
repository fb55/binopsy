# `binopsy`

Reimplementation of [keichi/binary-parser](https://github.com/keichi/binary-parser), supporting both streams and serialization.

The API is mainly the same as `binary-parser`'s, with a couple of additions and one removed method.

binopsy is written in TypeScript and ships its type declarations. Requires Node.js 22.18 or newer.

```ts
import { Bin } from "binopsy";

const Header = Bin.start()
  .uint8("version")
  .uint32le("count")
  .array("items", { type: "uint16le", length: "count" })
  .string("name", { zeroTerminated: true });

const header = Header.parse(buffer);
// header: { version: number; count: number; items: number[]; name: string }
```

## Typed parsers

Each field method returns a parser whose result type includes the new field, so `.parse()` results are fully typed.
Types of nested parsers, arrays, choices and formatted values (via `formatter`) are inferred as well.
`Parser` is exported as an alias of `Bin`.

## `.parseFrom`

`.parseFrom(buffer, offset = 0)` parses starting at `offset` and returns `{ result, offset }`, where `offset` is the position after the parsed data.
It throws a `RangeError` if the input ends before the parser is done.

## 64-bit integers

`uint64le`, `uint64be`, `int64le` and `int64be` (and `uint64`/`int64`, following `.endianess()`) read and write `bigint`s.

## `Bin.lazy`

`Bin.lazy(() => parser)` refers to a parser that is defined later, for recursive structures:

```ts
const Tree: Bin<{ count: number; children: unknown[] }> = Bin.start()
  .uint8("count")
  .array("children", { type: Bin.lazy(() => Tree), length: "count" });
```

## Dropped support for `.skip`

Due to undefined behavior, `.skip` is not supported.
As a workaround the `.buffer` method can be used.

## `.stream`

The `.stream` method returns a transform stream that reads incoming data and emits parser results.
The parser instance is looped until the end of the input is reached.

## `.serialize`

As a counterpart to `binary-parser`'s `.parse` method, `.serialize` takes an object and returns a buffer representation of it.
Optionally, an already allowcated buffer can be passed as a second argument.

## `.fixedSizeNest`

`.fixedSizeNest` is a variation of `nest` that ensures the nested parser reads a specific amount of bytes.
Fixed-size nested parsers are the only source of ambiguity remaining while serializing, as missing bytes are simply skipped.
And error is thrown during serialization if the nested parser attempts to write more bytes than the size permits.

## `formatter`s require a `deformatter`

Properties with a specified formatting function need to also provide a `deformatter` function that restores the original value.

## `flatten` option

As a very simple extension, the `flatten` option allows nested parsers to write to the current object.
Its motivation is the aim for a flat output structure after `.choice` calls.

## Bitfields can be (almost) infinitely long

A relaxation from the 32 bit limit of `binary-parser`.
Also, a bug of the original project that leads to the `bit32` method always parsing [a value of `0`](https://github.com/keichi/binary-parser/issues/35) is not present.

## Development

```sh
npm install       # also builds lib/ (prepare)
npm test          # mocha, runs the TypeScript tests directly
npm run lint      # eslint + tsc
npm run build     # compiles src/ to lib/
```

__License: MIT__
