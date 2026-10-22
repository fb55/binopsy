import assert from "node:assert/strict";
import { Bin } from "../src/index.ts";

/** `true` if `A` and `B` are assignable to each other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const Sample = Bin.start()
  .uint8("count")
  .array("items", { type: "int16le", length: "count" })
  .uint64le("big")
  .string("name", { length: 2 })
  .nest("inner", { type: Bin.start().floatle("x") })
  .uint8("flag", { formatter: (v) => v !== 0, deformatter: (v) => (v ? 1 : 0) })
  .choice("value", {
    tag: "count",
    choices: { 1: "uint8", 2: Bin.start().uint8("y") },
    defaultChoice: "int64le",
  })
  .array("byId", { type: Bin.start().uint8("id"), length: 1, key: "id" })
  .array("ids", {
    type: Bin.start().uint8("id"),
    length: 1,
    key: "id",
    formatter: (byId) => Object.keys(byId),
    deformatter: (ids) =>
      Object.fromEntries(ids.map((id) => [id, { id: +id }])),
  });

describe("Types", () => {
  it("infer parsed values", () => {
    const input = Buffer.from(
      "01 0100 0200000000000000 6162 00000000 01 07 05 06".replace(/ /g, ""),
      "hex",
    );
    const expected: {
      count: number;
      items: number[];
      big: bigint;
      name: string;
      inner: { x: number };
      flag: boolean;
      value: number | { y: number } | bigint;
      byId: Record<string, { id: number }>;
      ids: string[];
    } = {
      count: 1,
      items: [1],
      big: 2n,
      name: "ab",
      inner: { x: 0 },
      flag: true,
      value: 7,
      byId: { 5: { id: 5 } },
      ids: ["6"],
    };
    const value = Sample.parse(input);
    const same: Same<typeof value, typeof expected> = true;
    assert.deepEqual(value, expected);
    const { result } = Sample.parseFrom(input, 0, { fields: ["name"] });
    const picked: Same<typeof result, { name: string }> = true;
    assert.ok(same && picked);
    assert.deepEqual(result, { count: 1, name: "ab" });
  });
});

/** Compile-time checks only (run by `npm run lint`). */
export function invalidDefinitions(): void {
  // @ts-expect-error A string needs a length or zeroTerminated.
  Bin.start().string("a", {});
  // @ts-expect-error A formatter needs a deformatter.
  Bin.start().uint8("a", { formatter: (v) => v * 2 });
  // @ts-expect-error Asserts check values of the field's type.
  Bin.start().uint8("a", { assert: "x" });
  // @ts-expect-error Lengths refer to fields parsed before.
  Bin.start().buffer("a", { length: "n" });
  // @ts-expect-error Tags refer to fields parsed before.
  Bin.start().choice("a", { tag: "t", choices: { 0: "uint8" } });
  // @ts-expect-error Only fields of the parser can be selected.
  Sample.parseFrom(Buffer.alloc(0), 0, { fields: ["nope"] });
  // @ts-expect-error Only parsers can be flattened.
  Bin.start().nest("a", { type: "uint8", flatten: true });
  // @ts-expect-error Serialized values need all fields.
  Sample.serialize({ count: 0 });
}
