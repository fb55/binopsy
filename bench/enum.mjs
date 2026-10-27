/**
 * One fresh process per variant and operation; run each pinned, interleaved,
 * for five rounds. Build first. Example:
 * NODE_OPTIONS=--max-old-space-size=1536 timeout 30s taskset -c 6 node bench/enum.mjs dense decode
 */
import assert from "node:assert/strict";

import { enumOf, u8 } from "../lib/index.js";

const [variant = "dense", operation = "decode"] = process.argv.slice(2);
const names = ["data", "ack", "error", "reserved"];
const sparse = { 1: "data", 2: "ack", 63: "error", 255: "reserved" };
const members = { Data: 1, Ack: 2, Error: 63, Reserved: 255 };
const variants = {
  bare: () => u8,
  dense: () => enumOf(u8, names, enumOf.reject),
  sparse: () => enumOf(u8, sparse, enumOf.reject),
  members: () => enumOf(u8, members, enumOf.reject),
};
assert.ok(
  Object.hasOwn(variants, variant),
  "expected bare, dense, sparse, or members",
);
assert.ok(operation === "decode" || operation === "encode");
const codec = variants[variant]();
const raw =
  variant === "bare" || variant === "dense" ? [0, 1, 2, 3] : [1, 2, 63, 255];
const values = variant === "bare" || variant === "members" ? raw : names;
// Shared backing storage avoids measuring a new DataView per decode.
const wire = Uint8Array.from(raw);
const bytes = raw.map((_, i) => wire.subarray(i, i + 1));
for (let i = 0; i < raw.length; i++) {
  assert.equal(codec.decode(bytes[i]), values[i]);
  const encoded = codec.encode(values[i]);
  assert.equal(encoded.length, 1);
  assert.equal(encoded[0], raw[i]);
}
const count = 65_536;
const batch =
  operation === "decode"
    ? () => {
        let sum = 0;
        for (let i = 0; i < count; i++) {
          const j = i & 3;
          sum += Number(codec.decode(bytes[j]) === values[j]);
        }
        return sum;
      }
    : () => {
        let sum = 0;
        for (let i = 0; i < count; i++) sum += codec.encode(values[i & 3])[0];
        return sum;
      };
let checksum = 0;
const warming = performance.now();
while (performance.now() - warming < 250) checksum += batch();
const nanos = [];
for (let i = 0; i < 15; i++) {
  const start = performance.now();
  checksum += batch();
  nanos.push(((performance.now() - start) * 1e6) / count);
}
nanos.sort((a, b) => a - b);
assert.ok(checksum > 0);
console.log(
  JSON.stringify({
    variant,
    operation,
    ns: nanos[7],
    minNs: nanos[0],
    maxNs: nanos[14],
    checksum,
  }),
);
