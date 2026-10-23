import assert from "node:assert/strict";
import {
  array,
  bin,
  bytes,
  lazy,
  literal,
  match,
  sized,
  u8,
  type Codec,
  type Output,
} from "../src/index.ts";
import { bytewise, collect } from "./helpers.ts";

describe("Selection and scope composition", () => {
  it("keeps defaults and computed bit fields through nested picked cases", async () => {
    for (const bitOrder of ["msb", "lsb"] as const) {
      const plain = bin({ bitOrder })
        .bits("a", 3)
        .bits("b", 9)
        .field(
          "len",
          literal(
            sized(
              1,
              lazy(() => u8),
            ),
            2,
          ),
        )
        .field("payload", bytes("len"));
      const computed = plain.computed("b", () => 31);
      const full = bin()
        .u8("n")
        .field("hidden", bytes("n"))
        .u8("tag")
        .merge(
          match("tag")
            .case(0, plain)
            .case(1, computed)
            .otherwise(
              bin()
                .u8("subtag")
                .merge(match("subtag").case(0, computed).otherwise(plain)),
            ),
        )
        .field(
          "check",
          bytes((o) => o.a + o.len),
        );
      for (const tag of [0, 1, 2]) {
        for (const subtag of [0, 1]) {
          const fields = {
            n: 2,
            hidden: Uint8Array.of(98, 99),
            a: 1,
            payload: Uint8Array.of(7, 8),
            check: Uint8Array.of(3, 4, 5),
          };
          const wire = full.encode(
            tag === 0
              ? { ...fields, tag: 0, b: 31 }
              : tag === 1
                ? { ...fields, tag: 1 }
                : subtag === 0
                  ? { ...fields, tag: 2, subtag: 0 }
                  : { ...fields, tag: 2, subtag: 1, b: 31 },
          );
          assert.equal(full.decode(wire).b, 31);
          const group = full.pick("a", "b", "len");
          const outer = bin()
            .u8("n")
            .merge(group)
            .field("tail", bytes("n"))
            .field(
              "after",
              bytes((o) => o.len),
            );
          const input = Uint8Array.of(1, ...wire, 55, 66, 77);
          const decoded = outer.decode(input);
          assert.deepEqual(decoded, {
            n: 1,
            a: 1,
            b: 31,
            len: 2,
            tail: Uint8Array.of(55),
            after: Uint8Array.of(66, 77),
          });
          assert.deepEqual(await collect(outer, bytewise(input)), [decoded]);
          for (const keys of [
            [],
            ["tail"],
            ["after"],
            ["len", "after"],
          ] as const) {
            const picked = outer.pick(...keys);
            const expected: Record<string, unknown> = Object.fromEntries(
              keys.map((k) => [k, decoded[k]]),
            );
            assert.deepEqual(picked.decode(input), expected);
            assert.deepEqual(await collect(picked, bytewise(input)), [
              expected,
            ]);
          }
        }
      }
    }
  });

  it("passes inherited and shadowing locals through arrays, regions and recursion", async () => {
    const item = bin<{ n: number }>()
      .field("before", bytes("n"))
      .u8("n")
      .field("local", bytes("n"))
      .field(
        "child",
        bin<{ n: number }>().field(
          "raw",
          bytes((o) => o.n),
        ),
      );
    type Tree = { n: number; items: Output<typeof item>[]; children: Tree[] };
    const tree: Codec<Tree> = bin()
      .u8("n")
      .field("items", array(sized(u8, item), u8))
      .field(
        "children",
        array(
          lazy(() => tree),
          u8,
        ),
      );
    const value: Tree = {
      n: 1,
      items: [
        {
          before: Uint8Array.of(3),
          n: 2,
          local: Uint8Array.of(4, 5),
          child: { raw: Uint8Array.of(6, 7) },
        },
        {
          before: Uint8Array.of(8),
          n: 0,
          local: new Uint8Array(),
          child: { raw: new Uint8Array() },
        },
      ],
      children: [
        {
          n: 2,
          items: [
            {
              before: Uint8Array.of(9, 10),
              n: 1,
              local: Uint8Array.of(11),
              child: { raw: Uint8Array.of(12) },
            },
          ],
          children: [],
        },
      ],
    };
    const wire = tree.encode(value);
    assert.deepEqual(tree.decode(wire), value);
    assert.deepEqual(await collect(tree, bytewise(wire)), [value]);
    const reused = bin()
      .u8("n")
      .field("single", item)
      .field("many", array(item, 1));
    const input = { n: 1, single: value.items[0], many: [value.items[1]] };
    const encoded = reused.encode(input);
    assert.deepEqual(reused.decode(encoded), input);
    assert.deepEqual(await collect(reused.pick("many"), bytewise(encoded)), [
      { many: input.many },
    ]);
  });
});
