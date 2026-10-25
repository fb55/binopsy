# Comparison with other binary codec libraries

Decoding and encoding throughput, and the cost of first use, of binopsy and eight other libraries on seven formats. Each library uses its own idiomatic API, and must decode the same bytes to the same values and encode them to the same bytes before it is timed.

Measured on 2026-10-25 with Node 26.9.0 on a Ryzen 7 5800X3D (Linux), each process pinned to one logical CPU, against binary-parser 2.3.0, binary-parser-encoder 1.5.3, restructure 3.0.2, typed-binary 4.3.4, micro-packed 0.11.1, @solana/codecs 8.5.0, @pretendonetwork/binary-parser 1.0.0 and @solana/buffer-layout 4.0.1. `manual` is a handwritten `DataView`/`Uint8Array` codec without validation.

## Results

Throughput is in MB/s (higher is better): the median of five fresh processes, each warmed up for at least 250 ms. First use is in milliseconds (lower is better): defining the format, compiling it, and the first decode or encode, in each of fifteen fresh processes (excluding the import). "—" means the library cannot express the format, or has no working encoder for it (see [differences](#api-and-semantic-differences)).

binopsy has the highest throughput in every scenario, for decoding and encoding: 1.5 to 12 times that of the next fastest library. Its first use usually takes longer, as it compiles each codec.

### header

| Library                        | Decode MB/s | Encode MB/s | First decode ms | First encode ms |
| ------------------------------ | ----------: | ----------: | --------------: | --------------: |
| manual                         |       178.5 |        48.7 |            0.23 |            0.11 |
| **binopsy**                    |       907.8 |       202.2 |            1.61 |            1.47 |
| binary-parser                  |        39.1 |           — |            0.63 |               — |
| binary-parser-encoder          |       196.6 |        60.8 |            0.57 |            0.81 |
| restructure                    |         9.6 |        15.4 |            0.44 |            0.47 |
| typed-binary                   |        21.4 |        16.7 |            0.40 |            0.40 |
| micro-packed                   |        41.6 |        20.2 |            0.69 |            0.73 |
| @solana/codecs                 |         5.3 |         7.8 |            1.12 |            1.08 |
| @pretendonetwork/binary-parser |        57.1 |        27.7 |            0.55 |            0.60 |
| @solana/buffer-layout          |        53.0 |        27.3 |            0.36 |            0.41 |

### record

| Library                        | Decode MB/s | Encode MB/s | First decode ms | First encode ms |
| ------------------------------ | ----------: | ----------: | --------------: | --------------: |
| manual                         |       280.2 |       187.8 |            0.28 |            0.13 |
| **binopsy**                    |       516.2 |       560.8 |            3.43 |            3.64 |
| binary-parser                  |       135.6 |           — |            1.58 |               — |
| binary-parser-encoder          |       240.7 |        57.9 |            1.40 |            1.93 |
| restructure                    |        10.3 |        12.1 |            0.93 |            1.30 |
| typed-binary                   |           — |           — |               — |               — |
| micro-packed                   |        40.5 |        29.4 |            1.80 |            1.68 |
| @solana/codecs                 |         3.0 |         4.8 |            2.88 |            2.64 |
| @pretendonetwork/binary-parser |           — |           — |               — |               — |
| @solana/buffer-layout          |           — |           — |               — |               — |

### union

| Library                        | Decode MB/s | Encode MB/s | First decode ms | First encode ms |
| ------------------------------ | ----------: | ----------: | --------------: | --------------: |
| manual                         |        74.7 |        30.6 |            0.23 |            0.11 |
| **binopsy**                    |       181.4 |       116.6 |            2.78 |            2.79 |
| binary-parser                  |        30.0 |           — |            1.08 |               — |
| binary-parser-encoder          |        76.1 |        42.8 |            1.00 |            1.21 |
| restructure                    |         6.2 |        12.7 |            0.56 |            0.64 |
| typed-binary                   |           — |           — |               — |               — |
| micro-packed                   |        31.3 |        15.6 |            0.84 |            0.89 |
| @solana/codecs                 |         5.2 |         7.8 |            1.78 |            1.78 |
| @pretendonetwork/binary-parser |           — |           — |               — |               — |
| @solana/buffer-layout          |           — |           — |               — |               — |

### bits

| Library                        | Decode MB/s | Encode MB/s | First decode ms | First encode ms |
| ------------------------------ | ----------: | ----------: | --------------: | --------------: |
| manual                         |        55.1 |        14.7 |            0.23 |            0.11 |
| **binopsy**                    |       265.7 |        63.5 |            1.72 |            1.66 |
| binary-parser                  |        12.3 |           — |            0.89 |               — |
| binary-parser-encoder          |        59.6 |        22.7 |            0.75 |            1.00 |
| restructure                    |           — |           — |               — |               — |
| typed-binary                   |           — |           — |               — |               — |
| micro-packed                   |        10.2 |         5.9 |            0.78 |            0.82 |
| @solana/codecs                 |           — |           — |               — |               — |
| @pretendonetwork/binary-parser |        25.2 |         9.9 |            0.57 |            0.63 |
| @solana/buffer-layout          |        18.2 |         7.2 |            0.56 |            0.64 |

### numeric

| Library                        | Decode MB/s | Encode MB/s | First decode ms | First encode ms |
| ------------------------------ | ----------: | ----------: | --------------: | --------------: |
| manual                         |      1529.0 |       449.0 |            0.52 |            0.23 |
| **binopsy**                    |      4163.2 |      1946.8 |            1.70 |            2.88 |
| binary-parser                  |       433.2 |           — |            2.92 |               — |
| binary-parser-encoder          |       430.4 |       170.9 |            1.95 |            5.92 |
| restructure                    |        87.1 |        42.7 |            1.09 |            3.14 |
| typed-binary                   |       381.2 |       385.3 |            3.30 |            3.55 |
| micro-packed                   |       374.5 |       287.9 |            2.96 |            6.27 |
| @solana/codecs                 |         7.3 |        10.9 |            6.94 |            3.84 |
| @pretendonetwork/binary-parser |       238.8 |       197.3 |            4.60 |            4.44 |
| @solana/buffer-layout          |        79.5 |        69.9 |            5.86 |            2.89 |

### text

| Library                        | Decode MB/s | Encode MB/s | First decode ms | First encode ms |
| ------------------------------ | ----------: | ----------: | --------------: | --------------: |
| manual                         |       383.9 |       329.1 |            0.26 |            0.12 |
| **binopsy**                    |       533.4 |       556.1 |            1.72 |            1.80 |
| binary-parser                  |       235.8 |           — |            0.73 |               — |
| binary-parser-encoder          |       316.0 |       365.7 |            0.66 |            0.88 |
| restructure                    |       149.6 |       107.9 |            0.53 |            0.64 |
| typed-binary                   |       212.9 |       112.5 |            0.39 |            0.43 |
| micro-packed                   |       232.8 |       147.1 |            0.83 |            0.72 |
| @solana/codecs                 |        94.4 |        46.5 |            1.11 |            1.12 |
| @pretendonetwork/binary-parser |           — |           — |               — |               — |
| @solana/buffer-layout          |       162.9 |       179.8 |            0.41 |            0.47 |

### points

| Library                        | Decode MB/s | Encode MB/s | First decode ms | First encode ms |
| ------------------------------ | ----------: | ----------: | --------------: | --------------: |
| manual                         |      1185.1 |       742.8 |            0.28 |            0.12 |
| **binopsy**                    |      1913.7 |      1418.1 |            1.92 |            1.86 |
| binary-parser                  |       723.6 |           — |            0.82 |               — |
| binary-parser-encoder          |      1212.3 |       117.6 |            0.73 |            1.27 |
| restructure                    |         7.9 |        20.6 |            0.79 |            1.01 |
| typed-binary                   |           — |           — |               — |               — |
| micro-packed                   |        63.9 |        70.8 |            1.23 |            1.27 |
| @solana/codecs                 |         5.0 |         8.6 |            1.93 |            1.63 |
| @pretendonetwork/binary-parser |        41.6 |           — |            1.13 |               — |
| @solana/buffer-layout          |        46.9 |        47.9 |            0.84 |            0.92 |

### Startup

Fresh processes, medians of fifteen, in milliseconds. Compiling is generating the JavaScript of the codec and constructing its function; the call includes V8 compiling that function lazily. `wide128` is a parser of 128 `u32le` fields.

| Scenario | Operation | Import | Definition | Compiling | First call | Total |
| -------- | --------- | -----: | ---------: | --------: | ---------: | ----: |
| header   | decode    |   2.54 |       0.48 |      1.04 |       0.04 |  4.09 |
| header   | encode    |   2.54 |       0.49 |      0.90 |       0.06 |  3.98 |
| record   | decode    |   2.54 |       1.24 |      2.12 |       0.18 |  6.07 |
| record   | encode    |   2.51 |       1.23 |      2.19 |       0.31 |  6.25 |
| union    | decode    |   2.54 |       0.98 |      1.74 |       0.07 |  5.28 |
| union    | encode    |   2.53 |       0.99 |      1.70 |       0.10 |  5.31 |
| bits     | decode    |   2.51 |       0.53 |      1.14 |       0.04 |  4.24 |
| bits     | encode    |   2.57 |       0.53 |      1.05 |       0.07 |  4.24 |
| numeric  | decode    |   2.45 |       0.48 |      1.02 |       0.70 |  4.65 |
| numeric  | encode    |   2.44 |       0.48 |      0.97 |       1.84 |  5.72 |
| text     | decode    |   2.55 |       0.58 |      1.02 |       0.15 |  4.34 |
| text     | encode    |   2.48 |       0.58 |      1.12 |       0.18 |  4.38 |
| points   | decode    |   2.99 |       0.54 |      1.27 |       0.08 |  5.01 |
| points   | encode    |   2.54 |       0.55 |      1.08 |       0.20 |  4.42 |
| wide128  | decode    |   2.55 |       1.73 |      2.06 |       0.31 |  6.59 |
| wide128  | encode    |   2.57 |       1.72 |      2.38 |       0.69 |  7.42 |

## Reproduce

This is a private, independently locked package. The library itself keeps zero
runtime dependencies. Node 26 can execute binopsy's TypeScript source directly.
Comparison runs load built JavaScript, as the installed competitors do.
Versions were resolved from npm's `latest` tags on 2026-10-24; `package-lock.json`
fixes the exact versions for reproduction.

```sh
NODE_OPTIONS=--max-old-space-size=1536 timeout 180s npm ci
NODE_OPTIONS=--max-old-space-size=1536 timeout 180s npm ci --prefix bench/compare
NODE_OPTIONS=--max-old-space-size=1536 timeout 60s npm run build
NODE_OPTIONS=--max-old-space-size=1536 timeout 3600s python3 bench/compare/run.py --cpu 6 --rounds 5 --output /tmp/comparison.json > /tmp/comparison.md
```

Choose an available CPU with `taskset -pc $$`. Each child has a 180-second timeout,
a 1536 MiB V8 heap limit, and affinity to that one logical CPU. The driver rotates
library/scenario/operation order and reverses it on alternating rounds. It writes
raw observations incrementally to JSON and a Markdown table at completion.
If interrupted, repeat the same command with `--resume` to keep completed cells.
The runner rejects changes to the machine, Node version, CPU, rounds or workload
selection, and records/checks `COUNT`, `RUNS`, `WARMUPS`, and `WARM_MS`.
Without `--output`, raw JSON goes to the gitignored `results/` directory.
`--libraries binopsy,binary-parser`, `--scenarios header,record`, and
`--operation encode` filter runs.
`--source /path/to/lib` selects a historical binopsy build without changing
any competitor version or benchmark scenario. A `src` directory is also accepted
for development, but release comparisons use JavaScript to avoid including Node
TypeScript-loader background work in first-call and short-run timings.
`COUNT`, `RUNS`, and `WARMUPS` override workload size and repetitions for smoke
checks; `WARM_MS` sets the minimum warm-up duration. The defaults are the
reported throughput benchmark. No batch exceeds 100,000 values.

## Scenarios

| Scenario | Wire format and data                                                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| header   | 16-byte little-endian packet header: u32 magic, u16 version, u16 flags, u32 payload length, u32 sequence                                                                                                          |
| record   | The exact `bench/parse.ts` schema and value generator: nested reference, 5 ratings, 69 attributes, two u32-counted UTF-8 strings, 0–6 item structs, optional 16-byte extra, u32-counted history, f64 and u32 tail |
| union    | Equally distributed u8 tags: sequence acknowledgement; two f32 coordinates and u16 ID; u32-counted UTF-8 event text                                                                                               |
| bits     | MSB-first 3/5/12/4-bit integer fields, followed by an unaligned u16le sequence                                                                                                                                    |
| numeric  | 4,096 u32le values, including values above 2^31; eagerly decoded into a JS number array                                                                                                                           |
| text     | Three NUL-terminated UTF-8 strings: short identifier, ASCII/multibyte message, and a 250-byte paragraph                                                                                                           |
| points   | u16le count followed by 50 structs of f32le x/y and u16le ID                                                                                                                                                      |

There are up to 1,024 distinct values per corpus (32 for numeric, bounded by
the batch count for small smoke/cold runs). Every iteration
cycles through the corpus. Default batches contain 98,304 small messages, 10,240
records/texts/point arrays, or 128 numeric arrays. Results are consumed through
a checksum. Decode and encode run in separate processes, with at least five warm-up
batches and at least 250 ms of warm-up, then nine timed batches. The table is the median of each process's median
throughput across five fresh processes; ranges show the process medians. MB/s
uses decimal megabytes, and ops/s counts whole messages/arrays.

**First use** is schema definition, any lazy compilation, and the first operation
in that fresh process, before verification or warm-up. Imports, Node startup,
reference data construction, and module-level primitive singleton construction
are excluded. Native input adaptation is included in this first operation.
Only one cold observation per process is taken. Small absolute times are noisy;
compare ranges and interleaved rounds before interpreting percentage changes.

The independent handwritten codec creates the reference bytes. Before timing,
each supported adapter must decode 21 small samples (from a Buffer with nonzero
byteOffset) to the canonical values and encode them to exactly those bytes.
This covers all union/optional variants, empty and nonempty counted arrays,
and Unicode. Numeric validation uses eight elements; throughput uses 4,096.
Only small values use deep equality; bytes are compared in a bounded loop.
Failure aborts the run. No correctness failure is converted into a speed result.

## API and semantic differences

- binopsy uses its ordinary `decode` and `encode` methods, retaining all range,
  length, bounds, and path-aware checks. Encoding allocates from its normal pool.
- binary-parser uses `parse`, compiles lazily, and does not encode.
  binary-parser-encoder uses `parse`/`encode` with Buffer inputs.
- restructure uses `fromBuffer`/`toBuffer` and native `VersionedStruct` tags.
- micro-packed uses `decode`/`encode` and native `tag`, `bits`, and array coders.
- @solana/codecs uses `decode`/`encode` and native struct, array, discriminated
  union, size-prefix, and sentinel codecs.
- typed-binary uses `read`/`write` with a fresh `BufferReader`/`BufferWriter`;
  fixed-size output uses `maxSize`. Variable text uses `measure(value).size`:
  version 4.3.4 incorrectly reports a zero `ObjectSchema.maxSize` for strings.
- Pretendo uses `parse`/`encode`. Its 1.0.0 encoder underallocates the counted
  points array (52 bytes instead of 502); that encode cell is explicitly skipped.
- buffer-layout uses `decode`/`encode`, allocating a correctly sized output
  because its public encode API writes into caller-owned storage.
- The handwritten DataView/Uint8Array reference omits validation and location
  errors. It uses TextEncoder/TextDecoder, eager JS arrays, and a fresh output
  buffer. It is a useful low-level comparison, **not a proven upper bound** on
  every possible handwritten implementation or on V8 optimisation.

All decoders receive equivalent Node Buffers; Buffer is a Uint8Array, but it can
select faster native string paths and changes `slice` from copying to viewing.
Numeric results are ordinary JS arrays, not lazy or zero-copy typed arrays.
Returned byte regions may be Buffers or views. Input preparations (count fields
for the Parser APIs; native tag names) and output projections are **untimed** for
throughput. The native decoder still constructs its bookkeeping fields. No
library is charged for converting its output to binopsy's shape. This slightly
favours encoders that need caller-supplied counts; that cost is deliberately
visible here rather than hidden in an adapter's measured loop.

Checks and error behaviour differ substantially: several encoders truncate or
coerce invalid numeric input rather than validating it. The benchmark supplies
valid data and does not disable binopsy's checks to equalise that difference.
Missing native wire features (multi-bit integers vs boolean bitsets, u8 tags,
u16 counts, scalar f64, counted UTF-8) are explained in skipped cells. Implementing
handwritten custom codecs for those cells would measure the adapter author too.

The corpus fits in cache, output lifetimes are short, and GC remains enabled.
Checksums read selected fields rather than retaining whole results, so JIT
inlining, allocation elision and unused-read elimination can affect rankings.
These are warm repeated-message measurements, not disk/network benchmarks,
malformed-input tests, browser measurements, or end-to-end application claims.
There is no aggregate winner score. Do not claim universal best-in-class speed
from a subset of scenarios, one machine, or overlapping timing distributions.

## A/B comparisons and other modes

Compare with a fresh build of another commit (`$base`):

```sh
baseline=$(mktemp -d /tmp/binopsy-baseline.XXXXXX)
git archive "$base" | tar -x -C "$baseline"
NODE_OPTIONS=--max-old-space-size=1536 timeout 60s npx tsc -p "$baseline/tsconfig.build.json"
NODE_OPTIONS=--max-old-space-size=1536 timeout 60s npm run build
NODE_OPTIONS=--max-old-space-size=1536 timeout 1800s python3 bench/compare/run.py --cpu 6 --rounds 5 --libraries binopsy --a "$baseline/lib" --b "$PWD/lib" --output /tmp/ab.json > /tmp/ab.md
NODE_OPTIONS=--max-old-space-size=1536 timeout 1800s python3 bench/compare/run.py --extras --cpu 6 --rounds 5 --a "$baseline/lib" --b "$PWD/lib" --output /tmp/ab-extras.json > /tmp/ab-extras.md
```

A/B alternates A–B / B–A processes for each cell. Extra workloads exercise Reader,
pick, skip, encodeInto, sizeOf, trace, and async streams (64 KiB, 127-byte, and 7-byte chunks).
They are regression measurements, not cross-library rankings. Their `firstMs`
is an entire first batch and **must not** be interpreted as single-call startup.

## Startup phases

```sh
NODE_OPTIONS=--max-old-space-size=1536 timeout 900s env COUNT=1 RUNS=1 WARMUPS=0 WARM_MS=0 python3 bench/compare/run.py --cpu 6 --rounds 15 --output /tmp/first-use.json > /tmp/first-use.md
NODE_OPTIONS=--max-old-space-size=1536 timeout 300s python3 bench/compare/run.py --cold --cpu 6 --rounds 15 --a "$baseline/lib" --b "$PWD/lib" --output /tmp/cold-phases.json > /tmp/cold-phases.md
```

For phases of two builds, create `$baseline` with the commands above. `--cold` imports only binopsy after preparing fixtures, then
measures definition and the first public operation. A `Function` constructor
proxy marks entry to generated code: **compile/setup** includes generation,
compilation, cache/cursor setup, and the small instrumentation overhead;
**call** includes V8's lazy function compilation and executing the first value.
This measures the actual one-shot decoder without first compiling the separate
Reader decoder. Node process launch and fixture construction are excluded.
Each observation uses a fresh process; no warm-up or repeated first-call average is used.
The `wide128` case is a parser of 128 named u32le fields.

`--extras --modes skip-1,skip-4,skip-16,skip-64` (with `COUNT=16384 RUNS=21
WARM_MS=1000`) measures skipping records with an empty `pick()`: each record has
that many u32 IDs and u16-counted 32-byte strings, whose lengths must be read.
