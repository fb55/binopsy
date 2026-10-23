import assert from "node:assert/strict";
import * as b from "../src/index.ts";
import { collect, bytewise } from "./helpers.ts";
// Runtime-generated schemas deliberately erase their changing field types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dynamic = any;
type Fixture = {
  codec: b.Codec<unknown, Dynamic>;
  input: unknown;
  output: unknown;
  description: string;
};

describe("Seeded differential schemas", () => {
  it("round-trips, resumes, consumes and projects bounded composed records", async () => {
    const seed = 0x51ec7103;
    let state = seed;
    const rnd = (n: number) => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) % n;
    };
    const choose = <T>(a: readonly T[]): T => a[rnd(a.length)];
    const bytes = (n: number) => Uint8Array.from({ length: n }, () => rnd(256));
    const mk = <I>(
      codec: b.Codec<unknown, I>,
      input: I,
      output: unknown = input,
      description = "leaf",
    ): Fixture => ({
      codec,
      input,
      output,
      description,
    });
    const primitives = [
      "u8",
      "i8",
      "u16le",
      "u16be",
      "i16le",
      "i16be",
      "u32le",
      "u32be",
      "i32le",
      "i32be",
      "u64le",
      "u64be",
      "i64le",
      "i64be",
      "f32le",
      "f32be",
      "f64le",
      "f64be",
    ] as const;
    function leaf(): Fixture {
      const kind = rnd(10);
      const n = rnd(5);
      if (kind < 3) {
        const name = choose(primitives);
        const v =
          name.includes("64") && !name.startsWith("f")
            ? BigInt(n)
            : name.startsWith("f")
              ? n / 4
              : n;
        return mk(b[name] as b.Codec<unknown, number | bigint>, v, v, name);
      }
      if (kind === 3) return mk(b.bytes(n), bytes(n));
      if (kind === 4) return mk(b.bytes(b.u8), bytes(n));
      if (kind === 5) return mk(b.literal(b.u8, n), undefined, n, "literal");
      if (kind === 6) return mk(b.string(b.u8), "é".repeat(n));
      if (kind === 7)
        return mk(b.string({ terminator: 0, max: 8 }), "a".repeat(n));
      if (kind === 8)
        return mk(b.string(b.u8, { encoding: "utf16le" }), "é".repeat(n));
      return mk(
        b.custom({
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
          b.array(codec, b.u8),
          Array(n).fill(input),
          Array(n).fill(output),
          `array(${child.description})`,
        );
      }
      if (kind === 4)
        return mk(
          b.sized(b.u8, codec),
          input,
          output,
          `sized(${child.description})`,
        );
      if (kind === 5)
        return mk(
          b.lazy(() => codec),
          input,
          output,
          `lazy(${child.description})`,
        );
      if (kind === 6) {
        const v = rnd(2) || input === undefined ? null : input;
        return mk(
          b.optional(b.u8, codec),
          v,
          v === null ? null : output,
          `optional(${child.description})`,
        );
      }
      if (kind === 7)
        return mk(
          b.map(codec, { decode: (x) => ({ x }), encode: (x) => x.x }),
          { x: input },
          { x: output },
          `map(${child.description})`,
        );
      return mk(
        b.refine(b.sized(b.u8, codec), () => true),
        input,
        output,
        `refine(${child.description})`,
      );
    }
    function struct(depth = 0) {
      let codec: Dynamic = b
        .bin({ bitOrder: choose(["msb", "lsb"]) })
        .field("header", b.literal(b.u8, 7));
      const input: Record<string, unknown> = {};
      const output: Record<string, unknown> = { header: 7 };
      const desc: string[] = [];
      const n = 1 + rnd(4);
      for (let i = 0; i < n; i++) {
        const name = `f${i}`;
        const kind = rnd(4);
        if (kind === 0) {
          const width = 1 + rnd(32);
          const value = rnd(2 ** Math.min(width, 12));
          codec = codec.bits(name, width);
          input[name] = output[name] = value;
          desc.push(`bits${width}`);
        } else if (kind === 1 && depth < 2) {
          const ca = struct(depth + 1);
          const cb = struct(depth + 1);
          const tag = rnd(2);
          const selected = tag ? cb : ca;
          // Wrap a branch field to keep names distinct across successive matches.
          const branch = (x: Fixture) => b.bin().field(name, x.codec);
          codec = codec
            .field(`tag${i}`, b.literal(b.u8, tag))
            .merge(b.match(`tag${i}`).case(0, branch(ca)).case(1, branch(cb)));
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
        if (key) {
          const v = input[key];
          codec = codec.computed(key, () => v);
          delete input[key];
        }
      }
      return {
        ...mk(codec, input, output, `struct(${desc.join(",")})`),
        codec: codec as b.Struct<
          Record<string, unknown>,
          Record<string, unknown>
        >,
        input,
      };
    }
    function chunks(wire: Uint8Array) {
      const chunks = [];
      for (let i = 0; i < wire.length;) {
        const n = 1 + rnd(8);
        chunks.push(wire.subarray(i, i + n));
        i += n;
        if (rnd(4) === 0) chunks.push(new Uint8Array());
      }
      return chunks;
    }

    for (let i = 0; i < 96; i++) {
      const c = struct();
      try {
        const wire = c.codec.encode(Object.freeze(c.input));
        assert(wire.length < 4096);
        if (Number.isFinite(c.codec.size))
          assert.equal(c.codec.size, wire.length);
        const reader = new b.Reader(wire);
        const decoded = reader.read(c.codec);
        assert.deepEqual(decoded, c.output);
        assert.equal(reader.offset, wire.length);
        assert.deepEqual(await collect(c.codec, bytewise(wire)), [decoded]);
        assert.deepEqual(await collect(c.codec, chunks(wire)), [decoded]);
        for (const names of [[], Object.keys(decoded).filter(() => rnd(2))]) {
          const picked = c.codec.pick(...names);
          const projected = Object.fromEntries(
            names.map((k) => [k, decoded[k]]),
          );
          const r = new b.Reader(wire);
          assert.deepEqual(r.read(picked), projected);
          assert.equal(r.offset, wire.length);
          assert.deepEqual(await collect(picked, bytewise(wire)), [projected]);
          assert.deepEqual(await collect(picked, chunks(wire)), [projected]);
        }
      } catch (cause) {
        throw new Error(`seed ${seed}, iteration ${i}: ${c.description}`, {
          cause,
        });
      }
    }
  });
});
