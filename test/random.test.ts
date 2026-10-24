/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access -- Schemas generated at run time are `Dynamic`. */
import { describe, expect, it } from "vitest";

import {
  array,
  bin,
  bytes,
  custom,
  f32be,
  f32le,
  f64be,
  f64le,
  i16be,
  i16le,
  i32be,
  i32le,
  i64be,
  i64le,
  i8,
  lazy,
  literal,
  map,
  match,
  optional,
  Reader,
  refine,
  sized,
  string,
  u16be,
  u16le,
  u32be,
  u32le,
  u64be,
  u64le,
  u8,
  type Codec,
  type Struct,
} from "../src/index.ts";
import { collect, bytewise } from "./helpers.ts";
// Runtime-generated schemas deliberately erase their changing field types.
// oxlint-disable-next-line typescript/no-explicit-any
type Dynamic = any;
interface Fixture {
  codec: Codec<unknown, Dynamic>;
  input: unknown;
  output: unknown;
  description: string;
}

const mk = <I>(
  codec: Codec<unknown, I>,
  input: I,
  output: unknown = input,
  description = "leaf",
): Fixture => ({
  codec,
  input,
  output,
  description,
});

describe("Seeded random schemas", () => {
  it("decode what they encode, from any chunks, also when picked", async () => {
    const seed = 0x51ec7103;
    let state = seed;
    const rnd = (n: number) => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) % n;
    };
    const choose = <T>(a: readonly T[]): T => a[rnd(a.length)];
    const randomBytes = (n: number) =>
      Uint8Array.from({ length: n }, () => rnd(256));
    const numbers = {
      u8,
      i8,
      u16le,
      u16be,
      i16le,
      i16be,
      u32le,
      u32be,
      i32le,
      i32be,
      u64le,
      u64be,
      i64le,
      i64be,
      f32le,
      f32be,
      f64le,
      f64be,
    };
    function leaf(): Fixture {
      const kind = rnd(10);
      const n = rnd(5);
      if (kind < 3) {
        const name = choose(Object.keys(numbers) as (keyof typeof numbers)[]);
        const v =
          name.includes("64") && !name.startsWith("f")
            ? BigInt(n)
            : name.startsWith("f")
              ? n / 4
              : n;
        return mk(numbers[name] as Codec<unknown, number | bigint>, v, v, name);
      }
      if (kind === 3) return mk(bytes(n), randomBytes(n));
      if (kind === 4) return mk(bytes(u8), randomBytes(n));
      if (kind === 5) return mk(literal(u8, n), undefined, n, "literal");
      if (kind === 6) return mk(string(u8), "é".repeat(n));
      if (kind === 7) {
        return mk(string({ terminator: 0, max: 8 }), "a".repeat(n));
      }
      if (kind === 8) {
        return mk(string(u8, { encoding: "utf16le" }), "é".repeat(n));
      }
      return mk(
        custom({
          decode: (x) =>
            x.length < 2
              ? undefined
              : { value: x[0] + 256 * x[1], bytesRead: 2 },
          encode: (x: number) => Uint8Array.of(x & 255, x >> 8),
        }),
        n,
        n,
        "custom",
      );
    }
    function gen(depth = 0): Fixture {
      if (depth >= 3 || rnd(4) === 0) return leaf();
      const kind = rnd(9);
      if (kind < 3) return struct(depth);
      const child = gen(depth + 1);
      const { codec, input, output } = child;
      if (kind === 3) {
        const n = rnd(4);
        return mk(
          array(codec, u8),
          Array.from({ length: n }, () => input),
          Array.from({ length: n }, () => output),
          `array(${child.description})`,
        );
      }
      if (kind === 4) {
        return mk(
          sized(u8, codec),
          input,
          output,
          `sized(${child.description})`,
        );
      }
      if (kind === 5) {
        return mk(
          lazy(() => codec),
          input,
          output,
          `lazy(${child.description})`,
        );
      }
      if (kind === 6) {
        const v = rnd(2) || input === undefined ? null : input;
        return mk(
          optional(u8, codec),
          v,
          v === null ? null : output,
          `optional(${child.description})`,
        );
      }
      if (kind === 7) {
        return mk(
          map(codec, { decode: (x) => ({ x }), encode: (x) => x.x }),
          { x: input },
          { x: output },
          `map(${child.description})`,
        );
      }
      return mk(
        refine(sized(u8, codec), () => true),
        input,
        output,
        `refine(${child.description})`,
      );
    }
    function struct(depth = 0) {
      let codec: Dynamic = bin({ bitOrder: choose(["msb", "lsb"]) }).field(
        "header",
        literal(u8, 7),
      );
      let input: Record<string, unknown> = {};
      const output: Record<string, unknown> = { header: 7 };
      const desc: string[] = [];
      const n = 1 + rnd(4);
      for (let i = 0; i < n; i++) {
        const name = `f${i}`;
        const kind = rnd(4);
        if (kind === 0) {
          const width = 1 + rnd(53);
          // Random top bits (all of them, up to 32).
          const value =
            rnd(2 ** Math.min(width, 32)) * 2 ** Math.max(width - 32, 0);
          codec = codec.bits(name, width);
          input[name] = value;
          output[name] = value;
          desc.push(`bits${width}`);
        } else if (kind === 1 && depth < 2) {
          const ca = struct(depth + 1);
          const cb = struct(depth + 1);
          const tag = rnd(2);
          const selected = tag ? cb : ca;
          // Wrap a branch field to keep names distinct across successive matches.
          const branch = (x: Fixture) => bin().field(name, x.codec);
          codec = codec
            .field(`tag${i}`, literal(u8, tag))
            .merge(match(`tag${i}`).case(0, branch(ca)).case(1, branch(cb)));
          output[`tag${i}`] = tag;
          input[name] = selected.input;
          output[name] = selected.output;
          desc.push(`match(${selected.description})`);
        } else {
          const c = gen(depth + 1);
          codec = codec.field(name, c.codec);
          input[name] = c.input;
          output[name] = c.output;
          desc.push(c.description);
        }
      }
      if (rnd(4) === 0) {
        const key = Object.keys(input).find((k) => input[k] !== undefined);
        if (key !== undefined) {
          const { [key]: v, ...rest } = input;
          codec = codec.computed(key, () => v);
          input = rest;
        }
      }
      return {
        ...mk(codec, input, output, `struct(${desc.join(",")})`),
        codec: codec as Struct<
          Record<string, unknown>,
          Record<string, unknown>
        >,
        input,
      };
    }
    function chunks(wire: Uint8Array) {
      const parts = [];
      for (let i = 0; i < wire.length;) {
        const n = 1 + rnd(8);
        parts.push(wire.subarray(i, i + n));
        i += n;
        if (rnd(4) === 0) parts.push(new Uint8Array());
      }
      return parts;
    }

    for (let i = 0; i < 96; i++) {
      const c = struct();
      try {
        const wire = c.codec.encode(Object.freeze(c.input));
        expect(wire.length).toBeLessThan(4096);
        // A fixed size is that of every value.
        expect(Number.isFinite(c.codec.size) ? c.codec.size : wire.length).toBe(
          wire.length,
        );
        const reader = new Reader(wire);
        const decoded = reader.read(c.codec);
        expect(decoded).toStrictEqual(c.output);
        expect(reader.offset).toBe(wire.length);
        await expect(collect(c.codec, bytewise(wire))).resolves.toStrictEqual([
          decoded,
        ]);
        await expect(collect(c.codec, chunks(wire))).resolves.toStrictEqual([
          decoded,
        ]);
        for (const names of [[], Object.keys(decoded).filter(() => rnd(2))]) {
          const picked = c.codec.pick(...names);
          const projected = Object.fromEntries(
            names.map((k) => [k, decoded[k]]),
          );
          const r = new Reader(wire);
          expect(r.read(picked)).toStrictEqual(projected);
          expect(r.offset).toBe(wire.length);
          await expect(collect(picked, bytewise(wire))).resolves.toStrictEqual([
            projected,
          ]);
          await expect(collect(picked, chunks(wire))).resolves.toStrictEqual([
            projected,
          ]);
        }
      } catch (cause) {
        throw new Error(`seed ${seed}, iteration ${i}: ${c.description}`, {
          cause,
        });
      }
    }
  });
});
