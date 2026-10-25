/** One process per library/scenario/operation, including cold schema construction. */
import assert from "node:assert/strict";

import { create } from "./adapters.mjs";
import { manual } from "./manual.mjs";
import { observe, sample } from "./scenarios.mjs";

/**
 * Projects native bookkeeping fields away, without changing timed results.
 * @param actual Native value.
 * @param expected Canonical value, always a small verification sample.
 * @returns Canonical shape, preserving all requested fields.
 */
function project(actual, expected) {
  if (expected instanceof Uint8Array) return [...actual];
  if (Array.isArray(expected)) {
    return actual.map((v, i) => project(v, expected[i]));
  }
  if (typeof expected === "object" && expected !== null) {
    return Object.fromEntries(
      Object.entries(expected).map(([k, v]) => [k, project(actual[k], v)]),
    );
  }
  return actual;
}

/**
 * Checks all branches and counts on small values, including sliced input buffers.
 * @param library Library name.
 * @param scenario Scenario name.
 */
function verify(library, scenario) {
  const adapter = create(library, scenario, true);
  const reference = manual(scenario);
  for (let i = 0; i < 21; i++) {
    const value = sample(scenario, i, true);
    const bytes = reference.encode(value);
    const padded = Buffer.alloc(bytes.length + 11);
    padded.set(bytes, 7);
    const input = padded.subarray(7, 7 + bytes.length);
    const decoded = adapter.decode(input);
    const result = adapter.output ? adapter.output(decoded) : decoded;
    assert.deepStrictEqual(
      project(result, value),
      project(value, value),
      `${library}/${scenario}: decode sample ${i}`,
    );
    if (adapter.encode !== undefined) {
      const encoded = adapter.encode(
        adapter.input ? adapter.input(value) : value,
      );
      assert.equal(
        encoded.length,
        bytes.length,
        `${library}/${scenario}: byte length`,
      );
      for (let k = 0; k < bytes.length; k++) {
        if (encoded[k] !== bytes[k]) {
          throw new Error(
            `${library}/${scenario}: sample ${i}, byte ${k}: ${encoded[k]} != ${bytes[k]}`,
          );
        }
      }
    }
  }
}

const [library, scenario, operation = "decode"] = process.argv.slice(2);
const reference = manual(scenario);
const first = sample(scenario, 3);
const firstBytes = Buffer.from(reference.encode(first));
const start = performance.now();
const adapter = create(library, scenario);
const unavailable =
  adapter.skip ?? (operation === "encode" ? adapter.encodeSkip : undefined);
if (unavailable === undefined) {
  if (operation === "decode") adapter.decode(firstBytes);
  else adapter.encode(adapter.input ? adapter.input(first) : first);
  const firstMs = performance.now() - start;
  verify(library, scenario);
  const defaultCount =
    scenario === "numeric"
      ? 128
      : ["record", "points", "text"].includes(scenario)
        ? 10_240
        : 98_304;
  const count = Math.min(100_000, Number(process.argv[6] ?? defaultCount));
  const runs = Number(process.argv[7] ?? 9);
  const warmups = Number(process.argv[8] ?? 5);
  const corpusSize = Math.min(count, scenario === "numeric" ? 32 : 1024);
  const values = Array.from({ length: corpusSize }, (_, i) =>
    sample(scenario, i),
  );
  const inputs = values.map((v) => (adapter.input ? adapter.input(v) : v));
  const bytes = values.map((v) => Buffer.from(reference.encode(v)));
  const averageBytes = bytes.reduce((n, b) => n + b.length, 0) / corpusSize;
  let checksum = 0;
  const fn =
    operation === "decode"
      ? () => {
          let sum = 0;
          for (let i = 0; i < count; i++) {
            sum += observe(scenario, adapter.decode(bytes[i % corpusSize]));
          }
          return sum;
        }
      : () => {
          let sum = 0;
          for (let i = 0; i < count; i++) {
            const b = adapter.encode(inputs[i % corpusSize]);
            sum += b.length + b[0] + b.at(-1);
          }
          return sum;
        };
  const warmStart = performance.now();
  for (
    let r = 0;
    r < warmups ||
    performance.now() - warmStart < Number(process.argv[9] ?? 250);
    r++
  ) {
    checksum += fn();
  }
  const times = [];
  for (let r = 0; r < runs; r++) {
    const t = performance.now();
    checksum += fn();
    times.push(performance.now() - t);
  }
  if (!Number.isFinite(checksum)) {
    throw new TypeError("Invalid observable checksum");
  }
  times.sort((a, b) => a - b);
  const ms = times[Math.floor(times.length / 2)];
  console.log(
    JSON.stringify({
      library,
      scenario,
      operation,
      count,
      bytes: averageBytes,
      firstMs,
      ms,
      ops: (count * 1000) / ms,
      mbps: (count * averageBytes) / ms / 1000,
      minMs: times[0],
      maxMs: times.at(-1),
      checksum,
    }),
  );
} else {
  console.log(
    JSON.stringify({ library, scenario, operation, skip: unavailable }),
  );
}
