import assert from "node:assert/strict";

globalThis.Buffer = undefined;
const { string, u8 } = await import("../../src/index.ts");
const bytes = (...v) => Uint8Array.from(v);
for (const [encoding, wire, value] of [
  ["utf8", bytes(239, 187, 191, 65), "\uFEFFA"],
  ["utf8", bytes(195, 40), "\uFFFD("],
  ["utf16le", bytes(255, 254, 0, 216), "\uFEFF\uD800"],
  ["latin1", bytes(128, 159), "\u0080\u009F"],
  ["ascii", bytes(193, 255), "A\u007F"],
]) {
  assert.equal(string(wire.length, { encoding }).decode(wire), value);
}
for (const encoding of ["utf8", "utf16le", "latin1", "ascii"]) {
  const unit = encoding === "utf16le" ? 2 : 1;
  for (const codec of [
    string(2 * unit, { encoding }),
    string(4 * unit, { encoding, padRight: 32 }),
    string(u8, { encoding, terminator: 0 }),
    string(Infinity, { encoding, terminator: 0 }),
    string({ encoding, terminator: 0, max: 4 * unit }),
  ]) {
    assert.equal(codec.decode(codec.encode("AB")), "AB");
  }
}
assert.throws(() => string(1, { encoding: "ascii" }).encode("\u0080"));
assert.throws(() => string(1, { encoding: "latin1" }).encode("\u0100"));
console.log("fallback matrix passed");
