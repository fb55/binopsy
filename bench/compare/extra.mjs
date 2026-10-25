/// <reference types="node" />
/** Binopsy-only regression workloads for cursor, stream, selection, and sizing paths. */
import { binopsy, binopsySchema } from "./binopsy.mjs";
import { manual } from "./manual.mjs";
import { sample } from "./scenarios.mjs";

const [, name] = process.argv.slice(2);
const count = Math.min(100_000, Number(process.argv[6] ?? 10_240));
const runs = Number(process.argv[7] ?? 9);
const warmups = Number(process.argv[8] ?? 5);
const width = name.startsWith("skip-") ? Number(name.slice(5)) : 0;
let codec = binopsySchema("record");
let values;
let parts;
if (width) {
  codec = binopsy.bin();
  const value = {};
  for (let i = 0; i < width; i++) {
    codec = codec
      .u32le(`id${i}`)
      .field(`text${i}`, binopsy.string(binopsy.u16le));
    value[`id${i}`] = i;
    value[`text${i}`] = "a".repeat(32);
  }
  const part = Uint8Array.from(codec.encode(value));
  values = Array.from({ length: count }, () => value);
  parts = Array.from({ length: count }, () => part);
} else {
  values = Array.from({ length: count }, (_, i) => sample("record", i));
  parts = values.map((v) => manual("record").encode(v));
}
const bytes = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
for (let i = 0, o = 0; i < count; o += parts[i++].length) {
  bytes.set(parts[i], o);
}
const selected =
  name === "pick"
    ? codec.pick("name", "uniqueId")
    : name === "skip" || width
      ? codec.pick()
      : codec;
const output = new Uint8Array(bytes.length);
const mode = width ? "skip" : name;

/**
 * Yields chunks that frequently split fields and records.
 * @yields Input chunks.
 */
function* chunks() {
  const chunk =
    name === "stream-tiny" ? 7 : name === "stream-small" ? 127 : 65_536;
  for (let i = 0; i < bytes.length; i += chunk) {
    yield bytes.subarray(i, i + chunk);
  }
}

/**
 * Runs one complete workload and consumes its results.
 * @returns Observable checksum.
 */
async function run() {
  let sum = 0;
  switch (mode) {
    case "reader":
    case "pick":
    case "skip": {
      const reader = new binopsy.Reader(bytes);
      while (reader.done === false) {
        reader.read(selected);
        sum++;
      }
      if (sum !== count) throw new Error("Wrong record count");
      break;
    }
    case "trace": {
      for (const part of parts) sum += binopsy.trace(codec, part).length;
      break;
    }
    case "encodeInto": {
      for (const value of values) sum = codec.encodeInto(value, output, sum);
      if (sum !== bytes.length) throw new Error("Wrong encoded size");
      break;
    }
    case "sizeOf": {
      for (const value of values) sum += codec.sizeOf(value);
      if (sum !== bytes.length) throw new Error("Wrong computed size");
      break;
    }
    case "stream":
    case "stream-small":
    case "stream-tiny": {
      for await (const value of binopsy.decodeStream(codec, chunks())) {
        sum += value.uniqueId;
      }
      break;
    }
    default: {
      throw new Error(`Unknown extra workload ${name}`);
    }
  }
  return sum;
}

const cold = performance.now();
await run();
const firstMs = performance.now() - cold;
let checksum = 0;
const warmStart = performance.now();
for (
  let i = 0;
  i < warmups || performance.now() - warmStart < Number(process.argv[9] ?? 250);
  i++
) {
  checksum += await run();
}
const times = [];
for (let i = 0; i < runs; i++) {
  const start = performance.now();
  checksum += await run();
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
const ms = times[Math.floor(times.length / 2)];
console.log(
  JSON.stringify({
    library: "binopsy",
    scenario: name,
    operation: "extra",
    count,
    firstMs,
    ms,
    ops: (count * 1000) / ms,
    mbps: bytes.length / ms / 1000,
    minMs: times[0],
    maxMs: times.at(-1),
    checksum,
  }),
);
